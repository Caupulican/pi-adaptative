/**
 * Read-only presentation of recoverable history for the model-facing surfaces: the root `memory` tool
 * (`history_search`, `history_source`, `history_expand`) and the worker `memory_read` broker. One renderer and one
 * outcome shape, so a root read and an admitted worker read report the same facts the same way.
 *
 * Every non-ok outcome carries the reader's typed status and reason verbatim. "pending", "unavailable",
 * "not_found", "stale_snapshot" and the rest stay distinct; nothing here turns a failure into an empty
 * success. Historical text is untrusted evidence and always leaves wrapped in the untrusted boundary.
 */

import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import {
	formatTranscriptSourceHandle,
	parseTranscriptNodeHandle,
	parseTranscriptSourceHandle,
	type TranscriptCoverage,
	type TranscriptReadUnavailable,
	type TranscriptReadUnavailableStatus,
	type TranscriptSearchHit,
	type TranscriptSourceReader,
	type TranscriptSourceRef,
	type TranscriptSourceSpan,
} from "./transcript-memory-contracts.ts";

/** UTF-8 bytes of exact source text returned by one `history_source` page. */
export const TRANSCRIPT_SOURCE_PAGE_BYTES = 8_192;
export const TRANSCRIPT_HISTORY_DEFAULT_RESULTS = 5;
export const TRANSCRIPT_HISTORY_MAX_RESULTS = 10;
export const TRANSCRIPT_HISTORY_MAX_QUERY_CHARS = 4_096;

const HISTORY_UNTRUSTED_SOURCE = "memory:history";

/** Typed reader statuses plus the two request-shape failures this layer can name itself. */
export type TranscriptToolStatus = TranscriptReadUnavailableStatus | "invalid_handle" | "invalid_request";

export type TranscriptToolOutcome =
	| { ok: true; text: string; details: Record<string, unknown> }
	| {
			ok: false;
			status: TranscriptToolStatus;
			reason: string;
			text: string;
			/**
			 * On a `stale_snapshot` source read whose entry and part still exist: the `tx:` handle of the current
			 * source at that position (a handle only, never text), for a fresh exact read. Typed, never parsed.
			 */
			currentHandle?: string;
	  };

/**
 * A refusal reason as one sentence: capitalised and ending in a full stop. Reasons come from many owners (the
 * reader, the catalog, the coordinator, an error message); every rendering of one shows it in this form.
 */
