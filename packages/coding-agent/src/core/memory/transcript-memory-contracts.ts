/**
 * Recoverable episodic history: the domain contracts shared by the transcript source adapter, the
 * recall worker, the summary hierarchy, the frontier and the read tools.
 *
 * Canonical session storage stays the only conversation writer. Everything here is either a
 * reference into it (a {@link TranscriptSourceRef}), a bounded projection of it, or derived state
 * that names its exact sources. Nothing in this module touches the filesystem, worker threads or
 * provider clients; adapters own those.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------------------------

/** Roles captured from canonical session entries. Thinking and lifecycle records are never captured. */
export type TranscriptCaptureRole = "user" | "assistant" | "tool_call" | "tool_result";

/**
 * One captured part of one canonical session entry. A large message is split into several parts,
 * every part pointing back to the same `entryId`; `part` is the zero-based part index.
 */
export interface TranscriptSourceRef {
	projectId: string;
	sessionId: string;
	entryId: string;
	part: number;
	/** First 16 hex chars of the SHA-256 of the captured part text. */
	digest: string;
}

/** Whether a span lies on its session's selected lineage (the last entry's ancestry) or a side branch. */
export type TranscriptLineage = "selected" | "alternate";

/** Bounded metadata for one captured source part. The text itself stays in canonical storage. */
export interface TranscriptSourceSpan {
	ref: TranscriptSourceRef;
	role: TranscriptCaptureRole;
	timestamp?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	lineage: TranscriptLineage;
	/**
	 * `host` when the harness synthesized the message (a provider-failure record), not the model or the
	 * owner. Rendered with the span so harness text is never read as model output.
	 */
	origin?: "host";
	/** UTF-8 byte length of the captured part text. */
	bytes: number;
}

const TRANSCRIPT_HANDLE_PREFIX = "tx";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const DIGEST_PATTERN = /^[a-f0-9]{16}$/;
export const TRANSCRIPT_MAX_PARTS_PER_ENTRY = 4_096;

export function transcriptDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Opaque handle the model passes back to open a source: `tx:<sessionId>:<entryId>:<part>:<digest>`. */
export function formatTranscriptSourceHandle(ref: TranscriptSourceRef): string {
	return [TRANSCRIPT_HANDLE_PREFIX, ref.sessionId, ref.entryId, String(ref.part), ref.digest].join(":");
}

/**
 * Parse a handle against the CURRENT project. A handle carries no project: possession of a handle can
 * never grant access to another project's history.
 */
export function parseTranscriptSourceHandle(handle: string, projectId: string): TranscriptSourceRef | undefined {
	const segments = handle.trim().split(":");
	if (segments.length !== 5 || segments[0] !== TRANSCRIPT_HANDLE_PREFIX) return undefined;
	const [, sessionId, entryId, partText, digest] = segments as [string, string, string, string, string];
	if (!SOURCE_ID_PATTERN.test(sessionId) || !SOURCE_ID_PATTERN.test(entryId)) return undefined;
	if (!/^\d{1,4}$/.test(partText)) return undefined;
	const part = Number(partText);
	if (!Number.isSafeInteger(part) || part < 0 || part >= TRANSCRIPT_MAX_PARTS_PER_ENTRY) return undefined;
	if (!DIGEST_PATTERN.test(digest)) return undefined;
	return { projectId, sessionId, entryId, part, digest };
}

const TRANSCRIPT_NODE_HANDLE_PREFIX = "txn";
const NODE_HANDLE_HEX_CHARS = 16;

/**
 * Handle of a summary node: `txn:<first 16 hex chars of the node id>`. A node handle names a summary,
 * never a source: it cannot be passed to the source reader, and the summary's cited `tx:` handles are
 * the only way to its exact text.
 */
export function formatTranscriptNodeHandle(nodeId: string): string {
	return `${TRANSCRIPT_NODE_HANDLE_PREFIX}:${nodeId.slice(0, NODE_HANDLE_HEX_CHARS)}`;
}

/** The 16-hex node-id prefix named by a `txn:` handle, or undefined when `handle` is not one. */
export function parseTranscriptNodeHandle(handle: string): string | undefined {
	const match = /^txn:([a-f0-9]{16})$/.exec(handle.trim());
	return match?.[1];
}

export function sameTranscriptSource(left: TranscriptSourceRef, right: TranscriptSourceRef): boolean {
	return (
		left.projectId === right.projectId &&
		left.sessionId === right.sessionId &&
		left.entryId === right.entryId &&
		left.part === right.part &&
		left.digest === right.digest
	);
}

