import { createHash, randomUUID } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { access, copyFile, lstat, mkdtemp, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_CONTENT_REFERENCE_LIMIT = 64;
const DEFAULT_CONTENT_REFERENCE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MUTATION_PAYLOAD_LIMIT = 8;
const DEFAULT_MUTATION_PAYLOAD_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_MUTATION_PAYLOAD_TTL_MS = 10 * 60 * 1000;
const HASH_BUFFER_BYTES = 64 * 1024;
const CONTENT_REFERENCE_PREFIX = "file-content:";
const MUTATION_PAYLOAD_REFERENCE_PREFIX = "file-mutation:";
const LOCAL_MUTATION_PAYLOAD_DIRECTORY_PREFIX = "pi-file-mutation-payloads-";
const LOCAL_MUTATION_PAYLOAD_PROCESS_BYTE_LIMIT = 64 * 1024 * 1024;
const LOCAL_MUTATION_PAYLOAD_PROCESS_FILE_LIMIT = 64;

let localMutationPayloadDirectoryPromise: Promise<string> | undefined;
let localMutationPayloadDirectory: string | undefined;
let localMutationPayloadCleanupRegistered = false;
let localMutationPayloadOperationTail: Promise<void> = Promise.resolve();
let localMutationPayloadBytes = 0;
const localMutationPayloadFiles = new Map<string, { byteLength: number; expiresAt: number }>();

class MutationPayloadCapacityError extends Error {
	constructor() {
		super("Process mutation payload cache is full.");
		this.name = "MutationPayloadCapacityError";
	}
}

export type FileMutationKind = "write" | "edit";

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
	readPayload(path: string): Promise<string>;
	removeFile(path: string): Promise<void>;
	stagePayload(content: string, ttlMs: number): Promise<string>;
}

export interface FileMutationLease {
	kind: FileMutationKind;
	path: string;
	displayPath: string;
	identity?: FilePathIdentity;
}

export interface FileContentReference {
	contentRef: string;
	byteLength: number;
}

export interface FileMutationPayloadReference {
	payloadRef: string;
	byteLength: number;
}

export type FileMutationPreflightFailureReason = "write_collision" | "edit_missing" | "edit_not_file";

export class FileMutationPreflightError extends Error {
	readonly reason: FileMutationPreflightFailureReason;

	constructor(reason: FileMutationPreflightFailureReason, message: string) {
		super(message);
		this.name = "FileMutationPreflightError";
		this.reason = reason;
	}
}

export class FileMutationIdentityError extends Error {
	constructor(displayPath: string) {
		super(
			`Could not edit file: ${displayPath}. The file changed during edit execution; read it again before retrying.`,
		);
		this.name = "FileMutationIdentityError";
	}
}

interface ContentReferenceRecord {
	contentRef: string;
	sourcePath: string;
	digest: string;
	byteLength: number;
	expiresAt: number;
}

interface MutationPayloadRecord {
	payloadRef: string;
	kind: FileMutationKind;
	sourcePath: string;
	digest: string;
	byteLength: number;
	expiresAt: number;
}