export function reasonSentence(reason: string): string {
	const text = reason.trim();
	if (text === "") return text;
	const capitalised = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
	return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The one refusal rendering: the typed status token stays exactly as given, the reason is one sentence. */
function failure(status: TranscriptToolStatus, reason: string, currentHandle?: string): TranscriptToolOutcome {
	const sentence = reasonSentence(reason);
	return {
		ok: false,
		status,
		reason: sentence,
		text: `Error: transcript history ${status}: ${sentence}`,
		...(currentHandle !== undefined ? { currentHandle } : {}),
	};
}

/**
 * A reader refusal. A stale source read that names the current source at its position says so in the reason (the
 * handle, never text) and carries it as `currentHandle`, so recovery is one fresh exact read.
 */
function unavailable(result: TranscriptReadUnavailable): TranscriptToolOutcome {
	if (result.status !== "stale_snapshot" || result.currentRef === undefined)
		return failure(result.status, result.reason);
	const currentHandle = formatTranscriptSourceHandle(result.currentRef);
	return failure(
		result.status,
		`${reasonSentence(result.reason)} Current source at this position: [${currentHandle}]`,
		currentHandle,
	);
}

/** Role label of a span; a harness-synthesized message reads `assistant(host)`, never as model output. */
export function describeTranscriptRole(span: TranscriptSourceSpan): string {
	return span.origin === "host" ? `${span.role}(host)` : span.role;
}

function describeSpan(span: TranscriptSourceSpan): string {
	const parts = [
		span.timestamp ?? "undated",
		`session ${span.ref.sessionId}`,
		describeTranscriptRole(span),
		...(span.toolName ? [`tool ${span.toolName}`] : []),
		...(span.isError ? ["error"] : []),
		...(span.lineage === "alternate" ? ["alternate branch"] : []),
	];
	return parts.join(", ");
}

const COVERAGE_REASONS_SHOWN = 5;
const COVERAGE_ERROR_CHARS = 240;

/** The most frequent reasons first, bounded, as ` (reason=count, ...)` or an empty string. */
function describeReasons(reasons: Readonly<Record<string, number>>): string {
	const ranked = Object.entries(reasons).sort((left, right) => right[1] - left[1]);
	if (ranked.length === 0) return "";
	const shown = ranked.slice(0, COVERAGE_REASONS_SHOWN).map(([reason, count]) => `${reason}=${count}`);
	const hidden = ranked.length - shown.length;
	return ` (${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""})`;
}

function describeCoverage(coverage: TranscriptCoverage): string {
	const failing =
		coverage.activeFailures > 0 ? ` ${coverage.activeFailures} source(s) are failing to read right now.` : "";
	const lastError = coverage.lastError
		? ` Last indexing error at ${coverage.lastError.at}${coverage.activeFailures > 0 ? "" : " (historical; no source is failing now)"}: ${coverage.lastError.message.replace(/\s+/g, " ").slice(0, COVERAGE_ERROR_CHARS)}`
		: "";
	const recovered = coverage.lastRecoveryAt
		? ` A failing source last became readable again at ${coverage.lastRecoveryAt}.`
		: "";
	return `Coverage: ${coverage.sessionsEligible} eligible session(s): ${coverage.sessionsIndexed} indexed, ${coverage.sessionsUnsupported} unsupported${describeReasons(coverage.unsupported)}; ${coverage.sessionsSkipped} skipped${describeReasons(coverage.skipped)}; ${coverage.spansIndexed} spans indexed, ${coverage.spansUncaptured} uncaptured${describeReasons(coverage.uncaptured)}; ${coverage.truncated ? "indexing was cut off by its budget" : "no budget cutoff"}. Sessions that are not indexed cannot be found by this search.${failing}${lastError}${recovered}`;
}

function renderHit(hit: TranscriptSearchHit): string {
	const snippet = hit.snippet.replace(/\s+/g, " ").trim();
	return `[${formatTranscriptSourceHandle(hit.span.ref)}] (${describeSpan(hit.span)}) ${snippet}`;
}

export interface TranscriptHistorySearchInput {
	query: string;
	maxResults?: number;
	includeAlternateBranches?: boolean;
	/** Epoch ms the whole tool call must end by, set once where it starts; bounds the search and the summary lookup. */
	deadlineAt?: number;
}

/** Options of one summary read: the operation deadline set once where the tool call starts. */
export interface TranscriptSummaryReadOptions {
	deadlineAt?: number;
}

/** An approved summary node that covers search hits: a whole record, approved text only. */
export interface TranscriptSummaryReference {
	/** `txn:<16 hex>` */
	handle: string;
	level: number;
	quality: string;
	coveredFrom?: string;
	coveredTo?: string;
	text: string;
	/** `tx:` handles among the requested hits that this node covers. */
	covers: string[];
}

/**
 * What a summary lookup found: every covering summary judged in one bounded check, or the typed reason none
 * could be judged. Never a partial answer.
 */
export type TranscriptSummaryLookupResult =
	| { status: "ok"; summaries: TranscriptSummaryReference[] }
	| TranscriptReadUnavailable;

/**
 * Approved, live, unexpired summaries covering a set of source hits, at most `limits.maxNodes` whole nodes.
 * A typed status when they cannot be judged now; never an empty success in place of a failure.
 */
export interface TranscriptSummaryLookup {
	summariesFor(
		refs: readonly TranscriptSourceRef[],
		limits: { maxNodes: number },
		options?: TranscriptSummaryReadOptions,
	): Promise<TranscriptSummaryLookupResult>;
}

/** ` from..to` when a covered time range is known, else the empty string. */
function describeCovered(view: { coveredFrom?: string; coveredTo?: string }): string {
	return view.coveredFrom !== undefined || view.coveredTo !== undefined
		? ` ${view.coveredFrom ?? "?"}..${view.coveredTo ?? "?"}`
		: "";
}

/**
 * The heading of one summary reference: its handle, level, covered time range, quality and the hits it
 * covers. The one rendering of a reference, for the root search and an admitted worker read alike.
 */
export function describeSummaryReference(summary: TranscriptSummaryReference): string {
	return `[${summary.handle}] level ${summary.level}${describeCovered(summary)}, ${summary.quality}, covers ${summary.covers.join(", ")}`;
}

/**
 * The summaries covering a search's hits, rendered after them. A lookup that cannot answer is one typed
 * status line next to the hits; it never hides them and never reads as "no summaries".
 */
async function describeCoveringSummaries(
	lookup: TranscriptSummaryLookup,
	hits: readonly TranscriptSearchHit[],
	maxNodes: number,
	options: TranscriptSummaryReadOptions,
): Promise<{ text: string | undefined; handles: string[] }> {
	const found = await lookup.summariesFor(
		hits.map((hit) => hit.span.ref),
		{ maxNodes },
		options,
	);
	if (found.status !== "ok") {
		return {
			text: `Summary lookup ${found.status}: ${reasonSentence(found.reason)} The hits above are unaffected.`,
			handles: [],
		};
	}
	if (found.summaries.length === 0) return { text: undefined, handles: [] };
	const records = found.summaries.map((summary) => `${describeSummaryReference(summary)}\n${summary.text}`);
	return {
		text: `Approved summaries covering these hits (expand one with action 'history_expand' and its bracketed txn handle as 'ref'):\n${wrapUntrustedText(records.join("\n"), HISTORY_UNTRUSTED_SOURCE)}`,
		handles: found.summaries.map((summary) => summary.handle),
	};
}

export async function searchTranscriptHistory(
	reader: TranscriptSourceReader | undefined,
	input: TranscriptHistorySearchInput,
	summaries?: TranscriptSummaryLookup,
): Promise<TranscriptToolOutcome> {
	const query = input.query.trim();
	if (query.length === 0 || query.length > TRANSCRIPT_HISTORY_MAX_QUERY_CHARS) {
		return failure(
			"invalid_request",
			`query must contain from 1 through ${TRANSCRIPT_HISTORY_MAX_QUERY_CHARS} characters.`,
		);
	}
	const maxResults = input.maxResults ?? TRANSCRIPT_HISTORY_DEFAULT_RESULTS;
	if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > TRANSCRIPT_HISTORY_MAX_RESULTS) {
		return failure(
			"invalid_request",
			`maxResults must be an integer from 1 through ${TRANSCRIPT_HISTORY_MAX_RESULTS}.`,
		);
	}
	if (reader === undefined) return failure("unavailable", "Transcript history is not available in this session.");
	const result = await reader.search({
		query,
		maxResults,
		includeCurrentSession: true,
		...(input.includeAlternateBranches === true ? { includeAlternateBranches: true } : {}),
		...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
	});
	if (result.status !== "ok") return unavailable(result);
	const coverage = describeCoverage(result.coverage);
	const handles = result.hits.map((hit) => formatTranscriptSourceHandle(hit.span.ref));
	const body =
		result.hits.length === 0
			? "No matching history was found."
			: `${wrapUntrustedText(result.hits.map(renderHit).join("\n"), HISTORY_UNTRUSTED_SOURCE)}\nOpen a hit's exact text with action 'history_source' and its bracketed handle as 'ref'.`;
	const covering =
		summaries !== undefined && result.hits.length > 0
			? await describeCoveringSummaries(
					summaries,
					result.hits,
					maxResults,
					input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {},
				)
			: { text: undefined, handles: [] };
	return {
		ok: true,
		text: [body, ...(covering.text !== undefined ? [covering.text] : []), coverage].join("\n"),
		details: { success: true, hits: handles, summaries: covering.handles, coverage: result.coverage },
	};
}

