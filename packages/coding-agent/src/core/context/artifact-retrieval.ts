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

import { DEFAULT_MAX_BYTES, type TruncationResult, truncateHead, truncateTail } from "@caupulican/pi-agent-core/node";
import type { ArtifactStore } from "./context-artifacts.ts";
import { isMissingArtifactMarker, type MissingArtifactReason } from "./context-artifacts.ts";
import type { ContextArtifactRef } from "./context-item.ts";

export type ArtifactRetrievalMode = "metadata" | "head" | "tail";

export const DEFAULT_RETRIEVAL_MAX_LINES = 200;

/** Hard ceilings: a caller-requested maxLines/maxBytes can never exceed these. */
export const MAX_RETRIEVAL_LINES = 2000;
export const MAX_RETRIEVAL_BYTES = DEFAULT_MAX_BYTES;

export interface ArtifactRetrievalRequest {
	artifactId: string;
	mode?: ArtifactRetrievalMode;
	maxLines?: number;
	maxBytes?: number;
}

export type ArtifactRetrievalResult =
	| { found: false; missingReason: MissingArtifactReason }
	| { found: true; mode: "metadata"; ref: ContextArtifactRef }
	| { found: true; mode: "head" | "tail"; ref: ContextArtifactRef; slice: string; truncation: TruncationResult };

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

	const truncationOptions = {
		maxLines: clampToHardCeiling(request.maxLines, DEFAULT_RETRIEVAL_MAX_LINES, MAX_RETRIEVAL_LINES),
		maxBytes: clampToHardCeiling(request.maxBytes, DEFAULT_MAX_BYTES, MAX_RETRIEVAL_BYTES),
	};
	const truncation =
		mode === "tail"
			? truncateTail(record.content, truncationOptions)
			: truncateHead(record.content, truncationOptions);

	return { found: true, mode, ref: record.ref, slice: truncation.content, truncation };
}
