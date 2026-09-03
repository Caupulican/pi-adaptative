import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { okfMemoryDir, okfProjectMemoryDir } from "../agent-paths.ts";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import {
	formatOkfMemoryDocument,
	type OkfMemoryDocumentInput,
	type PiOkfType,
	validateOkfMemoryDocumentInput,
} from "../context/okf-memory.ts";
import { loadOkfMemoryBundle } from "../context/okf-memory-provider.ts";
import { getDirectoryResourceProfileInfo } from "../settings-manager.ts";
import { isMissingFileError, withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import { readBoundedTextFile } from "../util/bounded-file.ts";

const MAX_OKF_DOCUMENT_BYTES = 16_384;

function digest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface OkfProjectMemoryPutResult {
	created: boolean;
	digest: string;
	path: string;
}

export interface OkfProjectMemoryRemoveResult {
	removed: boolean;
}

/**
 * Durable storage owner for model-authored project OKF records. It owns project identity, bounds,
 * conflict policy, symlink containment, per-record locking, and atomic replacement. Existing
 * different content is never overwritten by an `add`; reflection must confront it explicitly.
 */
export class OkfProjectMemoryStore {
	readonly projectId: string;
	readonly projectRoot: string;
	private readonly agentDir: string;
	private readonly rootDir: string;
	private readonly projectDir: string;

	constructor(agentDir: string, cwd: string) {
		const identity = getDirectoryResourceProfileInfo(cwd, agentDir);
		this.agentDir = agentDir;
		this.rootDir = okfMemoryDir(agentDir);
		this.projectId = identity.hash;
		this.projectRoot = identity.root;
		this.projectDir = okfProjectMemoryDir(agentDir, identity.hash);
	}

	private recordPath(type: PiOkfType, title: string): string {
		const path = join(this.projectDir, `${digest(`${type}\0${title}`)}.okf.md`);
		if (!isPathWithinScope(path, this.projectDir)) throw new Error("OKF record escaped its project root.");
		return path;
	}

	private assertContained(path: string): void {
		const canonicalAgentDir = safeRealpathSync(this.agentDir);
		const canonicalRootDir = safeRealpathSync(this.rootDir);
		const canonicalProjectDir = safeRealpathSync(this.projectDir);
		const canonicalPath = safeRealpathSync(path);
		if (!isPathWithinScope(canonicalRootDir, canonicalAgentDir)) {
			throw new Error("OKF memory root escapes the agent directory.");
		}
		if (!isPathWithinScope(canonicalProjectDir, canonicalRootDir)) {
			throw new Error("OKF project root escapes the OKF memory root.");
		}
		if (!isPathWithinScope(canonicalPath, canonicalProjectDir)) {
			throw new Error("OKF record escapes its project root.");
		}
	}

	async put(input: Omit<OkfMemoryDocumentInput, "projectId">): Promise<OkfProjectMemoryPutResult> {
		const errors = validateOkfMemoryDocumentInput(input, { projectOnly: true, requireEvidence: true });
		if (errors.length > 0) throw new Error(`Invalid OKF record: ${errors.join("; ")}`);
		const document = formatOkfMemoryDocument({ ...input, projectId: this.projectId });
		const documentDigest = digest(document);
		const path = this.recordPath(input.type, input.title);
		this.assertContained(path);
		return withFileLock(path, async () => {
			this.assertContained(path);
			try {
				const existing = await readBoundedTextFile(path, MAX_OKF_DOCUMENT_BYTES, "OKF project record");
				if (existing === document) return { created: false, digest: documentDigest, path };
				throw new Error("A different structured record already exists for this type and title.");
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
			await writeFileAtomic(path, document, { mode: 0o600 });
			return { created: true, digest: documentDigest, path };
		});
	}

	async remove(type: PiOkfType, title: string, expectedDigest?: string): Promise<OkfProjectMemoryRemoveResult> {
		const path = this.recordPath(type, title);
		this.assertContained(path);
		return withFileLock(path, async () => {
			this.assertContained(path);
			let existing: string;
			try {
				existing = await readBoundedTextFile(path, MAX_OKF_DOCUMENT_BYTES, "OKF project record");
			} catch (error) {
				if (isMissingFileError(error)) return { removed: false };
				throw error;
			}
			if (expectedDigest !== undefined && digest(existing) !== expectedDigest) {
				throw new Error("OKF record changed after the audited write; refusing removal.");
			}
			await fs.unlink(path);
			return { removed: true };
		});
	}

	list(maxDocuments = 64): string {
		return loadOkfMemoryBundle({
			rootDir: this.rootDir,
			projectId: this.projectId,
			projectRoot: this.projectRoot,
			maxDocuments,
		})
			.entries.map(({ path, parsed }) => {
				const item = parsed.item;
				// Absolute on purpose: a root-relative spelling in model-facing text was minted as a path
				// alias and resolved against the working directory (measured live: ENOENT on read).
				return item === undefined ? "" : `${path}: ${item.title ?? "Untitled"} — ${item.summary}`;
			})
			.filter((entry) => entry.length > 0)
			.join("\n")
			.slice(0, 8_000);
	}
}
