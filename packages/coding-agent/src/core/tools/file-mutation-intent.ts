import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, open, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_INTENT_LIMIT = 64;
const DEFAULT_CONTENT_REFERENCE_LIMIT = 64;
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CONTENT_REFERENCE_TTL_MS = 60 * 60 * 1000;
const HASH_BUFFER_BYTES = 64 * 1024;
const CONTENT_REFERENCE_PREFIX = "file-content:";
const FILE_MUTATION_INTENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FileMutationKind = "write" | "edit";

export function hasFileMutationIntentIdShape(value: unknown): value is string {
	return typeof value === "string" && FILE_MUTATION_INTENT_ID_PATTERN.test(value);
}

export interface FilePathIdentity {
	dev: string;
	ino: string;
	mode: string;
	size: string;
	mtimeMs: string;
	ctimeMs: string;
}

export interface FilePathInspection {
	kind: "file" | "directory" | "other";
	identity: FilePathIdentity;
}

export interface FileMutationIntentOperations {
	inspect(path: string, followSymlinks: boolean): Promise<FilePathInspection | undefined>;
	access(path: string, mode: number): Promise<void>;
	copyFileExclusive(sourcePath: string, targetPath: string): Promise<void>;
	hashFile(path: string, signal?: AbortSignal): Promise<string>;
	removeFile(path: string): Promise<void>;
}

export interface PreparedFileMutation {
	intentId: string;
	kind: FileMutationKind;
	path: string;
	displayPath: string;
}

export interface FileMutationLease extends PreparedFileMutation {
	identity?: FilePathIdentity;
}

export interface FileContentReference {
	contentRef: string;
	byteLength: number;
}

interface MutationIntentRecord extends FileMutationLease {
	expiresAt: number;
}

interface ContentReferenceRecord {
	contentRef: string;
	sourcePath: string;
	digest: string;
	byteLength: number;
	expiresAt: number;
}

