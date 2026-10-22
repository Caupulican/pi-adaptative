import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { okfMemoryDir } from "../../agent-paths.ts";
import { formatOkfMemoryDocument, parseOkfMemoryDocument } from "../../context/okf-memory.ts";
import { hasInvisibleUnicode, scanContextFileThreats } from "../../security/context-threat-scanner.ts";
import { isMissingFileError, writeFileAtomic } from "../../util/atomic-file.ts";
import { readBoundedTextFile } from "../../util/bounded-file.ts";
import { MemoryMutationAdmission } from "../memory-mutation-admission.ts";
import { collectUserPreferenceEntries } from "../user-preference-metadata.ts";

const ARCHIVE_DIR_NAME = "user-preferences";
const ARCHIVE_INDEX_NAME = "index.okf.md";
const SHARD_NAME_RE = /^user-preferences-([a-f0-9]{16})\.okf\.md$/;
const MAX_SHARD_BODY_CHARS = 64_000;
// Scan bounds are separate from the small prompt projection. Reaching one refuses mutation;
// it never turns an incomplete view into authoritative absence of a preference.
const MAX_ARCHIVE_SHARDS = 1_024;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 2 * MAX_ARCHIVE_SHARDS + 64;
const MAX_ARCHIVE_SHARD_BYTES = 1_048_576;
const MAX_ARCHIVE_SCAN_BYTES = 16 * MAX_ARCHIVE_SHARD_BYTES;
const MAX_ARCHIVE_MUTATION_ENTRIES = 50_000;

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
	content: string;
	body: string;
	title: string;
	timestamp?: string;
}

interface ArchiveFileChange {
	path: string;
	before: string | null;
	after: string | null;
}

interface ArchiveMutationPlan extends UserMemoryMutationResult {
	shards: ArchiveFileChange[];
	index?: ArchiveFileChange;
}