// ---------------------------------------------------------------------------------------------
// Capture policy
// ---------------------------------------------------------------------------------------------

/** The host record carrying the current session's history frontier (and its cleared form). */
export const TRANSCRIPT_FRONTIER_CUSTOM_TYPE = "transcript_frontier";

/** Custom message types the harness generates from memory itself; they are never captured as history. */
export const TRANSCRIPT_EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	"memory_context",
	"memory_evidence",
	TRANSCRIPT_FRONTIER_CUSTOM_TYPE,
]);

/** Marker that identifies recall pages; a message containing it is generated memory, not history. */
export const TRANSCRIPT_RECALL_PAGE_MARKER = "<memory_context";

/** Reasons a source is not available as captured history. */
export type TranscriptUncapturedReason =
	| "secret_like"
	| "generated_memory"
	| "empty"
	| "binary_or_image"
	| "part_limit"
	| "byte_limit"
	| "custom_message"
	| "other_message_role"
	| "invalid_id"
	| "missing_entry_id"
	| "malformed_line"
	| "duplicate_entry_id";

/** Maximum UTF-8 bytes of one captured part. Larger content becomes further parts. */
export const TRANSCRIPT_PART_MAX_BYTES = 4_096;

// ---------------------------------------------------------------------------------------------
// UTF-8 accounting
// ---------------------------------------------------------------------------------------------

/** UTF-8 byte length. Never use `text.length` or a token estimate as a byte count. */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Split `text` into consecutive chunks of at most `maxBytes` UTF-8 bytes each, never splitting a code
 * point. Concatenating the chunks reconstructs `text` exactly.
 */
export function splitUtf8(text: string, maxBytes: number): string[] {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new RangeError("UTF-8 chunk size must be at least 4.");
	const chunks: string[] = [];
	let start = 0;
	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index) ?? 0;
		const units = codePoint > 0xffff ? 2 : 1;
		const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
		if (bytes + width > maxBytes) {
			chunks.push(text.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += width;
		index += units;
	}
	if (start < text.length) chunks.push(text.slice(start));
	return chunks;
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(text) <= maxBytes) return text;
	return splitUtf8(text, Math.max(4, maxBytes))[0] ?? "";
}

// ---------------------------------------------------------------------------------------------
// Typed read results
// ---------------------------------------------------------------------------------------------

export type TranscriptReadUnavailableStatus =
	| "not_found"
	| "expired"
	| "uncaptured"
	| "forbidden"
	| "pending"
	| "stale_snapshot"
	| "unavailable";

export interface TranscriptReadUnavailable {
	status: TranscriptReadUnavailableStatus;
	reason: string;
}

/** One search hit: a cited source span plus a bounded display snippet of that span. */
export interface TranscriptSearchHit {
	span: TranscriptSourceSpan;
	score: number;
	snippet: string;
}

/** Accounting of what history the index covers and what it skipped, with reasons. */
export interface TranscriptCoverage {
	sessionsIndexed: number;
	sessionsSkipped: number;
	spansIndexed: number;
	spansUncaptured: number;
	/** Distinct session-level skip reasons with counts, bounded. */
	skipped: Record<string, number>;
	/** Distinct span-level uncaptured reasons with counts, bounded. */
	uncaptured: Record<string, number>;
	/** True when the indexing budget stopped before every eligible session was read. */
	truncated: boolean;
	/** The most recent non-fatal read, ingest, source or query failure, with when it happened. */
	lastError?: { at: string; message: string };
}

export interface TranscriptSearchRequest {
	query: string;
	maxResults: number;
	/** Include spans on side branches, labelled `alternate`. Default: selected lineage only. */
	includeAlternateBranches?: boolean;
	/** Include the current session's own committed history. Default false (it is already in context). */
	includeCurrentSession?: boolean;
}

export type TranscriptSearchResult =
	| { status: "ok"; hits: TranscriptSearchHit[]; coverage: TranscriptCoverage }
	| TranscriptReadUnavailable;

export interface TranscriptSourcePageRequest {
	ref: TranscriptSourceRef;
	/** UTF-8 byte offset into the part text. Default 0. */
	cursor?: number;
	maxBytes: number;
}

export interface TranscriptSourcePage {
	status: "ok";
	span: TranscriptSourceSpan;
	text: string;
	cursor: number;
	/** Byte offset to continue from, or undefined when this page reaches the end of the part. */
	nextCursor?: number;
	/** Handle of the next part of the same entry, when the entry continues. */
	nextPartHandle?: string;
}

