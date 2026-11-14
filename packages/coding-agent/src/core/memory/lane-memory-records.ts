/**
 * What a delegated lane's memory read is made of: its whole source-labelled records (an OKF or history hit, an
 * approved summary covering the hits), what each record takes out of the lane's allowance, and the fixed wording
 * that states what a read could not attach. The memory controller reads the sources and composes the snapshot
 * from these.
 */

import { estimateLineCount, estimateTokensFromText } from "../context/context-item.ts";
import {
	LANE_READ_MAX_ESTIMATED_TOKENS,
	type MemoryPromptBudget,
	resolveMemoryPromptBudget,
} from "../context/memory-prompt-budget.ts";
import type { MemorySearchResult } from "../context/memory-provider-contract.ts";
import type { MemoryRetrievalReport } from "../context/memory-retrieval.ts";
import type { MemoryTierCandidate } from "../context/memory-tier-composer.ts";
import { TRANSCRIPT_MEMORY_PROVIDER_ID } from "../context/transcript-memory-provider.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { boundedTextPreview } from "../text-preview.ts";
import { TRANSCRIPT_RECALL_MAX_ERROR_CHARS } from "./providers/transcript-recall-worker-protocol.ts";
import { utf8ByteLength } from "./transcript-memory-contracts.ts";
import {
	describeSummaryReference,
	reasonSentence,
	type TranscriptSummaryReference,
} from "./transcript-source-tools.ts";
import type { LaneMemoryCapacity, WorkerMemorySourceAnswer } from "./worker-memory-tools.ts";

export interface LaneMemoryCandidate extends MemoryTierCandidate {
	readonly sourceHandles: readonly string[];
}

/** The tier-composer source label of a transcript candidate (`memory:<providerId>`). */
export const TRANSCRIPT_SOURCE_LABEL = `memory:${TRANSCRIPT_MEMORY_PROVIDER_ID}`;

/**
 * Why a delegated lane's conversation history could not be searched, or "" when it could (including with no
 * hit). A failure is stated, never rendered as an empty page; hits themselves are admitted as whole records.
 */