interface ArchiveSnapshot {
	shards: UserPreferenceShard[];
	directoryEntries: number;
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
		admission = new MemoryMutationAdmission(),
	): Promise<UserMemoryMutationResult> {
		admission.assertPending();
		const plan = await this.prepare(currentUser, action, budget, supersedeNearDuplicate);
		admission.assertPending();
		for (const change of [...plan.shards, ...(plan.index ? [plan.index] : [])]) {
			const current = await this.readOptional(change.path);
			if (current !== change.before) throw new Error(`User archive changed after preparation: ${change.path}.`);
			if (change.after === null) {
				admission.begin();
				await fs.unlink(change.path);
			} else {
				await writeFileAtomic(change.path, change.after, {
					mode: 0o600,
					// A derived index refresh must not admit the pending outer USER mutation.
					beforeCommit: () => (change === plan.index ? admission.assertPending() : admission.begin()),
				});
			}
		}
		admission.assertPending();
		return { userContent: plan.userContent, archiveChanged: plan.archiveChanged };
	}

	/**
	 * Preference lines held by the archive shards, in shard order, bounded, each with the heading
	 * path it was archived under (headings travel with the body into the shard). Blanks skipped.
	 */
	async archivedEntries(limit = 400): Promise<Array<{ line: string; section?: string }>> {
		const entries: Array<{ line: string; section?: string }> = [];
		for (const shard of (await this.readArchive()).shards) {
			for (const entry of collectUserPreferenceEntries(shard.body)) {
				entries.push(entry);
				if (entries.length >= limit) return entries;
			}
		}
		return entries;
	}

	/** Complete mutation input, never the truncated display projection. Caller holds the USER lock. */
	async mutationEntries(): Promise<Array<{ line: string; section?: string }>> {
		const { shards } = await this.readArchive();
		this.validateMutationCapacity(shards);
		return shards.flatMap((shard) => collectUserPreferenceEntries(shard.body));
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

	private async readArchive(): Promise<ArchiveSnapshot> {
		// Missing archive is empty. All other failures are unknown storage, never empty storage.
		try {
			const stat = await fs.lstat(this.archiveDir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error("User memory archive path must be a real directory, not a symlink.");
			}
		} catch (error) {
			if (isMissingFileError(error)) return { shards: [], directoryEntries: 0 };
			throw error;
		}
		const names: string[] = [];
		let count = 0;
		const directory = await fs.opendir(this.archiveDir);
		for await (const entry of directory) {
			if (++count > MAX_ARCHIVE_DIRECTORY_ENTRIES)
				throw new Error("User preference archive directory is too large.");
			if (!SHARD_NAME_RE.test(entry.name)) continue;
			if (!entry.isFile()) throw new Error(`User preference shard is not a regular file: ${entry.name}.`);
			if (names.length === MAX_ARCHIVE_SHARDS) throw new Error("User preference archive exceeds its shard limit.");
			names.push(entry.name);
		}
		names.sort((left, right) => left.localeCompare(right));
		const shards: UserPreferenceShard[] = [];
		let scannedBytes = 0;
		for (const name of names) {
			const path = join(this.archiveDir, name);
			const content = await readBoundedTextFile(
				path,
				Math.min(MAX_ARCHIVE_SHARD_BYTES, MAX_ARCHIVE_SCAN_BYTES - scannedBytes),
				`User preference shard ${name}`,
			);
			scannedBytes += Buffer.byteLength(content, "utf8");
			const parsed = parseOkfMemoryDocument(content, { uri: `okf:${ARCHIVE_DIR_NAME}/${name}` });
			if (parsed.diagnostics.length > 0 || parsed.item?.kind !== "user_preference" || parsed.item.scope !== "user") {
				throw new Error(`Invalid user preference shard: ${name}.`);
			}
			shards.push({
				path,
				name,
				content,
				body: parsed.body,
				title: parsed.item.title ?? `User preference shard ${name.slice(17, 33)}`,
				timestamp: parsed.item.timestamp,
			});
		}
		return { shards, directoryEntries: count };
	}

	private async readOptional(path: string): Promise<string | null> {
		try {
			return await readBoundedTextFile(path, MAX_ARCHIVE_SHARD_BYTES, "User preference archive file");
		} catch (error) {
			if (isMissingFileError(error)) return null;
			throw error;
		}
	}

	private validateMutationCapacity(shards: readonly UserPreferenceShard[]): void {
		if (shards.length > MAX_ARCHIVE_SHARDS) throw new Error("User preference archive exceeds its shard limit.");
		let bytes = 0;
		let entries = 0;
		for (const shard of shards) {
			const shardBytes = Buffer.byteLength(shard.content, "utf8");
			if (shardBytes > MAX_ARCHIVE_SHARD_BYTES) throw new Error("User preference shard exceeds its byte limit.");
			bytes += shardBytes;
			entries += collectUserPreferenceEntries(shard.body).length;
			if (bytes > MAX_ARCHIVE_SCAN_BYTES) throw new Error("User preference archive exceeds its byte limit.");
			if (entries > MAX_ARCHIVE_MUTATION_ENTRIES)
				throw new Error("User preference archive exceeds its entry limit.");
		}
	}

	private async prepare(
		currentUser: string,
		action: UserMemoryAction,
		budget: number,
		supersedeNearDuplicate: (existing: string, content: string) => string | null,
	): Promise<ArchiveMutationPlan> {
		await this.ensureArchiveDir();
		const snapshot = await this.readArchive();
		const original = snapshot.shards;
		this.validateMutationCapacity(original);
		const projected = new Map(original.map((shard) => [shard.name, shard]));
		const changes: ArchiveFileChange[] = [];
		const planNewShard = (body: string, identity: string): void => {
			const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
			const name = `user-preferences-${hash}.okf.md`;
			const existing = projected.get(name);
			if (existing) {
				if (existing.body.trim() === body) return;
				throw new Error(`User memory shard hash collision at ${name}.`);
			}
			const path = join(this.archiveDir, name);
			const timestamp = new Date().toISOString();
			const title = `User preference shard ${hash}`;
			const content = formatOkfMemoryDocument({
				type: "User Preference",
				title,
				description: safeDescription(body),
				scope: "user",
				body,
				tags: ["user-preferences", "archived"],
				timestamp,
			});
			projected.set(name, { path, name, content, body, title, timestamp });
			this.validateMutationCapacity([...projected.values()]);
			changes.push({ path, before: null, after: content });
		};
		const planReplacement = (shard: UserPreferenceShard, body: string): void => {
			if (!body.trim()) {
				projected.delete(shard.name);
				changes.push({ path: shard.path, before: shard.content, after: null });
				return;
			}
			this.validateArchiveContent(body);
			const [first, ...overflow] = splitArchiveBody(body);
			if (first === undefined) throw new Error("User preference replacement has no content.");
			const mutationDigest = createHash("sha256").update(`${shard.name}\0${body}`).digest("hex");
			// Preserve overflow before shortening its source; a later write error cannot discard the tail.
			for (const [index, chunk] of overflow.entries()) planNewShard(chunk, `${mutationDigest}\0${index + 1}`);
			const content = formatOkfMemoryDocument({
				type: "User Preference",
				title: shard.title,
				description: safeDescription(first),
				scope: "user",
				body: first,
				tags: ["user-preferences", "archived"],
				timestamp: shard.timestamp,
			});
			projected.set(shard.name, { ...shard, content, body: first });
			if (content !== shard.content) changes.push({ path: shard.path, before: shard.content, after: content });
		};
		const split = activeUserContent(currentUser);
		let active = split.active;
		let archiveChanged = false;
		if (action.action === "add") {
			const superseded = supersedeNearDuplicate(active, action.content);
			if (superseded !== null) active = superseded;
			else {
				for (const shard of original) {
					const body = supersedeNearDuplicate(shard.body, action.content);
					if (body === null) continue;
					planReplacement(shard, body);
					archiveChanged = true;
					break;
				}
				if (!archiveChanged) active = appendLine(active, action.content);
			}
		} else {
			const replacement = action.action === "replace" ? action.content : "";
			if (active.includes(action.oldContent)) active = active.replace(action.oldContent, replacement);
			else {
				const shard = original.find((candidate) => candidate.body.includes(action.oldContent));
				if (!shard)
					throw new Error(
						`The content to ${action.action} ('oldContent') was not found in the file or its archive.`,
					);
				planReplacement(shard, shard.body.replace(action.oldContent, replacement));
				archiveChanged = true;
			}
		}
		const hasArchive = split.managed || original.length > 0;
		let userContent = archiveChanged ? currentUser : `${hasArchive ? USER_ARCHIVE_POINTER : ""}${active}`;
		if (!archiveChanged && userContent.length > budget) {
			const body = active.trim();
			if (!body) throw new Error("USER.md index exceeds its character budget without archivable content.");
			this.validateArchiveContent(body);
			const migrationDigest = createHash("sha256").update(body).digest("hex");
			for (const [index, chunk] of splitArchiveBody(body).entries())
				planNewShard(chunk, `${migrationDigest}\0${index}`);
			userContent = USER_ARCHIVE_POINTER;
			archiveChanged = true;
		}
		const shards = [...projected.values()].sort((left, right) => left.name.localeCompare(right.name));
		this.validateMutationCapacity(shards);
		let index: ArchiveFileChange | undefined;
		if (archiveChanged || hasArchive) {
			const body =
				shards.length === 0
					? "No archived user preference shards."
					: shards.map((shard) => `- [${shard.name}](./${shard.name}): ${safeDescription(shard.body)}`).join("\n");
			const after = formatOkfMemoryDocument({
				type: "User Preference",
				title: "User preference archive index",
				description: "Index of archived durable user preference shards.",
				scope: "user",
				body,
				tags: ["user-preferences", "index"],
			});
			if (Buffer.byteLength(after, "utf8") > MAX_ARCHIVE_SHARD_BYTES)
				throw new Error("User preference index exceeds its byte limit.");
			const before = await this.readOptional(this.indexPath);
			if (before !== after) index = { path: this.indexPath, before, after };
		}
		// Overflow is staged before a source shard is shortened. Bound that peak too, including
		// unrelated directory entries and a newly-created derived index, so failures stay readable.
		const newFiles = changes.filter((change) => change.before === null).length;
		if (snapshot.directoryEntries + newFiles + (index?.before === null ? 1 : 0) > MAX_ARCHIVE_DIRECTORY_ENTRIES) {
			throw new Error("User preference archive directory would exceed its entry limit.");
		}
		return { userContent, archiveChanged, shards: changes, ...(index ? { index } : {}) };
	}
}