export interface FileMutationIntentControllerOptions {
	operations?: FileMutationIntentOperations;
	contentReferenceLimit?: number;
	contentReferenceTtlMs?: number;
	mutationPayloadLimit?: number;
	mutationPayloadByteLimit?: number;
	mutationPayloadTtlMs?: number;
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

async function getLocalMutationPayloadDirectory(): Promise<string> {
	localMutationPayloadDirectoryPromise ??= mkdtemp(join(tmpdir(), LOCAL_MUTATION_PAYLOAD_DIRECTORY_PREFIX)).then(
		(path) => {
			localMutationPayloadDirectory = path;
			if (!localMutationPayloadCleanupRegistered) {
				localMutationPayloadCleanupRegistered = true;
				process.once("exit", () => {
					if (localMutationPayloadDirectory) {
						try {
							rmSync(localMutationPayloadDirectory, { recursive: true, force: true });
						} catch {
							// Process shutdown cannot safely retry filesystem cleanup.
						}
					}
				});
			}
			return path;
		},
	);
	return localMutationPayloadDirectoryPromise;
}

async function stageLocalMutationPayload(content: string, ttlMs: number): Promise<string> {
	const byteLength = Buffer.byteLength(content, "utf8");
	let stagedPath = "";
	const operation = localMutationPayloadOperationTail.then(async () => {
		for (const [path, record] of localMutationPayloadFiles) {
			if (record.expiresAt > Date.now()) continue;
			localMutationPayloadFiles.delete(path);
			localMutationPayloadBytes -= record.byteLength;
			try {
				await unlink(path);
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
			}
		}
		if (
			localMutationPayloadFiles.size >= LOCAL_MUTATION_PAYLOAD_PROCESS_FILE_LIMIT ||
			localMutationPayloadBytes + byteLength > LOCAL_MUTATION_PAYLOAD_PROCESS_BYTE_LIMIT
		) {
			throw new MutationPayloadCapacityError();
		}
		stagedPath = join(await getLocalMutationPayloadDirectory(), randomUUID());
		await writeFile(stagedPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		localMutationPayloadFiles.set(stagedPath, { byteLength, expiresAt: Date.now() + ttlMs });
		localMutationPayloadBytes += byteLength;
	});
	localMutationPayloadOperationTail = operation.catch(() => {});
	await operation;
	return stagedPath;
}

async function removeLocalMutationPayloadOrFile(path: string): Promise<void> {
	const operation = localMutationPayloadOperationTail.then(async () => {
		const record = localMutationPayloadFiles.get(path);
		if (record !== undefined) {
			localMutationPayloadFiles.delete(path);
			localMutationPayloadBytes -= record.byteLength;
		}
		await unlink(path);
	});
	localMutationPayloadOperationTail = operation.catch(() => {});
	await operation;
}

export const localFileMutationIntentOperations: FileMutationIntentOperations = {
	inspect: inspectLocalPath,
	access,
	copyFileExclusive: (sourcePath, targetPath) => copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL),
	hashFile: hashLocalFile,
	readPayload: (path) => readFile(path, "utf8"),
	removeFile: removeLocalMutationPayloadOrFile,
	stagePayload: stageLocalMutationPayload,
};

/**
 * Session-owned harness authority for file-mutation preflight, stale-target checks,
 * and bounded exact-content references. It retains only fixed-size metadata; file
 * bytes remain owned by the filesystem.
 */
export class FileMutationIntentController {
	private readonly operations: FileMutationIntentOperations;
	private readonly contentReferenceLimit: number;
	private readonly contentReferenceTtlMs: number;
	private readonly mutationPayloadLimit: number;
	private readonly mutationPayloadByteLimit: number;
	private readonly mutationPayloadTtlMs: number;
	private readonly now: () => number;
	private readonly contentReferences = new Map<string, ContentReferenceRecord>();
	private readonly mutationPayloads = new Map<string, MutationPayloadRecord>();
	private mutationPayloadBytes = 0;
	private lastMutationPayloadExpiresAt = 0;
	private mutationPayloadOperationTail: Promise<void> = Promise.resolve();

	constructor(options: FileMutationIntentControllerOptions = {}) {
		this.operations = options.operations ?? localFileMutationIntentOperations;
		this.contentReferenceLimit = positiveBound(
			options.contentReferenceLimit,
			DEFAULT_CONTENT_REFERENCE_LIMIT,
			"Content reference limit",
		);
		this.contentReferenceTtlMs = positiveBound(
			options.contentReferenceTtlMs,
			DEFAULT_CONTENT_REFERENCE_TTL_MS,
			"Content reference TTL",
		);
		this.mutationPayloadLimit = positiveBound(
			options.mutationPayloadLimit,
			DEFAULT_MUTATION_PAYLOAD_LIMIT,
			"Mutation payload limit",
		);
		this.mutationPayloadByteLimit = positiveBound(
			options.mutationPayloadByteLimit,
			DEFAULT_MUTATION_PAYLOAD_BYTE_LIMIT,
			"Mutation payload byte limit",
		);
		this.mutationPayloadTtlMs = positiveBound(
			options.mutationPayloadTtlMs,
			DEFAULT_MUTATION_PAYLOAD_TTL_MS,
			"Mutation payload TTL",
		);
		this.now = options.now ?? Date.now;
	}

