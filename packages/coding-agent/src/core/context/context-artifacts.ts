/**
 * Artifact store abstraction (Phase 2): stable refs for raw large payloads, kept out of
 * band from prompt context. This module defines the `ArtifactStore` interface plus two
 * implementations: an in-memory one for tests, and `createFileArtifactStore` (session-
 * scoped, filesystem-backed). A SQLite-backed implementation waits until the Phase M0
 * storage-authority/location/concurrency decisions are accepted (see
 * docs/context-management-rework/memory-architecture.md).
 *
 * `createFileArtifactStore` is wired into live grep/find tool construction in
 * agent-session.ts (session-scoped under `<agentDir>/work/context/sessions/<sessionId>/artifacts/`).
 * References are registered at pack time and released when context-gc evicts the
 * corresponding grep/find tool result (opportunistic, conservative cleanup), with a
 * best-effort dispose-time sweep for zero-reference artifacts. Payloads are retrievable
 * out of band via the artifact_retrieve tool (context/artifact-retrieval.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { type ContextArtifactRef, estimateByteLength, estimateLineCount } from "./context-item.ts";

export interface ArtifactWriteRequest {
	kind: ContextArtifactRef["kind"];
	content: string;
	toolName?: string;
	command?: string;
	path?: string;
	sessionEntryId?: string;
	createdAtTurn: number;
	reproducible: boolean;
}

export interface ArtifactRecord {
	ref: ContextArtifactRef;
	content: string;
}

export type MissingArtifactReason = "not_found" | "cleaned_up";

export interface MissingArtifactMarker {
	id: string;
	missing: true;
	reason: MissingArtifactReason;
}

export function isMissingArtifactMarker(value: ArtifactRecord | MissingArtifactMarker): value is MissingArtifactMarker {
	return (value as MissingArtifactMarker).missing === true;
}

/**
 * Artifact id for a capture event, not merely a payload: it hashes every ref-defining
 * field (kind, tool/command/path, content, sessionEntryId, createdAtTurn, reproducible).
 * A repeat write with identical content but a different turn or session entry is a
 * distinct capture and must get a distinct id -- otherwise the later capture's metadata
 * would be silently discarded in favor of the first write. Only a truly identical
 * request (same capture, re-submitted) is idempotent under this id.
 */
export function generateArtifactId(
	request: Pick<
		ArtifactWriteRequest,
		"kind" | "content" | "toolName" | "command" | "path" | "sessionEntryId" | "createdAtTurn" | "reproducible"
	>,
): string {
	const hash = createHash("sha256");
	for (const field of [
		request.kind,
		request.toolName ?? "",
		request.command ?? "",
		request.path ?? "",
		request.sessionEntryId ?? "",
		String(request.createdAtTurn),
		String(request.reproducible),
	]) {
		hash.update(field).update("\0");
	}
	hash.update(request.content);
	return hash.digest("hex").slice(0, 24);
}

function createArtifactRef(id: string, request: ArtifactWriteRequest): ContextArtifactRef {
	return {
		id,
		kind: request.kind,
		sessionEntryId: request.sessionEntryId,
		toolName: request.toolName,
		command: request.command,
		path: request.path,
		byteLength: estimateByteLength(request.content),
		lineCount: estimateLineCount(request.content),
		createdAtTurn: request.createdAtTurn,
		reproducible: request.reproducible,
	};
}

export interface ArtifactStore {
	write(request: ArtifactWriteRequest): ArtifactRecord;
	read(id: string): ArtifactRecord | MissingArtifactMarker;
	/**
	 * Metadata-only lookup: the ref if `id` resolves to a live artifact, `undefined`
	 * otherwise. Never loads the payload -- for the file store this must not touch the
	 * payload file at all beyond an existence check, so a caller that only needs to know
	 * "does this still exist, and what are its ref fields" (e.g. a per-turn audit pass)
	 * never pays the cost of reading potentially large content off disk.
	 */
	readRef(id: string): ContextArtifactRef | undefined;
	has(id: string): boolean;
	/**
	 * Register that `holderId` (a context item id, session entry id, etc.) depends on this
	 * artifact. Returns false if `id` does not exist (never written, or already cleaned
	 * up) so a caller cannot believe it protected an artifact that was never registered.
	 * Callers must fail closed (treat the artifact as unprotected) on a false return.
	 */
	addReference(id: string, holderId: string): boolean;
	/** Release a previously registered dependency. Returns true only if a reference was actually removed. */
	removeReference(id: string, holderId: string): boolean;
	referenceCount(id: string): number;
	/** Delete only artifacts with zero active references. Returns the ids actually deleted. */
	cleanup(): string[];
}

