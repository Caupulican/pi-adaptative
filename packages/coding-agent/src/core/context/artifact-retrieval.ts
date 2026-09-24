/**
 * Bounded artifact retrieval (Phase 8-style helper landing early, per D2b): resolve an
 * artifact id shown in a "Full output: artifact tool-output:<id>" notice back into a
 * small, useful slice. Per tool-output-artifacts.md's retrieval behavior: retrieve the
 * smallest useful slice by default (metadata, or a bounded head/tail).
 *
 * Bounds are hard limits, not just defaults: a caller-provided `maxLines`/`maxBytes` is
 * clamped to `MAX_RETRIEVAL_LINES`/`MAX_RETRIEVAL_BYTES` before use, so no caller --
 * including a future agent-facing tool wrapper -- can force a large artifact to be fully
 * rehydrated in one call by simply requesting a larger bound. A small artifact that
 * already fits within the bound is still returned in full; the guarantee is "never more
 * than the configured hard bounds," not "never the whole artifact."
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "@caupulican/pi-agent-core/truncate";
import type { ArtifactStore } from "./context-artifacts.ts";
import { isMissingArtifactMarker, type MissingArtifactReason } from "./context-artifacts.ts";
import type { ContextArtifactRef } from "./context-item.ts";

export type ArtifactRetrievalMode = "metadata" | "head" | "tail" | "offset";

export const DEFAULT_RETRIEVAL_MAX_LINES = 200;

/** Hard ceilings: a caller-requested maxLines/maxBytes can never exceed these. */
export const MAX_RETRIEVAL_LINES = 2000;
export const MAX_RETRIEVAL_BYTES = DEFAULT_MAX_BYTES;

export interface ArtifactRetrievalRequest {
	artifactId: string;
	mode?: ArtifactRetrievalMode;
	maxLines?: number;
	maxBytes?: number;
	/** For `offset`: the 1-based line the slice starts at. */
	offset?: number;
}

export type ArtifactSlice = {
	mode: "head" | "tail" | "offset";
	slice: string;
	truncation: TruncationResult;
	/** For `offset`: the 1-based line the slice starts at. */
	startLine?: number;
};

export type ArtifactRetrievalResult =
	| { found: false; missingReason: MissingArtifactReason }
	| { found: true; mode: "metadata"; ref: ContextArtifactRef }
	| ({ found: true; ref: ContextArtifactRef } & ArtifactSlice);

function clampToHardCeiling(requested: number | undefined, fallback: number, hardCeiling: number): number {
	const candidate = requested ?? fallback;
	if (candidate <= 0) return 0;
	return Math.min(candidate, hardCeiling);
}

/**
 * Resolve `request.artifactId` against `store` and return a bounded slice. `maxLines`/
 * `maxBytes` are hard-clamped to `MAX_RETRIEVAL_LINES`/`MAX_RETRIEVAL_BYTES` regardless of
 * what the caller requests -- see the module doc comment for the exact guarantee.
 */
export function retrieveArtifactSlice(
	store: ArtifactStore,
	request: ArtifactRetrievalRequest,
): ArtifactRetrievalResult {
	const record = store.read(request.artifactId);
	if (isMissingArtifactMarker(record)) {
		return { found: false, missingReason: record.reason };
	}

	const mode = request.mode ?? "head";
	if (mode === "metadata") {
		return { found: true, mode: "metadata", ref: record.ref };
	}
	return { found: true, ref: record.ref, ...sliceText(record.content, { ...request, mode }) };
}

/** A bounded head, tail or offset slice of `content`; bounds are hard-clamped (see the module doc). */
export function sliceText(content: string, request: Omit<ArtifactRetrievalRequest, "artifactId">): ArtifactSlice {
	const mode = request.mode === "tail" || request.mode === "offset" ? request.mode : "head";
	const truncationOptions = {
		maxLines: clampToHardCeiling(request.maxLines, DEFAULT_RETRIEVAL_MAX_LINES, MAX_RETRIEVAL_LINES),
		maxBytes: clampToHardCeiling(request.maxBytes, DEFAULT_MAX_BYTES, MAX_RETRIEVAL_BYTES),
	};
	if (mode === "tail") {
		const truncation = truncateTail(content, truncationOptions);
		return { mode, slice: truncation.content, truncation };
	}
	if (mode === "offset") {
		const lines = content.split("\n");
		const startLine = Math.min(Math.max(1, Math.floor(request.offset ?? 1)), Math.max(1, lines.length));
		const truncation = truncateHead(lines.slice(startLine - 1).join("\n"), truncationOptions);
		// The slice's own counts, restated against the whole text so "of N lines" stays true.
		return { mode, slice: truncation.content, truncation: { ...truncation, totalLines: lines.length }, startLine };
	}
	const truncation = truncateHead(content, truncationOptions);
	return { mode, slice: truncation.content, truncation };
}

/** What context GC recorded next to an original it packed (`<key>.json` in the session's GC store). */
export interface ContextOriginalMetadata {
	readonly tool: string;
	readonly reason: string;
	readonly chars: number;
	readonly command?: string;
	readonly path?: string;
}

/** A context-GC key: the first 24 hex characters of the original's content hash, nothing else. */
export const CONTEXT_ORIGINAL_KEY = /^[0-9a-f]{24}$/;

export type ContextOriginalResult =
	| { found: false; reason: "invalid_key" | "expired" }
	| { found: true; text: string; metadata: ContextOriginalMetadata | undefined };

/**
 * Resolve a packed stub's key inside the owning session's GC store. The key must be exactly 24 hex
 * characters, so it can only name a file directly inside `gcDir`; a reclaimed original is `expired`.
 */
export function readContextOriginal(gcDir: string, key: string): ContextOriginalResult {
	if (!CONTEXT_ORIGINAL_KEY.test(key)) return { found: false, reason: "invalid_key" };
	const textPath = join(gcDir, `${key}.txt`);
	if (!existsSync(textPath)) return { found: false, reason: "expired" };
	let text: string;
	try {
		text = readFileSync(textPath, "utf8");
	} catch {
		return { found: false, reason: "expired" };
	}
	let metadata: ContextOriginalMetadata | undefined;
	try {
		const parsed = JSON.parse(readFileSync(join(gcDir, `${key}.json`), "utf8")) as Partial<ContextOriginalMetadata>;
		if (typeof parsed.tool === "string" && typeof parsed.reason === "string" && typeof parsed.chars === "number") {
			metadata = {
				tool: parsed.tool,
				reason: parsed.reason,
				chars: parsed.chars,
				...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
				...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
			};
		}
	} catch {
		// Originals packed before the sidecar existed have none: the text is still the original.
	}
	return { found: true, text, metadata };
}