export async function openTranscriptSource(
	reader: TranscriptSourceReader | undefined,
	projectId: string | undefined,
	input: { ref: string; cursor?: number; maxBytes?: number; deadlineAt?: number },
): Promise<TranscriptToolOutcome> {
	if (reader === undefined || projectId === undefined) {
		return failure("unavailable", "Transcript history is not available in this session.");
	}
	const ref = parseTranscriptSourceHandle(input.ref, projectId);
	if (ref === undefined) {
		return failure(
			"invalid_handle",
			"ref is not a valid transcript source handle (expected tx:<session>:<entry>:<part>:<digest>).",
		);
	}
	const cursor = input.cursor ?? 0;
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		return failure("invalid_request", "cursor must be a non-negative integer.");
	}
	// A receiving lane may ask for a smaller page to fit its remaining room; never a larger one.
	const maxBytes = input.maxBytes ?? TRANSCRIPT_SOURCE_PAGE_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TRANSCRIPT_SOURCE_PAGE_BYTES) {
		return failure("invalid_request", `maxBytes must be an integer from 1 through ${TRANSCRIPT_SOURCE_PAGE_BYTES}.`);
	}
	const page = await reader.readSource({
		ref,
		cursor,
		maxBytes,
		...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
	});
	if (page.status !== "ok") return unavailable(page);
	const handle = formatTranscriptSourceHandle(page.span.ref);
	const header = `Source [${handle}] (${describeSpan(page.span)}) part ${page.span.ref.part}, bytes ${page.cursor}-${page.cursor + Buffer.byteLength(page.text, "utf8")} of ${page.span.bytes}`;
	const continuation = [
		page.nextCursor !== undefined
			? `Continue this part with action 'history_source', ref '${handle}', cursor ${page.nextCursor}.`
			: undefined,
		page.nextPartHandle !== undefined
			? `The entry continues in the next part: action 'history_source', ref '${page.nextPartHandle}'.`
			: undefined,
	].filter((line): line is string => line !== undefined);
	return {
		ok: true,
		text: [
			header,
			wrapUntrustedText(page.text, HISTORY_UNTRUSTED_SOURCE),
			continuation.length > 0 ? continuation.join("\n") : "End of source.",
		].join("\n"),
		details: {
			success: true,
			ref: handle,
			cursor: page.cursor,
			...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
			...(page.nextPartHandle !== undefined ? { nextPartHandle: page.nextPartHandle } : {}),
		},
	};
}