interface StoredArtifact {
	ref: ContextArtifactRef;
	content: string;
	references: Set<string>;
}

export function createInMemoryArtifactStore(): ArtifactStore {
	const artifacts = new Map<string, StoredArtifact>();
	const cleanedUp = new Set<string>();

	return {
		write(request: ArtifactWriteRequest): ArtifactRecord {
			const id = generateArtifactId(request);
			const existing = artifacts.get(id);
			if (existing) {
				cleanedUp.delete(id);
				return { ref: existing.ref, content: existing.content };
			}

			const ref = createArtifactRef(id, request);
			artifacts.set(id, { ref, content: request.content, references: new Set() });
			cleanedUp.delete(id);
			return { ref, content: request.content };
		},

		read(id: string): ArtifactRecord | MissingArtifactMarker {
			const stored = artifacts.get(id);
			if (!stored) {
				return { id, missing: true, reason: cleanedUp.has(id) ? "cleaned_up" : "not_found" };
			}
			return { ref: stored.ref, content: stored.content };
		},

		readRef(id: string): ContextArtifactRef | undefined {
			return artifacts.get(id)?.ref;
		},

		has(id: string): boolean {
			return artifacts.has(id);
		},

		addReference(id: string, holderId: string): boolean {
			const stored = artifacts.get(id);
			if (!stored) return false;
			stored.references.add(holderId);
			return true;
		},

		removeReference(id: string, holderId: string): boolean {
			const stored = artifacts.get(id);
			if (!stored) return false;
			return stored.references.delete(holderId);
		},

		referenceCount(id: string): number {
			return artifacts.get(id)?.references.size ?? 0;
		},

		cleanup(): string[] {
			const deleted: string[] = [];
			for (const [id, stored] of artifacts) {
				if (stored.references.size === 0) {
					artifacts.delete(id);
					cleanedUp.add(id);
					deleted.push(id);
				}
			}
			return deleted;
		},
	};
}

export interface FileArtifactStoreOptions {
	/** Leased session work directory where payloads and metadata live. Created on first use. */
	baseDir: string;
	/** Migrate an existing store before probing it; must remain zero-write when no legacy data exists. */
	prepareBaseDir?: () => void;
	/** Acquire the owning lease immediately before the first real store access. */
	acquireBaseDir?: () => string;
}

interface PersistedArtifactMeta {
	ref: ContextArtifactRef;
	references: string[];
}

const META_SUFFIX = ".meta.json";
const PAYLOAD_SUFFIX = ".payload";
const REFERENCES_SUFFIX = ".refs";

/**
 * Artifact ids are generated by `generateArtifactId` as a lowercase hex digest. Reject
 * anything else so a caller-supplied id (including one echoed back from model output)
 * can never be used as a path-traversal vector into `baseDir`.
 */
function isSafeArtifactId(id: string): boolean {
	return /^[0-9a-f]{1,64}$/.test(id);
}

function payloadPath(baseDir: string, id: string): string {
	return join(baseDir, `${id}${PAYLOAD_SUFFIX}`);
}

function metaPath(baseDir: string, id: string): string {
	return join(baseDir, `${id}${META_SUFFIX}`);
}

function referencesDir(baseDir: string, id: string): string {
	return join(baseDir, `${id}${REFERENCES_SUFFIX}`);
}

function referencePath(baseDir: string, id: string, holderId: string): string {
	return join(referencesDir(baseDir, id), createHash("sha256").update(holderId).digest("hex"));
}

const VALID_ARTIFACT_KINDS: ReadonlySet<ContextArtifactRef["kind"]> = new Set([
	"tool_output",
	"file_snapshot",
	"test_output",
	"diff",
	"transcript_slice",
]);

function isValidArtifactRefShape(value: unknown): value is ContextArtifactRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	return (
		typeof ref.id === "string" &&
		typeof ref.kind === "string" &&
		VALID_ARTIFACT_KINDS.has(ref.kind as ContextArtifactRef["kind"]) &&
		typeof ref.byteLength === "number" &&
		typeof ref.createdAtTurn === "number" &&
		typeof ref.reproducible === "boolean"
	);
}

/**
 * A parsed JSON value can be syntactically valid but semantically garbage (truncated
 * write, hand-edited file, future/incompatible format). Validate shape, not just parse
 * success, so a malformed sidecar can never produce an invalid ref or crash `cleanup()` --
 * it is treated as unusable/missing, the same as a sidecar that doesn't exist.
 */
