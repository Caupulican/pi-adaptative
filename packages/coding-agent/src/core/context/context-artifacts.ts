/**
 * Artifact store abstraction (Phase 2): stable refs for raw large payloads, kept out of
 * band from prompt context. This module defines the `ArtifactStore` interface plus two
 * implementations: an in-memory one for tests, and `createFileArtifactStore` (session-
 * scoped, filesystem-backed). A SQLite-backed implementation waits until the Phase M0
 * storage-authority/location/concurrency decisions are accepted (see
 * docs/context-management-rework/memory-architecture.md).
 *
 * `createFileArtifactStore` is wired into live grep/find tool construction in
 * agent-session.ts (session-scoped under `<agentDir>/context-artifacts/<sessionId>/`).
 * References are registered at pack time and released when context-gc evicts the
 * corresponding grep/find tool result (opportunistic, conservative cleanup), with a
 * best-effort dispose-time sweep for zero-reference artifacts. Payloads are retrievable
 * out of band via the artifact_retrieve tool (context/artifact-retrieval.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	return createHash("sha256")
		.update(
			[
				request.kind,
				request.toolName ?? "",
				request.command ?? "",
				request.path ?? "",
				request.sessionEntryId ?? "",
				String(request.createdAtTurn),
				String(request.reproducible),
				request.content,
			].join("\0"),
		)
		.digest("hex")
		.slice(0, 24);
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

			const ref: ContextArtifactRef = {
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
	/** Directory the store persists artifact payloads and metadata under. Created if missing. */
	baseDir: string;
}

interface PersistedArtifactMeta {
	ref: ContextArtifactRef;
	references: string[];
}

const META_SUFFIX = ".meta.json";
const PAYLOAD_SUFFIX = ".payload";

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
	writeFileSync(metaPath(baseDir, id), JSON.stringify(meta), "utf8");
}

/**
 * Filesystem-backed `ArtifactStore`: payload and metadata (including reference holder ids)
 * are written to `baseDir` so content, ref fields, and cleanup-protecting references all
 * survive recreating the store (e.g. across a process restart against the same
 * directory) -- unlike the in-memory store, which loses everything when the instance is
 * dropped. No SQLite or other index is used; each artifact's metadata is a small sidecar
 * JSON file next to its payload file, per the "keep SQLite out of scope unless a minimal
 * metadata shape is unavoidable" constraint for this slice.
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
	mkdirSync(baseDir, { recursive: true });
	const cleanedUpThisInstance = new Set<string>();

	return {
		write(request: ArtifactWriteRequest): ArtifactRecord {
			const id = generateArtifactId(request);
			const existingMeta = readMeta(baseDir, id);
			const existingPayloadPath = payloadPath(baseDir, id);
			if (existingMeta && existsSync(existingPayloadPath)) {
				cleanedUpThisInstance.delete(id);
				return { ref: existingMeta.ref, content: readFileSync(existingPayloadPath, "utf8") };
			}

			const ref: ContextArtifactRef = {
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
			writeFileSync(payloadPath(baseDir, id), request.content, "utf8");
			writeMeta(baseDir, id, { ref, references: [] });
			cleanedUpThisInstance.delete(id);
			return { ref, content: request.content };
		},

		read(id: string): ArtifactRecord | MissingArtifactMarker {
			if (!isSafeArtifactId(id)) return { id, missing: true, reason: "not_found" };
			const meta = readMeta(baseDir, id);
			const pPath = payloadPath(baseDir, id);
			if (!meta || !existsSync(pPath)) {
				return { id, missing: true, reason: cleanedUpThisInstance.has(id) ? "cleaned_up" : "not_found" };
			}
			return { ref: meta.ref, content: readFileSync(pPath, "utf8") };
		},

		readRef(id: string): ContextArtifactRef | undefined {
			if (!isSafeArtifactId(id)) return undefined;
			const meta = readMeta(baseDir, id);
			if (!meta || !existsSync(payloadPath(baseDir, id))) return undefined;
			return meta.ref;
		},

		has(id: string): boolean {
			if (!isSafeArtifactId(id)) return false;
			return readMeta(baseDir, id) !== undefined && existsSync(payloadPath(baseDir, id));
		},

		addReference(id: string, holderId: string): boolean {
			if (!isSafeArtifactId(id)) return false;
			const meta = readMeta(baseDir, id);
			if (!meta || !existsSync(payloadPath(baseDir, id))) return false;
			if (!meta.references.includes(holderId)) {
				meta.references.push(holderId);
				writeMeta(baseDir, id, meta);
			}
			return true;
		},

		removeReference(id: string, holderId: string): boolean {
			if (!isSafeArtifactId(id)) return false;
			const meta = readMeta(baseDir, id);
			if (!meta) return false;
			const index = meta.references.indexOf(holderId);
			if (index === -1) return false;
			meta.references.splice(index, 1);
			writeMeta(baseDir, id, meta);
			return true;
		},

		referenceCount(id: string): number {
			if (!isSafeArtifactId(id)) return 0;
			return readMeta(baseDir, id)?.references.length ?? 0;
		},

		cleanup(): string[] {
			const deleted: string[] = [];
			for (const entry of readdirSync(baseDir)) {
				if (!entry.endsWith(META_SUFFIX)) continue;
				const id = entry.slice(0, -META_SUFFIX.length);
				if (!isSafeArtifactId(id)) continue;
				const meta = readMeta(baseDir, id);
				if (!meta || meta.references.length > 0) continue;
				try {
					unlinkSync(metaPath(baseDir, id));
				} catch {
					continue;
				}
				try {
					unlinkSync(payloadPath(baseDir, id));
				} catch {
					// Payload already gone; metadata removal above is what matters for reachability.
				}
				cleanedUpThisInstance.add(id);
				deleted.push(id);
			}
			return deleted;
		},
	};
}
