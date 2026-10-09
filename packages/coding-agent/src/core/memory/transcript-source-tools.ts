/**
 * Read-only presentation of recoverable history for the model-facing surfaces: the root `memory` tool
 * (`history_search`, `history_source`) and the worker `memory_read` broker. One renderer and one
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
	| { ok: false; status: TranscriptToolStatus; reason: string; text: string };

function failure(status: TranscriptToolStatus, reason: string): TranscriptToolOutcome {
	return { ok: false, status, reason, text: `Error: transcript history ${status}: ${reason}` };
}

function unavailable(result: TranscriptReadUnavailable): TranscriptToolOutcome {
	return failure(result.status, result.reason);
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
}

export async function searchTranscriptHistory(
	reader: TranscriptSourceReader | undefined,
	input: TranscriptHistorySearchInput,
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
	});
	if (result.status !== "ok") return unavailable(result);
	const coverage = describeCoverage(result.coverage);
	const handles = result.hits.map((hit) => formatTranscriptSourceHandle(hit.span.ref));
	const body =
		result.hits.length === 0
			? "No matching history was found."
			: `${wrapUntrustedText(result.hits.map(renderHit).join("\n"), HISTORY_UNTRUSTED_SOURCE)}\nOpen a hit's exact text with action 'history_source' and its bracketed handle as 'ref'.`;
	return {
		ok: true,
		text: `${body}\n${coverage}`,
		details: { success: true, hits: handles, coverage: result.coverage },
	};
}

export async function openTranscriptSource(
	reader: TranscriptSourceReader | undefined,
	projectId: string | undefined,
	input: { ref: string; cursor?: number },
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
	const page = await reader.readSource({ ref, cursor, maxBytes: TRANSCRIPT_SOURCE_PAGE_BYTES });
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
	expand(handle: string): Promise<TranscriptNodeExpansion>;
}

function describeNode(view: TranscriptNodeSummaryView): string {
	const stamps =
		view.coveredFrom !== undefined || view.coveredTo !== undefined
			? ` ${view.coveredFrom ?? "?"}..${view.coveredTo ?? "?"}`
			: "";
	return `[${view.handle}] level ${view.level}, spans [${view.spanRange.fromIndex},${view.spanRange.toIndexExclusive})${stamps}, ${view.quality}`;
}

/** Expand a `txn:` handle into its two child summaries (parent) or its covered source handles (leaf). */
export async function expandTranscriptNode(
	expander: TranscriptNodeExpander | undefined,
	handle: string,
): Promise<TranscriptToolOutcome> {
	if (expander === undefined) return failure("unavailable", "The summary hierarchy is not available in this session.");
	const expansion = await expander.expand(handle);
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