	async prepare(
		kind: FileMutationKind,
		path: string,
		signal?: AbortSignal,
		displayPath: string = path,
	): Promise<FileMutationLease> {
		this.pruneExpired();
		if (signal?.aborted) throw new Error("Operation aborted");
		const absolutePath = resolve(path);
		let identity: FilePathIdentity | undefined;
		if (kind === "write") {
			const existing = await this.operations.inspect(absolutePath, false);
			if (existing) {
				throw new FileMutationPreflightError("write_collision", `Write collision: ${displayPath} already exists.`);
			}
			await this.assertCreatableParent(absolutePath);
		} else {
			const existing = await this.operations.inspect(absolutePath, true);
			if (!existing) {
				throw new FileMutationPreflightError(
					"edit_missing",
					`Could not edit file: ${displayPath}. Error code: ENOENT.`,
				);
			}
			if (existing.kind !== "file") {
				throw new FileMutationPreflightError(
					"edit_not_file",
					`Could not edit file: ${displayPath}. Target is not a regular file.`,
				);
			}
			try {
				await this.operations.access(absolutePath, constants.R_OK | constants.W_OK);
			} catch (error) {
				const code = errorCode(error);
				throw new Error(`Could not edit file: ${displayPath}. ${code ? `Error code: ${code}` : String(error)}.`);
			}
			identity = existing.identity;
		}
		if (signal?.aborted) throw new Error("Operation aborted");

		return {
			kind,
			path: absolutePath,
			displayPath,
			...(identity ? { identity } : {}),
		};
	}

	async assertCurrent(lease: FileMutationLease, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (lease.kind === "write") {
			if (await this.operations.inspect(lease.path, false)) {
				throw new FileMutationPreflightError(
					"write_collision",
					`Write collision: ${lease.displayPath} became occupied after preflight; no content was overwritten.`,
				);
			}
			return;
		}

		const current = await this.operations.inspect(lease.path, true);
		if (!current || current.kind !== "file") {
			throw new Error(`Could not edit file: ${lease.displayPath}. The target no longer exists after preflight.`);
		}
		if (!identitiesMatch(lease.identity, current.identity)) {
			throw new FileMutationIdentityError(lease.displayPath);
		}
		try {
			await this.operations.access(lease.path, constants.R_OK | constants.W_OK);
		} catch (error) {
			const code = errorCode(error);
			throw new Error(`Could not edit file: ${lease.displayPath}. ${code ? `Error code: ${code}` : String(error)}.`);
		}
	}

	/**
	 * Re-anchor an edit lease to the file's current identity after an observed change.
	 * The caller must then re-read and re-validate its content against that same version;
	 * the next assertCurrent re-verifies it immediately before any write.
	 */
	async refreshIdentity(lease: FileMutationLease, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (lease.kind !== "edit") {
			throw new Error(`Could not refresh file identity for ${lease.displayPath}: only edit leases track one.`);
		}
		const current = await this.operations.inspect(lease.path, true);
		if (!current || current.kind !== "file") {
			throw new Error(`Could not edit file: ${lease.displayPath}. The target no longer exists after preflight.`);
		}
		lease.identity = current.identity;
	}

	rememberContent(sourcePath: string, content: string): FileContentReference {
		const digest = createHash("sha256").update(content, "utf8").digest("hex");
		return this.rememberContentDigest(sourcePath, digest, Buffer.byteLength(content, "utf8"));
	}

