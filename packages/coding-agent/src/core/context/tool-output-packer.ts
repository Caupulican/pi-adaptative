/**
 * Tool output digesting and packing (Phase 3): "measure -> digest/preview/artifact ->
 * prompt item", per tool-output-artifacts.md's boundary rule. Large raw tool output is
 * captured to an artifact BEFORE truncation, so the artifact holds the exact raw payload;
 * the model only ever sees the bounded preview plus an artifact reference.
 *
 * This module is pure with respect to wiring: it takes an `ArtifactStore` by dependency
 * injection and does not know about sessions, transcripts, or prompt construction. A tool
 * (grep/find) that never passes an `ArtifactStore` gets byte-for-byte its prior behavior --
 * packing is opt-in per call site, not a global switch.
 */

import { type TruncationOptions, type TruncationResult, truncateHead } from "@caupulican/pi-agent-core/node";
import type { ArtifactStore } from "./context-artifacts.ts";

export interface PackToolOutputRequest {
	toolName: string;
	command?: string;
	path?: string;
	rawContent: string;
	sessionEntryId?: string;
	/**
	 * Turn number for artifact capture identity. Real session-turn wiring lands in a later
	 * slice; callers that don't track turns yet may pass 0.
	 */
	createdAtTurn?: number;
	/** Whether re-running the same tool call would reproduce this content. Default: true. */
	reproducible?: boolean;
	truncation?: TruncationOptions;
}

export interface PackedToolOutput {
	/**
	 * Bounded preview content -- exactly what `truncateHead` alone would have produced.
	 * No footer/notice text is appended here; callers already have their own per-tool
	 * footer conventions (grep's vs. find's bracket ordering differ) and own formatting
	 * the artifact notice into their own notice list via `formatArtifactNotice`.
	 */
	content: string;
	truncation: TruncationResult;
	/** Present only if packing succeeded and the artifact is protected from cleanup. */
	artifactId?: string;
	packed: boolean;
}

/** Footer notice text for a packed artifact, for callers to fold into their own notices. */
export function formatArtifactNotice(artifactId: string): string {
	return `Full output: artifact tool-output:${artifactId}`;
}

/**
 * Measure `request.rawContent`; if it fits within the caps, return it unchanged (small
 * output stays exactly as readable as before this module existed). If it's oversized and
 * an `ArtifactStore` is provided, capture the exact raw payload as an artifact first, then
 * return the same bounded preview `truncateHead` would have produced anyway.
 *
 * Fails closed: if the artifact write succeeds but registering `holderId` as a reference
 * fails (`addReference` returns false), the artifact is not claimed in the result at all --
 * the caller falls back to the bounded/truncated content exactly as if no store had been
 * provided, since an unprotected artifact could be cleaned up at any time.
 */
export function packToolOutput(
	request: PackToolOutputRequest,
	artifactStore: ArtifactStore | undefined,
	holderId: string,
): PackedToolOutput {
	const truncation = truncateHead(request.rawContent, request.truncation);

	if (!truncation.truncated || !artifactStore) {
		return { content: truncation.content, truncation, packed: false };
	}

	const { ref } = artifactStore.write({
		kind: "tool_output",
		content: request.rawContent,
		toolName: request.toolName,
		command: request.command,
		path: request.path,
		sessionEntryId: request.sessionEntryId,
		createdAtTurn: request.createdAtTurn ?? 0,
		reproducible: request.reproducible ?? true,
	});

	if (!artifactStore.addReference(ref.id, holderId)) {
		return { content: truncation.content, truncation, packed: false };
	}

	return { content: truncation.content, truncation, artifactId: ref.id, packed: true };
}

export interface BroadQueryTracker {
	/** Record one more broad occurrence of `key`; returns the cumulative count including this one. */
	recordBroadQuery(key: string): number;
}

export function createInMemoryBroadQueryTracker(): BroadQueryTracker {
	const counts = new Map<string, number>();
	return {
		recordBroadQuery(key: string): number {
			const next = (counts.get(key) ?? 0) + 1;
			counts.set(key, next);
			return next;
		},
	};
}

/** Normalize a search-tool call into a stable repetition key: same query, same broadness. */
export function normalizeBroadQueryKey(input: {
	toolName: string;
	pattern?: string;
	path?: string;
	glob?: string;
}): string {
	return [input.toolName, input.pattern ?? "", input.path ?? "", input.glob ?? ""].join("␟");
}

const REPEATED_BROAD_QUERY_THRESHOLD = 2;

/**
 * When a broad-query condition (match/result limit hit, or byte truncation) repeats for
 * the same normalized query, produce a compact "do not repeat" style note. This is only
 * the Phase 3 signal; the durable invalidation ledger (supersession/expiry rules) is
 * Phase 6 per implementation-phases.md.
 */
export function broadQueryInvalidationNote(
	tracker: BroadQueryTracker | undefined,
	key: string,
	humanQueryDescription: string,
): string | undefined {
	if (!tracker) return undefined;
	const count = tracker.recordBroadQuery(key);
	if (count < REPEATED_BROAD_QUERY_THRESHOLD) return undefined;
	return `Do not repeat: ${humanQueryDescription} has produced broad/truncated results ${count} times in this session. Narrow the path/glob/pattern.`;
}