export function laneHistoryStatus(report: MemoryRetrievalReport): string {
	const providerReport = report.providerReports.find((entry) => entry.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID);
	// The provider's own wording, bounded to the cap every other recall diagnostic reason carries.
	const bounded = (text: string) => boundedTextPreview(text, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
	if (providerReport?.status === "failed") {
		return `Conversation history was not searched (${bounded(providerReport.error ?? "unknown failure")}).`;
	}
	if (providerReport?.status === "blocked") {
		return `Conversation history was not searched (blocked: ${bounded(providerReport.rejectionReasons.join(", "))}).`;
	}
	return "";
}

/** The stated reason a delegated lane's memory read attached nothing, from the budget owner's own reason code. */
export function laneConstraintText(reason: string | undefined, capacityKnown: boolean): string {
	const detail =
		!capacityKnown || reason === "missing_context_window"
			? "this worker's request capacity is unknown (it has sent no request yet, or its model declares no context window)"
			: reason === "no_token_allowance"
				? "this worker has no token allowance left"
				: reason === "no_context_headroom"
					? "this worker's request has no room left in its context window"
					: reason === "memory_block_cannot_fit_minimum_line"
						? "the room this worker has left cannot hold one memory line"
						: `the memory budget is disabled (${reason ?? "unspecified"})`;
	return `Memory is constrained: ${detail}, so no memory was attached. Read project files directly, or call memory_read again when the worker has more room.`;
}

/** What one whole record takes out of a lane's allowance: its text, the blank line that joins it, and its lines. */
export function laneRecordReserve(text: string): { bytes: number; estimatedTokens: number; lines: number } {
	return {
		bytes: utf8ByteLength(text) + utf8ByteLength(LANE_RECORD_SEPARATOR),
		estimatedTokens: estimateTokensFromText(text),
		lines: estimateLineCount(text) + 1,
	};
}

export function laneOmissionNote(parts: readonly string[]): string {
	return `[Not attached, over this worker's remaining context room: ${parts.join("; ")}. Call memory_read again with a narrower query.]`;
}

/** Share of a delegated lane's memory allowance standing memory may take; the query-relevant records get the rest. */
export const LANE_STANDING_BUDGET_SHARE = 0.5;
/** Share of what remains after standing memory that the history frontier may take. */
export const LANE_FRONTIER_BUDGET_SHARE = 0.5;
export const LANE_FRONTIER_HEADING =
	"History frontier (summaries of earlier conversation; pass a txn: handle as ref to expand one):";
export const LANE_HANDLE_HINT =
	"Pass a bracketed handle back as ref: a tx: handle opens that source's exact text, a txn: handle expands that summary one level.";
export const LANE_STANDING_NOTE = "[Read-only snapshot for a delegated worker.]";
export const LANE_WRAPPER = wrapUntrustedText("", "worker-memory", { nonce: "0".repeat(32) });
export const LANE_RECORD_SEPARATOR = "\n\n";
export const LANE_NO_MEMORY_TEXT = "No relevant standing memory was found.";
export const LANE_NO_HISTORY_TEXT = "No matching conversation history was found.";
/** A chat zoom in a session that lends memory reads but does not hold the owner's history: a stated refusal. */
export const LANE_HISTORY_NOT_HELD_TEXT =
	"Conversation history is not available in this session (it does not hold the owner's history), so there is no chat to zoom. Use memory_read without a zoom, or read project files directly.";
export const LANE_MEMORY_UNAVAILABLE_TEXT =
	"Memory is not available in this session (it holds neither the owner's history nor the owner's memory, or memory failed to initialize or has shut down). Read project files directly.";
/**
 * A worker source read's refusal: the typed `memory_source_<status>` token unchanged, the reason rendered by the
 * one history refusal renderer, so a worker refusal reads like the root's.
 */
export function laneSourceRefusal(status: string, reason: string): WorkerMemorySourceAnswer {
	return { ok: false, status, text: `memory_source_${status}: ${reasonSentence(reason)}` };
}

/** The tier-composer source label of an approved summary covering a lane's history hits. */
export const LANE_SUMMARY_SOURCE_LABEL = "memory:history-summary";
/** Transcript sources one delegated lane may hold open at a time; the oldest admission is dropped first. */
export const MAX_ADMITTED_LANE_SOURCES = 512;
/** The smallest source page worth delivering to a lane; below it the lane is told it has no room instead. */
export const LANE_MIN_SOURCE_PAGE_BYTES = 256;
export const LANE_SOURCE_OVER_ROOM_TEXT =
	"[Not attached: even a minimal page of this source does not fit this worker's remaining context room. Call memory_read with this ref again when the worker has more room.]";
export const LANE_EXPANSION_OVER_ROOM_TEXT =
	"[Not attached: this summary's expansion does not fit this worker's remaining context room. Call memory_read with this ref again when the worker has more room.]";
export const LANE_CHAT_OVER_ROOM_TEXT =
	"[Not attached: this chat page does not fit this worker's remaining context room. Call memory_read with this zoom again when the worker has more room.]";

/**
 * One approved summary covering a lane's history hits, as a whole record: the full approved text, or, when that
 * cannot fit the lane's room, its handle and coverage alone (still expandable). Ranked with the best hit it covers.
 */
export function laneSummaryCandidate(
	summary: TranscriptSummaryReference,
	hitScores: ReadonlyMap<string, number>,
): LaneMemoryCandidate {
	// The root's own heading for the record, so a root read and a worker read report it the same way.
	const heading = describeSummaryReference(summary);
	return {
		id: summary.handle,
		sourceHandles: [summary.handle, ...summary.covers],
		tier: "evidence_pointer",
		sourceLabel: LANE_SUMMARY_SOURCE_LABEL,
		summary: `${heading}\n${summary.text}`,
		pointerSummary: `${heading} (summary text omitted: over this worker's remaining room; pass the handle as ref to expand it)`,
		score: Math.max(0, ...summary.covers.map((handle) => hitScores.get(handle) ?? 0)),
	};
}

/** A delegated lane's search hit as a composer candidate; OKF documents also carry a whole pointer form. */
export function laneCandidate(result: MemorySearchResult, tier: MemoryTierCandidate["tier"]): LaneMemoryCandidate {
	const { item } = result;
	const heading = `[OKF ${item.title ?? item.id}] ${item.summary}`;
	const okf = tier !== "evidence_pointer";
	return {
		id: item.id,
		sourceHandles: item.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID ? item.refs.map((ref) => ref.itemId) : [],
		tier,
		sourceLabel: `memory:${item.providerId}`,
		summary: okf ? `${heading}\n${item.content ?? ""}` : item.summary,
		...(okf ? { pointerSummary: `${heading} (full document omitted: over this worker's remaining room)` } : {}),
		score: result.score,
		...(item.stale !== undefined ? { stale: item.stale } : {}),
		...(item.conflict !== undefined ? { conflict: item.conflict } : {}),
	};
}

/** The allowance a delegated lane's read may fill, resolved by the one budget owner on the lane's own request. */
export function laneMemoryBudget(
	configuredMaxResults: number,
	lane: LaneMemoryCapacity | undefined,
): MemoryPromptBudget {
	return resolveMemoryPromptBudget({
		contextWindow: lane?.contextWindow,
		configuredMaxResults,
		ceilingTokens: LANE_READ_MAX_ESTIMATED_TOKENS,
		...(lane
			? {
					currentPromptTokens: lane.currentPromptTokens,
					reservedTokens: lane.reservedTokens,
					...(lane.remainingTokenAllowance !== undefined
						? { remainingTokenAllowance: lane.remainingTokenAllowance }
						: {}),
				}
			: {}),
	});
}