	/** True when this session's own earlier mutation produced exactly this content at this path. */
	hasProducedContent(sourcePath: string, content: string): boolean {
		this.pruneExpired();
		const digest = createHash("sha256").update(content, "utf8").digest("hex");
		for (const record of this.contentReferences.values()) {
			if (record.sourcePath === sourcePath && record.digest === digest) return true;
		}
		return false;
	}

	async retainMutationPayload(
		kind: FileMutationKind,
		payload: string,
	): Promise<FileMutationPayloadReference | undefined> {
		return this.runMutationPayloadOperation(async () => {
			await this.pruneExpiredMutationPayloads();
			const byteLength = Buffer.byteLength(payload, "utf8");
			if (byteLength > this.mutationPayloadByteLimit) return undefined;
			while (
				this.mutationPayloads.size >= this.mutationPayloadLimit ||
				this.mutationPayloadBytes + byteLength > this.mutationPayloadByteLimit
			) {
				const oldestPayloadRef = this.mutationPayloads.keys().next().value;
				if (typeof oldestPayloadRef !== "string") return undefined;
				await this.deleteMutationPayload(oldestPayloadRef, true);
			}

			// Keep insertion and expiry order identical, even if the wall clock moves backward. Expiry
			// pruning can then stop at the first live record instead of rescanning every retained payload.
			const expiresAt = Math.max(this.lastMutationPayloadExpiresAt, this.now() + this.mutationPayloadTtlMs);
			this.lastMutationPayloadExpiresAt = expiresAt;
			let sourcePath: string;
			try {
				sourcePath = await this.operations.stagePayload(payload, this.mutationPayloadTtlMs);
			} catch (error) {
				if (error instanceof MutationPayloadCapacityError) return undefined;
				throw error;
			}
			const payloadRef = `${MUTATION_PAYLOAD_REFERENCE_PREFIX}${randomUUID()}`;
			this.mutationPayloads.set(payloadRef, {
				payloadRef,
				kind,
				sourcePath,
				digest: createHash("sha256").update(payload, "utf8").digest("hex"),
				byteLength,
				expiresAt,
			});
			this.mutationPayloadBytes += byteLength;
			return { payloadRef, byteLength };
		});
	}

	async readMutationPayload(payloadRef: string, kind: FileMutationKind, signal?: AbortSignal): Promise<string> {
		return this.runMutationPayloadOperation(async () => {
			const record = await this.requireMutationPayload(payloadRef, kind, signal);
			const payload = await this.operations.readPayload(record.sourcePath);
			if (createHash("sha256").update(payload, "utf8").digest("hex") !== record.digest) {
				await this.deleteMutationPayload(payloadRef);
				throw new Error("Retained file mutation payload changed after it was cached.");
			}
			return payload;
		});
	}

	async assertMutationPayload(payloadRef: string, kind: FileMutationKind, signal?: AbortSignal): Promise<void> {
		await this.runMutationPayloadOperation(async () => {
			await this.requireVerifiedMutationPayload(payloadRef, kind, signal);
		});
	}

	async assertContentReference(contentRef: string, signal?: AbortSignal): Promise<void> {
		await this.requireVerifiedContentReference(contentRef, signal);
	}

	async copyMutationPayload(
		payloadRef: string,
		targetPath: string,
		signal?: AbortSignal,
	): Promise<FileContentReference> {
		return this.runMutationPayloadOperation(async () => {
			const record = await this.requireVerifiedMutationPayload(payloadRef, "write", signal);
			await this.copyVerifiedSource(record, targetPath, signal);
			await this.deleteMutationPayload(payloadRef);
			return this.rememberContentDigest(targetPath, record.digest, record.byteLength);
		});
	}

	async discardMutationPayload(payloadRef: string): Promise<void> {
		await this.runMutationPayloadOperation(() => this.deleteMutationPayload(payloadRef));
	}

