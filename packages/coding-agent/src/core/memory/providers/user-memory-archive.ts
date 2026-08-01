import { createHash } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";
import { okfMemoryDir } from "../../agent-paths.ts";
import { formatOkfMemoryDocument, parseOkfMemoryDocument } from "../../context/okf-memory.ts";
import { hasInvisibleUnicode, scanContextFileThreats } from "../../resource-loader.ts";

const ARCHIVE_DIR_NAME = "user-preferences";
const ARCHIVE_INDEX_NAME = "index.okf.md";
const SHARD_NAME_RE = /^user-preferences-([a-f0-9]{16})\.okf\.md$/;
const MAX_SHARD_BODY_CHARS = 64_000;

export const USER_ARCHIVE_POINTER =
	"# User profile\n\nArchived preferences: [User preference archive](okf-memory/user-preferences/index.okf.md).\n";

export type UserMemoryAction =
	| { action: "add"; content: string }
	| { action: "replace"; oldContent: string; content: string }
	| { action: "remove"; oldContent: string };

export interface UserMemoryMutationResult {
	userContent: string;
	archiveChanged: boolean;
}

interface UserPreferenceShard {
	path: string;
	name: string;
	body: string;
	title: string;
	timestamp?: string;
}

function appendLine(existing: string, content: string): string {
	return existing.endsWith("\n") || existing === "" ? `${existing}${content}\n` : `${existing}\n${content}\n`;
}

function activeUserContent(content: string): { active: string; managed: boolean } {
	if (!content.startsWith(USER_ARCHIVE_POINTER)) return { active: content, managed: false };
	return { active: content.slice(USER_ARCHIVE_POINTER.length), managed: true };
}