export interface FileMutationIntentControllerOptions {
	operations?: FileMutationIntentOperations;
	intentLimit?: number;
	contentReferenceLimit?: number;
	intentTtlMs?: number;
	contentReferenceTtlMs?: number;
	now?: () => number;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function normalizedPath(path: string): string {
	const absolutePath = resolve(path);
	return process.platform === "win32" ? absolutePath.toLocaleLowerCase("en-US") : absolutePath;
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
	const resolvedValue = value ?? fallback;
	if (!Number.isSafeInteger(resolvedValue) || resolvedValue < 1) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return resolvedValue;
}

function normalizedIdentity(value: {
	dev: number | bigint;
	ino: number | bigint;
	mode: number | bigint;
	size: number | bigint;
	mtimeMs: number | bigint;
	ctimeMs: number | bigint;
}): FilePathIdentity {
	return {
		dev: String(value.dev),
		ino: String(value.ino),
		mode: String(value.mode),
		size: String(value.size),
		mtimeMs: String(value.mtimeMs),
		ctimeMs: String(value.ctimeMs),
	};
}

function identitiesMatch(left: FilePathIdentity | undefined, right: FilePathIdentity | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function inspectLocalPath(path: string, followSymlinks: boolean): Promise<FilePathInspection | undefined> {
	try {
		const result = followSymlinks ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
		return {
			kind: result.isFile() ? "file" : result.isDirectory() ? "directory" : "other",
			identity: normalizedIdentity(result),
		};
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

async function hashLocalFile(path: string, signal?: AbortSignal): Promise<string> {
	const handle = await open(path, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
	try {
		let position = 0;
		while (true) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

export const localFileMutationIntentOperations: FileMutationIntentOperations = {
	inspect: inspectLocalPath,
	access,
	copyFileExclusive: (sourcePath, targetPath) => copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL),
	hashFile: hashLocalFile,
	removeFile: unlink,
};

/**
 * Session-owned authority for two-phase file mutation intents and bounded exact-content references.
 * It retains only fixed-size metadata; file bytes remain owned by the filesystem.
 */
export class FileMutationIntentController {
	private readonly operations: FileMutationIntentOperations;
	private readonly intentLimit: number;
	private readonly contentReferenceLimit: number;
	private readonly intentTtlMs: number;
	private readonly contentReferenceTtlMs: number;
	private readonly now: () => number;
	private readonly intents = new Map<string, MutationIntentRecord>();
	private readonly intentByPath = new Map<string, string>();
	private readonly contentReferences = new Map<string, ContentReferenceRecord>();

	constructor(options: FileMutationIntentControllerOptions = {}) {
		this.operations = options.operations ?? localFileMutationIntentOperations;
		this.intentLimit = positiveBound(options.intentLimit, DEFAULT_INTENT_LIMIT, "Intent limit");
		this.contentReferenceLimit = positiveBound(
			options.contentReferenceLimit,
			DEFAULT_CONTENT_REFERENCE_LIMIT,
			"Content reference limit",
		);
		this.intentTtlMs = positiveBound(options.intentTtlMs, DEFAULT_INTENT_TTL_MS, "Intent TTL");
		this.contentReferenceTtlMs = positiveBound(
			options.contentReferenceTtlMs,
			DEFAULT_CONTENT_REFERENCE_TTL_MS,
			"Content reference TTL",
		);
		this.now = options.now ?? Date.now;
	}

	async prepare(
		kind: FileMutationKind,
		path: string,
		signal?: AbortSignal,
		displayPath: string = path,
	): Promise<PreparedFileMutation> {
		this.pruneExpired();
		if (signal?.aborted) throw new Error("Operation aborted");
		const absolutePath = resolve(path);
		let identity: FilePathIdentity | undefined;
		if (kind === "write") {
			const existing = await this.operations.inspect(absolutePath, false);
			if (existing) throw new Error(`Write collision: ${displayPath} already exists.`);
			await this.assertCreatableParent(absolutePath);
		} else {
			const existing = await this.operations.inspect(absolutePath, true);
			if (!existing) throw new Error(`Could not edit file: ${displayPath}. Error code: ENOENT.`);
			if (existing.kind !== "file")
				throw new Error(`Could not edit file: ${displayPath}. Target is not a regular file.`);
			try {
				await this.operations.access(absolutePath, constants.R_OK | constants.W_OK);
			} catch (error) {
				const code = errorCode(error);
				throw new Error(`Could not edit file: ${displayPath}. ${code ? `Error code: ${code}` : String(error)}.`);
			}
			identity = existing.identity;
		}
		if (signal?.aborted) throw new Error("Operation aborted");

		const key = `${kind}\0${normalizedPath(absolutePath)}`;
		const priorIntentId = this.intentByPath.get(key);
		const priorIntent = priorIntentId ? this.intents.get(priorIntentId) : undefined;
		if (priorIntent && (kind === "write" || identitiesMatch(priorIntent.identity, identity))) {
			priorIntent.displayPath = displayPath;
			priorIntent.expiresAt = this.now() + this.intentTtlMs;
			this.intents.delete(priorIntent.intentId);
			this.intents.set(priorIntent.intentId, priorIntent);
			return { intentId: priorIntent.intentId, kind, path: absolutePath, displayPath };
		}
		if (priorIntentId) this.deleteIntent(priorIntentId);
		while (this.intents.size >= this.intentLimit) {
			const oldestIntentId = this.intents.keys().next().value;
			if (typeof oldestIntentId !== "string") break;
			this.deleteIntent(oldestIntentId);
		}
		const intentId = randomUUID();
		const record: MutationIntentRecord = {
			intentId,
			kind,
			path: absolutePath,
			displayPath,
			...(identity ? { identity } : {}),
			expiresAt: this.now() + this.intentTtlMs,
		};
		this.intents.set(intentId, record);
		this.intentByPath.set(key, intentId);
		return { intentId, kind, path: absolutePath, displayPath };
	}

	consume(intentId: string, kind: FileMutationKind, path: string): FileMutationLease {
		this.pruneExpired();
		const record = this.intents.get(intentId);
		if (!record) throw new Error("File mutation intent is invalid, expired, or belongs to another session.");
		this.deleteIntent(intentId);
		if (record.kind !== kind) throw new Error(`File mutation intent is for ${record.kind}, not ${kind}.`);
		if (normalizedPath(record.path) !== normalizedPath(path)) {
			throw new Error("File mutation intent path does not match the requested mutation path.");
		}
		return {
			intentId: record.intentId,
			kind: record.kind,
			path: record.path,
			displayPath: record.displayPath,
			...(record.identity ? { identity: record.identity } : {}),
		};
	}

	async assertCurrent(lease: FileMutationLease, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (lease.kind === "write") {
			if (await this.operations.inspect(lease.path, false)) {
				throw new Error(`Write collision: ${lease.displayPath} already exists; the prepared intent is stale.`);
			}
			return;
		}

		const current = await this.operations.inspect(lease.path, true);
		if (!current || current.kind !== "file") {
			throw new Error(`Could not edit file: ${lease.displayPath}. The prepared target no longer exists.`);
		}
		if (!identitiesMatch(lease.identity, current.identity)) {
			throw new Error(
				`Could not edit file: ${lease.displayPath}. The file changed after preparation; prepare again.`,
			);
		}
		try {
			await this.operations.access(lease.path, constants.R_OK | constants.W_OK);
		} catch (error) {
			const code = errorCode(error);
			throw new Error(`Could not edit file: ${lease.displayPath}. ${code ? `Error code: ${code}` : String(error)}.`);
		}
	}

	rememberContent(sourcePath: string, content: string): FileContentReference {
		const digest = createHash("sha256").update(content, "utf8").digest("hex");
		return this.rememberContentDigest(sourcePath, digest, Buffer.byteLength(content, "utf8"));
	}

	async copyReferencedContent(
		contentRef: string,
		targetPath: string,
		signal?: AbortSignal,
	): Promise<FileContentReference> {
		this.pruneExpired();
		const record = this.contentReferences.get(contentRef);
		if (!record) throw new Error("File content reference is invalid, expired, or belongs to another session.");
		this.touchContentReference(record);
		if (signal?.aborted) throw new Error("Operation aborted");
		let sourceDigest: string;
		try {
			sourceDigest = await this.operations.hashFile(record.sourcePath, signal);
		} catch (error) {
			throw new Error(`File content reference source is unavailable: ${String(error)}.`);
		}
		if (sourceDigest !== record.digest) {
			this.contentReferences.delete(contentRef);
			throw new Error("File content reference source changed after it was cached.");
		}

		await this.operations.copyFileExclusive(record.sourcePath, targetPath);
		let targetDigest: string;
		try {
			targetDigest = await this.operations.hashFile(targetPath, signal);
		} catch (error) {
			await this.removeFailedCopy(targetPath, error);
			throw error;
		}
		if (targetDigest !== record.digest) {
			await this.removeFailedCopy(targetPath, new Error("copied bytes did not match the cached digest"));
			throw new Error("File content copy changed while it was being created; the target was removed.");
		}
		return this.rememberContentDigest(targetPath, record.digest, record.byteLength);
	}

	private async assertCreatableParent(path: string): Promise<void> {
		let candidate = dirname(path);
		while (true) {
			const inspection = await this.operations.inspect(candidate, true);
			if (inspection) {
				if (inspection.kind !== "directory") {
					throw new Error(`Write parent path is not a directory: ${candidate}.`);
				}
				try {
					await this.operations.access(candidate, constants.W_OK);
				} catch (error) {
					const code = errorCode(error);
					throw new Error(`Write parent is not writable: ${candidate}${code ? ` (${code})` : ""}.`);
				}
				return;
			}
			const parent = dirname(candidate);
			if (parent === candidate) throw new Error(`No writable parent exists for ${path}.`);
			candidate = parent;
		}
	}

	private rememberContentDigest(sourcePath: string, digest: string, byteLength: number): FileContentReference {
		this.pruneExpired();
		for (const existing of this.contentReferences.values()) {
			if (existing.sourcePath === sourcePath && existing.digest === digest) {
				this.touchContentReference(existing);
				return { contentRef: existing.contentRef, byteLength: existing.byteLength };
			}
		}
		while (this.contentReferences.size >= this.contentReferenceLimit) {
			const oldestContentRef = this.contentReferences.keys().next().value;
			if (typeof oldestContentRef !== "string") break;
			this.contentReferences.delete(oldestContentRef);
		}
		const contentRef = `${CONTENT_REFERENCE_PREFIX}${randomUUID()}`;
		this.contentReferences.set(contentRef, {
			contentRef,
			sourcePath,
			digest,
			byteLength,
			expiresAt: this.now() + this.contentReferenceTtlMs,
		});
		return { contentRef, byteLength };
	}

	private touchContentReference(record: ContentReferenceRecord): void {
		record.expiresAt = this.now() + this.contentReferenceTtlMs;
		this.contentReferences.delete(record.contentRef);
		this.contentReferences.set(record.contentRef, record);
	}

	private async removeFailedCopy(path: string, cause: unknown): Promise<void> {
		try {
			await this.operations.removeFile(path);
		} catch (cleanupError) {
			throw new Error(
				`Copied content verification failed (${String(cause)}), and the newly created target could not be removed: ${String(cleanupError)}.`,
			);
		}
	}

	private deleteIntent(intentId: string): void {
		const record = this.intents.get(intentId);
		if (!record) return;
		this.intents.delete(intentId);
		const key = `${record.kind}\0${normalizedPath(record.path)}`;
		if (this.intentByPath.get(key) === intentId) this.intentByPath.delete(key);
	}

	private pruneExpired(): void {
		const now = this.now();
		for (const [intentId, record] of this.intents) {
			if (record.expiresAt <= now) this.deleteIntent(intentId);
		}
		for (const [contentRef, record] of this.contentReferences) {
			if (record.expiresAt <= now) this.contentReferences.delete(contentRef);
		}
	}
}