	/** Release every payload owned by this controller without touching another controller's files. */
	async dispose(): Promise<void> {
		await this.runMutationPayloadOperation(async () => {
			let firstError: unknown;
			for (const payloadRef of [...this.mutationPayloads.keys()]) {
				try {
					await this.deleteMutationPayload(payloadRef, true);
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError) throw firstError;
		});
	}

	async copyReferencedContent(
		contentRef: string,
		targetPath: string,
		signal?: AbortSignal,
	): Promise<FileContentReference> {
		const record = await this.requireVerifiedContentReference(contentRef, signal);
		await this.copyVerifiedSource(record, targetPath, signal);
		return this.rememberContentDigest(targetPath, record.digest, record.byteLength);
	}

	private async requireVerifiedContentReference(
		contentRef: string,
		signal?: AbortSignal,
	): Promise<ContentReferenceRecord> {
		this.pruneExpired();
		const record = this.contentReferences.get(contentRef);
		if (!record) throw new Error("File content reference is invalid, expired, or belongs to another session.");
		this.touchContentReference(record);
		if (signal?.aborted) throw new Error("Operation aborted");
		try {
			await this.verifySource(record, signal, "File content reference source");
		} catch (error) {
			this.contentReferences.delete(contentRef);
			throw error;
		}
		return record;
	}

	private async requireMutationPayload(
		payloadRef: string,
		kind: FileMutationKind,
		signal?: AbortSignal,
	): Promise<MutationPayloadRecord> {
		await this.pruneExpiredMutationPayloads();
		if (signal?.aborted) throw new Error("Operation aborted");
		const record = this.mutationPayloads.get(payloadRef);
		if (!record) {
			throw new Error("File mutation payload reference is invalid, expired, or belongs to another session.");
		}
		if (record.kind !== kind) {
			throw new Error(`File mutation payload reference is for ${record.kind}, not ${kind}.`);
		}
		return record;
	}

	private async requireVerifiedMutationPayload(
		payloadRef: string,
		kind: FileMutationKind,
		signal?: AbortSignal,
	): Promise<MutationPayloadRecord> {
		const record = await this.requireMutationPayload(payloadRef, kind, signal);
		try {
			await this.verifySource(record, signal, "Retained file mutation payload");
		} catch (error) {
			await this.deleteMutationPayload(payloadRef);
			throw error;
		}
		return record;
	}

	private async verifySource(
		record: Pick<MutationPayloadRecord, "sourcePath" | "digest">,
		signal: AbortSignal | undefined,
		label: string,
	): Promise<void> {
		let sourceDigest: string;
		try {
			sourceDigest = await this.operations.hashFile(record.sourcePath, signal);
		} catch (error) {
			throw new Error(`${label} is unavailable: ${String(error)}.`);
		}
		if (sourceDigest !== record.digest) throw new Error(`${label} changed after it was cached.`);
	}

	private async copyVerifiedSource(
		record: Pick<MutationPayloadRecord, "sourcePath" | "digest">,
		targetPath: string,
		signal?: AbortSignal,
	): Promise<void> {
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

	private async deleteMutationPayload(payloadRef: string, strict = false): Promise<void> {
		const record = this.mutationPayloads.get(payloadRef);
		if (!record) return;
		this.mutationPayloads.delete(payloadRef);
		this.mutationPayloadBytes -= record.byteLength;
		try {
			await this.operations.removeFile(record.sourcePath);
		} catch (error) {
			if (strict && !isMissingPathError(error)) throw error;
		}
	}

	private runMutationPayloadOperation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.mutationPayloadOperationTail.then(operation, operation);
		this.mutationPayloadOperationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async pruneExpiredMutationPayloads(): Promise<void> {
		const now = this.now();
		for (const [payloadRef, record] of this.mutationPayloads) {
			if (record.expiresAt > now) break;
			await this.deleteMutationPayload(payloadRef, true);
		}
	}

	private pruneExpired(): void {
		const now = this.now();
		for (const [contentRef, record] of this.contentReferences) {
			if (record.expiresAt <= now) this.contentReferences.delete(contentRef);
		}
	}
}