function safeDescription(body: string): string {
	const line = body
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0 && !candidate.startsWith("#"));
	const normalized = (line ?? "Archived user preferences")
		.replace(/^[-*+]\s+/, "")
		.replace(/[<>[\]()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.slice(0, 220) || "Archived user preferences";
}

function splitArchiveBody(body: string): string[] {
	const chunks: string[] = [];
	let remaining = body;
	while (remaining.length > MAX_SHARD_BODY_CHARS) {
		const newline = remaining.lastIndexOf("\n", MAX_SHARD_BODY_CHARS);
		const end = newline >= Math.floor(MAX_SHARD_BODY_CHARS / 2) ? newline : MAX_SHARD_BODY_CHARS;
		chunks.push(remaining.slice(0, end));
		remaining = remaining.slice(end + (remaining[end] === "\n" ? 1 : 0));
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const temporaryPath = `${path}.tmp-${process.pid}`;
	await fs.writeFile(temporaryPath, content, "utf8");
	await fs.rename(temporaryPath, path);
}

/**
 * Owns USER.md overflow migration and archived preference mutation. USER.md stays the bounded hot
 * index; canonical overflow content lives in valid OKF documents discovered by the existing memory
 * provider. The caller owns the USER.md lock, so every multi-file operation is serialized through
 * the same mandatory write path.
 */
export class UserMemoryArchive {
	private readonly archiveDir: string;
	private readonly indexPath: string;

	constructor(agentDir: string) {
		this.archiveDir = join(okfMemoryDir(agentDir), ARCHIVE_DIR_NAME);
		this.indexPath = join(this.archiveDir, ARCHIVE_INDEX_NAME);
	}

	async apply(
		currentUser: string,
		action: UserMemoryAction,
		budget: number,
		supersedeNearDuplicate: (existing: string, content: string) => string | null,
	): Promise<UserMemoryMutationResult> {
		// Validate the generated storage boundary before any shard discovery. Otherwise a symlinked
		// archive directory could redirect a replace/remove before the later index rebuild rejected it.
		await this.ensureArchiveDir();
		const split = activeUserContent(currentUser);
		let active = split.active;
		let archiveChanged = false;

		if (action.action === "add") {
			const supersededActive = supersedeNearDuplicate(active, action.content);
			if (supersededActive !== null) {
				active = supersededActive;
			} else if (await this.supersedeArchivedFact(action.content, supersedeNearDuplicate)) {
				archiveChanged = true;
			} else {
				active = appendLine(active, action.content);
			}
		} else {
			const replacement = action.action === "replace" ? action.content : "";
			if (active.includes(action.oldContent)) {
				active = active.replace(action.oldContent, replacement);
			} else if (await this.replaceArchivedFact(action.oldContent, replacement)) {
				archiveChanged = true;
			} else {
				throw new Error(`The content to ${action.action} ('oldContent') was not found in the file or its archive.`);
			}
		}

		if (archiveChanged) {
			await this.rebuildIndex();
			return { userContent: currentUser, archiveChanged: true };
		}

		const hasArchive = split.managed || (await this.hasArchivedShards());
		const candidate = `${hasArchive ? USER_ARCHIVE_POINTER : ""}${active}`;
		if (candidate.length <= budget) {
			if (hasArchive) await this.rebuildIndex();
			return { userContent: candidate, archiveChanged: false };
		}

		const body = active.trim();
		if (!body) throw new Error("USER.md index exceeds its character budget without archivable content.");
		this.validateArchiveContent(body);
		await this.archiveBody(body);
		await this.rebuildIndex();
		return { userContent: USER_ARCHIVE_POINTER, archiveChanged: true };
	}

	private validateArchiveContent(body: string): void {
		if (hasInvisibleUnicode(body) || scanContextFileThreats(body, "strict").length > 0) {
			throw new Error("USER.md contains unsafe content and cannot be migrated into durable memory shards.");
		}
	}

	private async ensureArchiveDir(): Promise<void> {
		await fs.mkdir(this.archiveDir, { recursive: true });
		const stat = await fs.lstat(this.archiveDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("User memory archive path must be a real directory, not a symlink.");
		}
	}

	private async shardFiles(): Promise<UserPreferenceShard[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(this.archiveDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return [];
		}
		const shards: UserPreferenceShard[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !SHARD_NAME_RE.test(entry.name)) continue;
			const path = join(this.archiveDir, entry.name);
			let content: string;
			try {
				content = await fs.readFile(path, "utf8");
			} catch {
				continue;
			}
			const parsed = parseOkfMemoryDocument(content, { uri: `okf:${ARCHIVE_DIR_NAME}/${entry.name}` });
			if (parsed.diagnostics.length > 0 || parsed.item?.kind !== "user_preference") continue;
			shards.push({
				path,
				name: entry.name,
				body: parsed.body,
				title: parsed.item.title ?? `User preference shard ${entry.name.slice(17, 33)}`,
				timestamp: parsed.item.timestamp,
			});
		}
		return shards.sort((left, right) => left.name.localeCompare(right.name));
	}

	private async hasArchivedShards(): Promise<boolean> {
		return (await this.shardFiles()).length > 0;
	}

	private async archiveBody(body: string): Promise<void> {
		await this.ensureArchiveDir();
		const migrationDigest = createHash("sha256").update(body).digest("hex");
		const chunks = splitArchiveBody(body);
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			if (chunk === undefined) continue;
			const identity = `${migrationDigest}\0${index}`;
			await this.writeNewShard(chunk, identity);
		}
	}

	private async writeNewShard(body: string, identity: string): Promise<void> {
		const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
		const name = `user-preferences-${hash}.okf.md`;
		const path = join(this.archiveDir, name);
		try {
			const existing = await fs.readFile(path, "utf8");
			const parsed = parseOkfMemoryDocument(existing);
			if (parsed.diagnostics.length === 0 && parsed.body.trim() === body) return;
			throw new Error(`User memory shard hash collision at ${name}.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const timestamp = new Date().toISOString();
		await atomicWrite(
			path,
			formatOkfMemoryDocument({
				type: "User Preference",
				title: `User preference shard ${hash}`,
				description: safeDescription(body),
				scope: "user",
				body,
				tags: ["user-preferences", "archived"],
				timestamp,
			}),
		);
	}

	private async writeShard(shard: UserPreferenceShard, body: string): Promise<void> {
		if (!body.trim()) {
			await fs.unlink(shard.path);
			return;
		}
		this.validateArchiveContent(body);
		const chunks = splitArchiveBody(body);
		const first = chunks[0];
		if (first === undefined) return;
		await atomicWrite(
			shard.path,
			formatOkfMemoryDocument({
				type: "User Preference",
				title: shard.title,
				description: safeDescription(first),
				scope: "user",
				body: first,
				tags: ["user-preferences", "archived"],
				timestamp: shard.timestamp,
			}),
		);
		const mutationDigest = createHash("sha256").update(`${shard.name}\0${body}`).digest("hex");
		for (let index = 1; index < chunks.length; index++) {
			const chunk = chunks[index];
			if (chunk !== undefined) await this.writeNewShard(chunk, `${mutationDigest}\0${index}`);
		}
	}

	private async supersedeArchivedFact(
		content: string,
		supersedeNearDuplicate: (existing: string, content: string) => string | null,
	): Promise<boolean> {
		for (const shard of await this.shardFiles()) {
			const superseded = supersedeNearDuplicate(shard.body, content);
			if (superseded === null) continue;
			await this.writeShard(shard, superseded);
			return true;
		}
		return false;
	}

	private async replaceArchivedFact(oldContent: string, replacement: string): Promise<boolean> {
		for (const shard of await this.shardFiles()) {
			if (!shard.body.includes(oldContent)) continue;
			await this.writeShard(shard, shard.body.replace(oldContent, replacement));
			return true;
		}
		return false;
	}

	private async rebuildIndex(): Promise<void> {
		await this.ensureArchiveDir();
		const shards = await this.shardFiles();
		const body =
			shards.length === 0
				? "No archived user preference shards."
				: shards.map((shard) => `- [${shard.name}](./${shard.name}): ${safeDescription(shard.body)}`).join("\n");
		await atomicWrite(
			this.indexPath,
			formatOkfMemoryDocument({
				type: "User Preference",
				title: "User preference archive index",
				description: "Index of archived durable user preference shards.",
				scope: "user",
				body,
				tags: ["user-preferences", "index"],
			}),
		);
	}
}