export type TranscriptSourcePageResult = TranscriptSourcePage | TranscriptReadUnavailable;

/** One indexed session as the hierarchy sees it: its selected lineage, in ancestry order. */
export interface TranscriptSessionSummary {
	sessionId: string;
	timestamp?: string;
	current: boolean;
	/** Captured spans on the selected lineage. */
	selectedSpanCount: number;
	/** Digest over the selected lineage's span refs in order; changes whenever the lineage changes. */
	lineageDigest: string;
}

export interface TranscriptLineageSpansRequest {
	sessionId: string;
	/** Zero-based position on the selected lineage to start from. */
	fromIndex: number;
	maxSpans: number;
}

export type TranscriptLineageSpansResult =
	| {
			status: "ok";
			sessionId: string;
			lineageDigest: string;
			fromIndex: number;
			spans: TranscriptSourceSpan[];
			/** Total captured spans on the selected lineage. */
			total: number;
	  }
	| TranscriptReadUnavailable;

/** Which sessions changed in the index; consumers re-read what they need. */
export interface TranscriptIndexChangeEvent {
	sessionIds: readonly string[];
	/** Sessions whose earlier captured spans may have changed (rewrite, shrink, lineage switch). */
	invalidatedSessionIds: readonly string[];
}

/** Exact read-only access to captured history. One backend serves search, source and expansion. */
export interface TranscriptSourceReader {
	search(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>;
	readSource(request: TranscriptSourcePageRequest): Promise<TranscriptSourcePageResult>;
	coverage(): TranscriptCoverage | undefined;
}

/** The reader surface the summary hierarchy needs in addition to search and source reads. */
export interface TranscriptLineageReader extends TranscriptSourceReader {
	listSessions(): Promise<{ status: "ok"; sessions: TranscriptSessionSummary[] } | TranscriptReadUnavailable>;
	listLineageSpans(request: TranscriptLineageSpansRequest): Promise<TranscriptLineageSpansResult>;
	/** Event-driven change signal; the returned function unsubscribes. */
	onIndexChanged(listener: (event: TranscriptIndexChangeEvent) => void): () => void;
}

/** Page `text` from a UTF-8 byte cursor without splitting a code point. */
export function pageUtf8(
	text: string,
	cursor: number,
	maxBytes: number,
): { text: string; cursor: number; nextCursor?: number } {
	const buffer = Buffer.from(text, "utf8");
	let start = Math.max(0, Math.min(Math.trunc(cursor), buffer.length));
	// Snap a cursor inside a multi-byte sequence back to its lead byte.
	while (start > 0 && start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start--;
	let end = Math.min(buffer.length, start + Math.max(4, Math.trunc(maxBytes)));
	while (end < buffer.length && end > start && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
	const page = buffer.subarray(start, end).toString("utf8");
	return end < buffer.length ? { text: page, cursor: start, nextCursor: end } : { text: page, cursor: start };
}

// ---------------------------------------------------------------------------------------------
// Summary jobs (one owner of every transition)
// ---------------------------------------------------------------------------------------------

export type TranscriptSummaryJobState =
	| "queued"
	| "running"
	| "ready"
	| "retry_wait"
	| "failed"
	| "cancelled"
	| "stale";

const SUMMARY_JOB_TRANSITIONS: Readonly<Record<TranscriptSummaryJobState, readonly TranscriptSummaryJobState[]>> = {
	queued: ["running", "cancelled", "stale"],
	running: ["ready", "retry_wait", "failed", "cancelled", "stale", "queued"],
	retry_wait: ["queued", "cancelled", "stale"],
	ready: [],
	failed: [],
	cancelled: [],
	stale: [],
};

export function canTransitionSummaryJob(from: TranscriptSummaryJobState, to: TranscriptSummaryJobState): boolean {
	return SUMMARY_JOB_TRANSITIONS[from].includes(to);
}

export function isTerminalSummaryJobState(state: TranscriptSummaryJobState): boolean {
	return SUMMARY_JOB_TRANSITIONS[state].length === 0;
}

/** Initial UTF-8 target for one summary body; typed handles/coverage metadata are stored outside it. */
export const TRANSCRIPT_SUMMARY_TARGET_BYTES = 512;
/** Hard ceiling for an accepted summary body. Overlong replies fail; they are never clipped into acceptance. */
export const TRANSCRIPT_SUMMARY_MAX_BYTES = 1_024;
export const TRANSCRIPT_SUMMARY_SCHEMA_VERSION = 1;
export const TRANSCRIPT_SUMMARY_RECIPE_VERSION = 1;