function isValidPersistedArtifactMeta(value: unknown): value is PersistedArtifactMeta {
	if (typeof value !== "object" || value === null) return false;
	const meta = value as Record<string, unknown>;
	return (
		isValidArtifactRefShape(meta.ref) &&
		Array.isArray(meta.references) &&
		meta.references.every((entry) => typeof entry === "string")
	);
}

function readMeta(baseDir: string, id: string): PersistedArtifactMeta | undefined {
	const path = metaPath(baseDir, id);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isValidPersistedArtifactMeta(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeMeta(baseDir: string, id: string, meta: PersistedArtifactMeta): void {
	writeFileAtomicSync(metaPath(baseDir, id), JSON.stringify(meta));
}

/**
 * Holder markers are immutable and every reader/writer holds the artifact lock. A direct exclusive
 * create is therefore already complete before it becomes observable; a temp-file rename would add
 * two Windows filesystem operations per holder without improving the visibility contract.
 */
function writeReferenceMarker(baseDir: string, id: string, holderId: string): void {
	const path = referencePath(baseDir, id, holderId);
	mkdirSync(referencesDir(baseDir, id), { recursive: true });
	writeFileSync(path, holderId, { encoding: "utf8", flag: "wx" });
}

/** Move the legacy shared reference array to O(1)-update holder markers exactly once. */
function migratePersistedReferences(baseDir: string, id: string, meta: PersistedArtifactMeta): void {
	if (meta.references.length === 0) return;
	for (const holderId of meta.references) {
		const path = referencePath(baseDir, id, holderId);
		if (!existsSync(path)) writeReferenceMarker(baseDir, id, holderId);
	}
	meta.references = [];
	writeMeta(baseDir, id, meta);
}

/** Undefined means the marker directory could not be inspected, so cleanup must fail closed. */
function referenceMarkerCount(baseDir: string, id: string): number | undefined {
	const dir = referencesDir(baseDir, id);
	if (!existsSync(dir)) return 0;
	try {
		return readdirSync(dir, { withFileTypes: true }).length;
	} catch {
		return undefined;
	}
}

/**
 * Filesystem-backed `ArtifactStore`: payload and metadata (including reference holder ids)
 * are written to `baseDir` so content, ref fields, and cleanup-protecting references all survive
 * recreating the store (e.g. across a process restart against the same directory) -- unlike the
 * in-memory store, which loses everything when the instance is dropped. Each artifact has a small
 * metadata sidecar plus one hashed holder marker per active reference. Marker updates are O(1) and
 * every lifecycle mutation shares the artifact lock, so foreground/background processes cannot
 * lose ownership through a shared-array read-modify-write race.
 *
 * The one thing that does NOT survive recreation: the missing-artifact reason
 * distinction. A fresh instance has no in-memory record of which ids it personally
 * cleaned up, so a previously-cleaned-up id reads back as "not_found" rather than
 * "cleaned_up" after a restart. This still always returns an explicit missing marker,
 * never fabricated or empty content -- it only affects which of the two reason codes is
 * reported.
 */
export function createFileArtifactStore(options: FileArtifactStoreOptions): ArtifactStore {
	const baseDir = options.baseDir;
	const cleanedUpThisInstance = new Set<string>();
	let acquiredBaseDir: string | undefined;
	let preparedBaseDir = false;
	const ensureBaseDir = (): string => {
		preparedBaseDir = true;
		acquiredBaseDir ??= options.acquireBaseDir?.() ?? baseDir;
		mkdirSync(acquiredBaseDir, { recursive: true });
		return acquiredBaseDir;
	};
	const ensureExistingBaseDir = (): boolean => {
		if (!preparedBaseDir) {
			options.prepareBaseDir?.();
			preparedBaseDir = true;
		}
		if (!existsSync(baseDir)) return false;
		ensureBaseDir();
		return true;
	};
	const mutateReference = (id: string, holderId: string, mutate: (path: string) => boolean): boolean => {
		if (!isSafeArtifactId(id) || !ensureExistingBaseDir()) return false;
		try {
			return withFileLockSync(metaPath(baseDir, id), () => {
				const meta = readMeta(baseDir, id);
				if (!meta) return false;
				migratePersistedReferences(baseDir, id, meta);
				return mutate(referencePath(baseDir, id, holderId));
			});
		} catch {
			return false;
		}
	};

	return {
		write(request: ArtifactWriteRequest): ArtifactRecord {
			ensureBaseDir();
			const id = generateArtifactId(request);
			return withFileLockSync(metaPath(baseDir, id), () => {
				const existingMeta = readMeta(baseDir, id);
				const existingPayloadPath = payloadPath(baseDir, id);
				if (existingMeta && existsSync(existingPayloadPath)) {
					cleanedUpThisInstance.delete(id);
					return { ref: existingMeta.ref, content: readFileSync(existingPayloadPath, "utf8") };
				}

				const ref = createArtifactRef(id, request);
				writeFileAtomicSync(payloadPath(baseDir, id), request.content);
				writeMeta(baseDir, id, { ref, references: [] });
				cleanedUpThisInstance.delete(id);
				return { ref, content: request.content };
			});
		},

		read(id: string): ArtifactRecord | MissingArtifactMarker {
			if (!isSafeArtifactId(id)) return { id, missing: true, reason: "not_found" };
			if (!ensureExistingBaseDir()) return { id, missing: true, reason: "not_found" };
			try {
				return withFileLockSync(metaPath(baseDir, id), () => {
					const meta = readMeta(baseDir, id);
					const pPath = payloadPath(baseDir, id);
					if (!meta || !existsSync(pPath)) {
						return {
							id,
							missing: true,
							reason: cleanedUpThisInstance.has(id) ? "cleaned_up" : "not_found",
						};
					}
					return { ref: meta.ref, content: readFileSync(pPath, "utf8") };
				});
			} catch {
				return { id, missing: true, reason: cleanedUpThisInstance.has(id) ? "cleaned_up" : "not_found" };
			}
		},

		readRef(id: string): ContextArtifactRef | undefined {
			if (!isSafeArtifactId(id)) return undefined;
			if (!ensureExistingBaseDir()) return undefined;
			const meta = readMeta(baseDir, id);
			if (!meta || !existsSync(payloadPath(baseDir, id))) return undefined;
			return meta.ref;
		},

		has(id: string): boolean {
			if (!isSafeArtifactId(id)) return false;
			if (!ensureExistingBaseDir()) return false;
			return readMeta(baseDir, id) !== undefined && existsSync(payloadPath(baseDir, id));
		},

		addReference(id: string, holderId: string): boolean {
			return mutateReference(id, holderId, (path) => {
				if (!existsSync(payloadPath(baseDir, id))) return false;
				if (existsSync(path)) return readFileSync(path, "utf8") === holderId;
				writeReferenceMarker(baseDir, id, holderId);
				return true;
			});
		},

		removeReference(id: string, holderId: string): boolean {
			return mutateReference(id, holderId, (path) => {
				if (!existsSync(path) || readFileSync(path, "utf8") !== holderId) return false;
				unlinkSync(path);
				try {
					rmdirSync(referencesDir(baseDir, id));
				} catch {}
				return true;
			});
		},

		referenceCount(id: string): number {
			if (!isSafeArtifactId(id)) return 0;
			if (!ensureExistingBaseDir()) return 0;
			try {
				return withFileLockSync(metaPath(baseDir, id), () => {
					const meta = readMeta(baseDir, id);
					if (!meta) return 0;
					migratePersistedReferences(baseDir, id, meta);
					return referenceMarkerCount(baseDir, id) ?? 0;
				});
			} catch {
				return 0;
			}
		},

		cleanup(): string[] {
			const deleted: string[] = [];
			if (!ensureExistingBaseDir()) return deleted;
			for (const entry of readdirSync(baseDir)) {
				if (!entry.endsWith(META_SUFFIX)) continue;
				const id = entry.slice(0, -META_SUFFIX.length);
				if (!isSafeArtifactId(id)) continue;
				try {
					withFileLockSync(metaPath(baseDir, id), () => {
						const meta = readMeta(baseDir, id);
						if (!meta) return;
						migratePersistedReferences(baseDir, id, meta);
						const references = referenceMarkerCount(baseDir, id);
						if (references === undefined || references > 0) return;
						try {
							unlinkSync(metaPath(baseDir, id));
						} catch {
							return;
						}
						try {
							unlinkSync(payloadPath(baseDir, id));
						} catch {
							// Payload already gone; metadata removal above is what matters for reachability.
						}
						try {
							rmdirSync(referencesDir(baseDir, id));
						} catch {}
						cleanedUpThisInstance.add(id);
						deleted.push(id);
					});
				} catch {}
			}
			return deleted;
		},
	};
}
