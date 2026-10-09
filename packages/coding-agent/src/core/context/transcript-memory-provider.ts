/**
 * Retrieval-contract adapter over the transcript history backend. Past-session evidence reaches the
 * prompt through the same provider-neutral path as curated memory (`retrieveMemoryForContext`:
 * admission, ranking, dedupe, projection), not through a transcript-specific injector.
 *
 * Every non-ok reader status THROWS, so the retrieval report records the provider as `failed` with the
 * real cause. That keeps three outcomes distinct: `blocked` (policy), `failed` (the index could not
 * answer), and `queried` with zero results (nothing matched).
 */

import {
	formatTranscriptSourceHandle,
	parseTranscriptSourceHandle,
	type TranscriptSearchHit,
	type TranscriptSourceReader,
} from "../memory/transcript-memory-contracts.ts";
import { describeTranscriptRole, TRANSCRIPT_SOURCE_PAGE_BYTES } from "../memory/transcript-source-tools.ts";
import type {
	MemoryItem,
	MemoryProvider,
	MemoryProviderCapabilities,
	MemoryRef,
	MemorySearchRequest,
	MemorySearchResult,
} from "./memory-provider-contract.ts";

/** Same id as the lifecycle recall provider: one backend, one name. */
export const TRANSCRIPT_MEMORY_PROVIDER_ID = "transcript-recall";

/**
 * History scores share the 0..1 token-overlap scale of the curated providers (OKF, file store). A past
 * conversation is untrusted episodic evidence, and recency orders observations without making them
 * authoritative, so a history hit is scaled below a curated item of equal overlap: base weight 0.85,
 * falling linearly to 0.85 * 0.85 over a year of age. A current correction in curated memory therefore
 * outranks an older history hit that merely shares more words with the query.
 */
export const TRANSCRIPT_HISTORY_BASE_SCORE_WEIGHT = 0.85;
const TRANSCRIPT_HISTORY_MAX_AGE_DISCOUNT = 0.15;
const TRANSCRIPT_HISTORY_DISCOUNT_HORIZON_DAYS = 365;
const MS_PER_DAY = 86_400_000;

const TRANSCRIPT_MEMORY_CAPABILITIES: MemoryProviderCapabilities = {
	search: true,
	fetch: true,
	write: false,
	delete: false,
	shortTerm: false,
	longTerm: true,
	graph: false,
	citations: true,
	scopes: ["project"],
	localOnly: true,
};

/** Matches the prefix `summarize` writes: `(<ts>, session <id>, <role>) [<handle>] `. */
const SUMMARY_PREFIX = /^\(.*?\) \[tx:[^\]]*\] /;

/** The snippet part of a transcript item summary, without its timestamp, session and handle prefix. */
export function transcriptSummaryBody(summary: string): string {
	return summary.replace(SUMMARY_PREFIX, "");
}

export function transcriptHistoryScoreWeight(timestamp: string | undefined, now: number): number {
	const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
	const ageDays = Number.isNaN(time)
		? TRANSCRIPT_HISTORY_DISCOUNT_HORIZON_DAYS
		: Math.max(0, (now - time) / MS_PER_DAY);
	const discount =
		TRANSCRIPT_HISTORY_MAX_AGE_DISCOUNT * Math.min(1, ageDays / TRANSCRIPT_HISTORY_DISCOUNT_HORIZON_DAYS);
	return TRANSCRIPT_HISTORY_BASE_SCORE_WEIGHT * (1 - discount);
}

function summarize(hit: TranscriptSearchHit): string {
	const { span } = hit;
	const snippet = hit.snippet.replace(/\s+/g, " ").trim();
	return `(${span.timestamp ?? "earlier session"}, session ${span.ref.sessionId}, ${describeTranscriptRole(span)}) [${formatTranscriptSourceHandle(span.ref)}] ${snippet}`;
}

function toSearchResult(hit: TranscriptSearchHit, now: number): MemorySearchResult {
	const { span } = hit;
	const handle = formatTranscriptSourceHandle(span.ref);
	const ref: MemoryRef = {
		providerId: TRANSCRIPT_MEMORY_PROVIDER_ID,
		itemId: handle,
		scope: "project",
		kind: "reference",
		uri: handle,
	};
	const item: MemoryItem = {
		id: handle,
		providerId: TRANSCRIPT_MEMORY_PROVIDER_ID,
		source: "transcript_recall",
		kind: "reference",
		scope: "project",
		durability: "durable",
		summary: summarize(hit),
		refs: [ref],
		evidenceRefs: [
			{
				type: "transcript",
				ref: {
					sessionEntryId: span.ref.entryId,
					sessionId: span.ref.sessionId,
					projectId: span.ref.projectId,
					part: span.ref.part,
					digest: span.ref.digest,
				},
			},
		],
		stale: false,
		...(span.timestamp !== undefined ? { timestamp: span.timestamp } : {}),
	};
	const weight = transcriptHistoryScoreWeight(span.timestamp, now);
	return {
		item,
		score: hit.score * weight,
		reason: `transcript match ${hit.score.toFixed(3)} x history weight ${weight.toFixed(3)}`,
	};
}

export function createTranscriptMemoryProvider(
	reader: () => TranscriptSourceReader | undefined,
	projectId: () => string,
): MemoryProvider {
	return {
		id: TRANSCRIPT_MEMORY_PROVIDER_ID,
		label: "Past session history",
		source: "transcript_recall",
		capabilities: TRANSCRIPT_MEMORY_CAPABILITIES,
		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			const backend = reader();
			if (backend === undefined)
				throw new Error("unavailable: Transcript history is not available in this session.");
			const result = await backend.search({
				query: request.query,
				maxResults: request.maxResults,
				includeCurrentSession: false,
			});
			if (result.status !== "ok") throw new Error(`${result.status}: ${result.reason}`);
			const now = Date.now();
			return result.hits.map((hit) => toSearchResult(hit, now));
		},
		async fetch(ref: MemoryRef): Promise<MemoryItem | undefined> {
			const backend = reader();
			if (backend === undefined)
				throw new Error("unavailable: Transcript history is not available in this session.");
			const parsed = parseTranscriptSourceHandle(ref.itemId, projectId());
			if (parsed === undefined) return undefined;
			const page = await backend.readSource({ ref: parsed, cursor: 0, maxBytes: TRANSCRIPT_SOURCE_PAGE_BYTES });
			if (page.status === "not_found") return undefined;
			if (page.status !== "ok") throw new Error(`${page.status}: ${page.reason}`);
			const handle = formatTranscriptSourceHandle(page.span.ref);
			return {
				id: handle,
				providerId: TRANSCRIPT_MEMORY_PROVIDER_ID,
				source: "transcript_recall",
				kind: "reference",
				scope: "project",
				durability: "durable",
				summary: `(${page.span.timestamp ?? "earlier session"}, session ${page.span.ref.sessionId}, ${describeTranscriptRole(page.span)}) [${handle}]`,
				content: page.text,
				refs: [ref],
				evidenceRefs: [],
				stale: false,
				...(page.span.timestamp !== undefined ? { timestamp: page.span.timestamp } : {}),
			};
		},
	};
}