/**
 * Canonical handles named in `text`, for the current project. Used to record which sources a worker
 * was actually shown; a handle that does not parse is not a handle and is ignored.
 */
export function extractTranscriptSourceHandles(text: string, projectId: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(
		/(?<![A-Za-z0-9._:-])tx:[A-Za-z0-9._-]{1,256}:[A-Za-z0-9._-]{1,256}:\d{1,4}:[a-f0-9]{16}(?![A-Za-z0-9_:-])/g,
	)) {
		const ref = parseTranscriptSourceHandle(match[0], projectId);
		if (ref !== undefined) found.add(formatTranscriptSourceHandle(ref));
	}
	return [...found];
}

// ---------------------------------------------------------------------------------------------
// Summary node expansion
// ---------------------------------------------------------------------------------------------

export interface TranscriptNodeSummaryView {
	/** `txn:` handle of the summary node. */
	handle: string;
	quality: string;
	level: number;
	spanRange: { fromIndex: number; toIndexExclusive: number };
	coveredFrom?: string;
	coveredTo?: string;
	text: string;
}

export interface TranscriptNodeSourceView {
	/** `tx:` handle of one covered source part. */
	handle: string;
	role: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: string;
	bytes: number;
}

export type TranscriptNodeExpansion =
	| {
			status: "ok";
			node: TranscriptNodeSummaryView;
			/** A parent: its two child summaries, oldest first. */
			children?: TranscriptNodeSummaryView[];
			/** A leaf: the exact source parts it covers, in order. */
			sources?: TranscriptNodeSourceView[];
	  }
	| { status: TranscriptReadUnavailableStatus | "invalid_handle"; reason: string };

/** One level of zoom into the summary hierarchy. Read-only; backed by the same store the frontier comes from. */
export interface TranscriptNodeExpander {
	expand(handle: string, options?: TranscriptSummaryReadOptions): Promise<TranscriptNodeExpansion>;
}

function describeNode(view: TranscriptNodeSummaryView): string {
	return `[${view.handle}] level ${view.level}, spans [${view.spanRange.fromIndex},${view.spanRange.toIndexExclusive})${describeCovered(view)}, ${view.quality}`;
}

/** Expand a `txn:` handle into its two child summaries (parent) or its covered source handles (leaf). */
export async function expandTranscriptNode(
	expander: TranscriptNodeExpander | undefined,
	handle: string,
	options: TranscriptSummaryReadOptions = {},
): Promise<TranscriptToolOutcome> {
	if (expander === undefined) return failure("unavailable", "The summary hierarchy is not available in this session.");
	const expansion = await expander.expand(handle, options);
	if (expansion.status !== "ok") return failure(expansion.status, expansion.reason);
	const lines = [describeNode(expansion.node), wrapUntrustedText(expansion.node.text, HISTORY_UNTRUSTED_SOURCE)];
	if (expansion.children && expansion.children.length > 0) {
		lines.push(
			"Children (open one with action 'history_expand'):",
			...expansion.children.map((child) =>
				[describeNode(child), wrapUntrustedText(child.text, HISTORY_UNTRUSTED_SOURCE)].join("\n"),
			),
		);
	}
	if (expansion.sources && expansion.sources.length > 0) {
		lines.push(
			"Covered sources (open exact text with action 'history_source'):",
			...expansion.sources.map(
				(source) =>
					`- [${source.handle}] ${source.role}${source.toolName ? ` ${source.toolName}` : ""}${source.isError ? " (error)" : ""}${source.timestamp ? ` ${source.timestamp}` : ""}, ${source.bytes} bytes`,
			),
		);
	}
	return {
		ok: true,
		text: lines.join("\n"),
		details: {
			success: true,
			handle: expansion.node.handle,
			children: (expansion.children ?? []).map((child) => child.handle),
			sources: (expansion.sources ?? []).map((source) => source.handle),
		},
	};
}

/** Canonical `txn:` summary-node handles named in `text`; used to record which nodes a worker was shown. */
export function extractTranscriptNodeHandles(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/(?<![A-Za-z0-9._:-])txn:[a-f0-9]{16}(?![A-Za-z0-9_:-])/g)) {
		const prefix = parseTranscriptNodeHandle(match[0]);
		if (prefix !== undefined) found.add(`txn:${prefix}`);
	}
	return [...found];
}
