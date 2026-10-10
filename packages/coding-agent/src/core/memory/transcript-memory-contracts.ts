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
import { RECALLED_HISTORY_DETAIL_KEY } from "../../kernel/session/message-retention.ts";

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
	/**
	 * The part's capture identity ({@link transcriptCaptureIdentity}, version {@link TRANSCRIPT_CAPTURE_VERSION}):
	 * the captured text together with the metadata summarization, admission and retention consume. Any change to
	 * either is a different source.
	 */
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
	/**
	 * {@link transcriptDigest} of the part text alone (the version-1 handle digest). Never an identity: it serves
	 * only the validated carry of evidence recorded under version 1 (spent attempts, first-capture ages).
	 */
	textDigest: string;
}

const TRANSCRIPT_HANDLE_PREFIX = "tx";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const DIGEST_PATTERN = /^[a-f0-9]{16}$/;
export const TRANSCRIPT_MAX_PARTS_PER_ENTRY = 4_096;

/** First 16 hex chars of the SHA-256 of `text` alone. Not a source identity; see {@link transcriptCaptureIdentity}. */
export function transcriptDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Version of the capture identity. Version 1 handles hashed the part text alone; version 2 binds the text and the
 * metadata consumed downstream. Derived state built from another version is never served (it is re-derived), and
 * evidence recorded under version 1 is carried only where it can be validated.
 */
export const TRANSCRIPT_CAPTURE_VERSION = 2;
const CAPTURE_IDENTITY_TAG = "pi-transcript-capture-v2";

/** Everything one captured part's identity binds: its text and the metadata rendering, admission and retention read. */
export interface TranscriptCaptureInputs {
	text: string;
	role: TranscriptCaptureRole;
	timestamp?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	origin?: "host";
}

/**
 * The one capture identity: the first 16 hex chars (64 bits) of a domain-separated SHA-256 over a fixed-order JSON
 * array of the inputs, absent fields as `null`, so absent, empty and false stay distinct. Capture, source-read
 * validation and coordinator re-reads all go through it ({@link isCurrentCaptureIdentity}). The selected/alternate
 * lineage label is deliberately not bound: branch and position validity are the lineage range check's job.
 * Collision model: accidental only, about 2^-64 per changed part; not resistant to crafted input.
 */
export function transcriptCaptureIdentity(inputs: TranscriptCaptureInputs): string {
	const encoded = JSON.stringify([
		CAPTURE_IDENTITY_TAG,
		inputs.text,
		inputs.role,
		inputs.timestamp ?? null,
		inputs.toolName ?? null,
		inputs.toolCallId ?? null,
		inputs.isError ?? null,
		inputs.origin ?? null,
	]);
	return createHash("sha256").update(encoded, "utf8").digest("hex").slice(0, 16);
}

/** The capture inputs of a span whose part text is `text`. */
export function transcriptCaptureInputs(span: TranscriptSourceSpan, text: string): TranscriptCaptureInputs {
	const inputs: TranscriptCaptureInputs = { text, role: span.role };
	if (span.timestamp !== undefined) inputs.timestamp = span.timestamp;
	if (span.toolName !== undefined) inputs.toolName = span.toolName;
	if (span.toolCallId !== undefined) inputs.toolCallId = span.toolCallId;
	if (span.isError !== undefined) inputs.isError = span.isError;
	if (span.origin !== undefined) inputs.origin = span.origin;
	return inputs;
}

/** Whether `text` with `span`'s metadata is exactly the source `ref` names: the one identity verifier. */
export function isCurrentCaptureIdentity(ref: TranscriptSourceRef, span: TranscriptSourceSpan, text: string): boolean {
	return transcriptCaptureIdentity(transcriptCaptureInputs(span, text)) === ref.digest;
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

/**
 * Tool-result `details` key set to `true` on every history read result (the root `memory` history actions and
 * the worker `memory_read`). Such a result is recalled evidence, never captured again as history, so the
 * system never indexes or summarizes its own recall. The canonical session log keeps it unchanged.
 */
export const TRANSCRIPT_RECALL_RESULT_MARKER = RECALLED_HISTORY_DETAIL_KEY;

/** The typed policy refusal every history reader, zoom, lookup and status gives while memory retrieval is disabled. */
export const MEMORY_RETRIEVAL_DISABLED_REASON = "Memory retrieval is disabled by policy.";

/** Reasons a source is not available as captured history. */
export type TranscriptUncapturedReason =
	| "secret_like"
	| "generated_memory"
	| "recalled_history"
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
	/**
	 * Set only on a `stale_snapshot` from an exact source read whose entry and part still exist: the current source
	 * at that position, so a caller can recover the exact text through a fresh read. Never text; never parsed from
	 * `reason`.
	 */
	currentRef?: TranscriptSourceRef;
}

/** One search hit: a cited source span plus a bounded display snippet of that span. */
export interface TranscriptSearchHit {
	span: TranscriptSourceSpan;
	score: number;
	snippet: string;
}

/**
 * Accounting of what history the index covers and what it did not, with reasons. Sessions are counted
 * by identity: `sessionsEligible` are this project's sessions whose header identifies them, and each is
 * exactly one of indexed, unsupported, or skipped. Files with no readable identity are only skipped.
 */
export interface TranscriptCoverage {
	/** Project sessions with a readable identity (indexed, unsupported, or skipped for a stated reason). */
	sessionsEligible: number;
	sessionsIndexed: number;
	/** Eligible sessions whose on-disk format cannot be captured with stable handles. */
	sessionsUnsupported: number;
	sessionsSkipped: number;
	spansIndexed: number;
	spansUncaptured: number;
	/** Distinct session-level skip reasons with counts, bounded. */
	skipped: Record<string, number>;
	/** Distinct reasons eligible sessions cannot be captured, with counts, bounded. */
	unsupported: Record<string, number>;
	/** Distinct span-level uncaptured reasons with counts, bounded. */
	uncaptured: Record<string, number>;
	/** Sources that failed to read or ingest and are not indexed right now (a subset of the skipped ones). */
	activeFailures: number;
	/** True when the indexing budget stopped before every eligible session was read. */
	truncated: boolean;
	/** The most recent non-fatal read, ingest, source or query failure, with when it happened. Historical evidence: later successes do not clear it. */
	lastError?: { at: string; message: string };
	/** When a source that had failed to read or ingest last became readable again. */
	lastRecoveryAt?: string;
}

export interface TranscriptSearchRequest {
	query: string;
	maxResults: number;
	/** Include spans on side branches, labelled `alternate`. Default: selected lineage only. */
	includeAlternateBranches?: boolean;
	/** Include the current session's own committed history. Default false (it is already in context). */
	includeCurrentSession?: boolean;
	/** As {@link TranscriptLineageSpansRequest.deadlineAt}. */
	deadlineAt?: number;
}

export type TranscriptSearchResult =
	| { status: "ok"; hits: TranscriptSearchHit[]; coverage: TranscriptCoverage }
	| TranscriptReadUnavailable;

export interface TranscriptSourcePageRequest {
	ref: TranscriptSourceRef;
	/** UTF-8 byte offset into the part text. Default 0. */
	cursor?: number;
	maxBytes: number;
	/** As {@link TranscriptLineageSpansRequest.deadlineAt}. */
	deadlineAt?: number;
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

/** Bound of one explicit (foreground) history operation, a tool call: one second. */
export const TRANSCRIPT_FOREGROUND_READ_MS = 1_000;

export interface TranscriptLineageSpansRequest {
	sessionId: string;
	/** Zero-based position on the selected lineage to start from. */
	fromIndex: number;
	maxSpans: number;
	/**
	 * `foreground` when an explicit history read (a tool call) waits on it, so it gets the foreground read bound;
	 * default `background` (summary construction), which may wait out ingestion.
	 */
	priority?: "foreground" | "background";
	/**
	 * Epoch ms the whole operation this read belongs to must end by, set once where a tool call starts and
	 * passed unchanged to every read it makes; the read's own bound still applies when it is sooner.
	 */
	deadlineAt?: number;
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
			/** What the index had observed when it answered; judged at delivery by {@link TranscriptLineageReader.observationCurrent}. */
			observation: TranscriptIndexObservation;
	  }
	| TranscriptReadUnavailable;

// ---------------------------------------------------------------------------------------------
// Lineage range verification (bounded dependency validation)
// ---------------------------------------------------------------------------------------------

const LINEAGE_TERM_TAG = "pi-transcript-lineage-term-v1";
/** Lineage range digests are sums of terms modulo 2^128. */
export const TRANSCRIPT_LINEAGE_DIGEST_MODULUS = 1n << 128n;

/**
 * The term one source part contributes at one selected-lineage position: a domain-separated SHA-256 of the
 * position and the part's handle, truncated to 128 bits. Binding the position makes order and shifts count.
 */
export function transcriptLineageTerm(position: number, ref: TranscriptSourceRef): bigint {
	const hex = createHash("sha256")
		.update(`${LINEAGE_TERM_TAG}\u0000${position}\u0000${formatTranscriptSourceHandle(ref)}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return BigInt(`0x${hex}`);
}

/** A sum of lineage terms as the fixed-width hex digest both sides compare. */
export function formatTranscriptLineageDigest(sum: bigint): string {
	const reduced =
		((sum % TRANSCRIPT_LINEAGE_DIGEST_MODULUS) + TRANSCRIPT_LINEAGE_DIGEST_MODULUS) %
		TRANSCRIPT_LINEAGE_DIGEST_MODULUS;
	return reduced.toString(16).padStart(32, "0");
}

/**
 * Digest of these exact parts at consecutive selected-lineage positions from `fromIndex`. The index answers the
 * same digest for any range in O(1) from prefix sums of the same terms, so a node's whole dependency range is
 * checked without reading or transferring its spans, and appending to a lineage never changes an earlier range.
 *
 * Threat model: this is a staleness detector over the local owner's own canonical history, not an authority
 * boundary, and it detects only what the part identities bind. The terms are 128-bit, so two different sets of
 * identities collide in the aggregate with probability about 2^-128 by accident; but each identity is itself a
 * 64-bit digest ({@link transcriptCaptureIdentity}), so an accidental miss of one changed part is about 2^-64. An
 * additive digest is not collision-resistant against a deliberately crafted set of terms (generalized birthday);
 * the worst case of a forged match is serving an approved summary of the same project.
 *
 * Cost on the index side: prefix sums are built lazily, so the first check that reaches a position hashes every
 * position up to it (cold, O(positions)); checks inside the built prefix are O(1) (warm). A rebuild of the lineage
 * resets the prefix.
 */
export function transcriptLineageRangeDigest(fromIndex: number, refs: readonly TranscriptSourceRef[]): string {
	if (!Number.isSafeInteger(fromIndex) || fromIndex < 0) throw new RangeError("Lineage range start must be >= 0.");
	if (refs.length === 0) throw new RangeError("Lineage range must cover at least one part.");
	let sum = 0n;
	for (const [offset, ref] of refs.entries()) sum += transcriptLineageTerm(fromIndex + offset, ref);
	return formatTranscriptLineageDigest(sum);
}

/** Most range checks one {@link TranscriptLineageReader.verifyLineageRanges} request carries; more is `unavailable`. */
export const TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS = 256;

/**
 * The retryable tail of every summary-read refusal caused by a change during the read (store revision, revocation,
 * generation or retrieval policy). The shared retry policy's `changedInFlight` class matches on "changed while";
 * each refusal names its own subject in front of it.
 */
export const TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT = "changed while the summary read was in flight; retry the read";

/** One range of a session's selected lineage that must hold exactly the parts whose digest is `digest`. */
export interface TranscriptLineageRangeCheck {
	sessionId: string;
	fromIndex: number;
	count: number;
	/** {@link transcriptLineageRangeDigest} of the expected parts. */
	digest: string;
}

/**
 * `live`: the range holds exactly the expected parts; `moved`: it does not, or the lineage is shorter than the
 * range; `session_gone`: the session is not in this project's history (a lineage page answers `not_found`). A
 * catalogued session that is not indexed now makes the whole request `unavailable`, never `session_gone`.
 */
export type TranscriptLineageRangeVerdict = "live" | "moved" | "session_gone";

export interface TranscriptLineageVerifyRequest {
	checks: readonly TranscriptLineageRangeCheck[];
	/** As {@link TranscriptLineageSpansRequest.priority}. */
	priority?: "foreground" | "background";
	/** As {@link TranscriptLineageSpansRequest.deadlineAt}. */
	deadlineAt?: number;
}

/** One verdict per check, in request order. */
export type TranscriptLineageVerifyResult =
	| { status: "ok"; verdicts: TranscriptLineageRangeVerdict[]; observation: TranscriptIndexObservation }
	| TranscriptReadUnavailable;

/**
 * What one lineage or verify answer depended on, as the index had applied it when it answered. Delivery judges it
 * after the read's last await with {@link TranscriptLineageReader.observationCurrent}, synchronously.
 *
 * Linearization contract: summary text is delivered only if, at one synchronous point after the last await, the
 * store revision, the catalog, the retention cutoff and this observation are all current AS KNOWN TO THE PARENT
 * PROCESS. Freshness is against indexed and notified state: a filesystem change the index has not been notified of
 * or has not ingested is not detected, and a change notified after that point is not covered. The judgment relies
 * on the worker's messages reaching the parent in the order they were posted (the platform's MessagePort FIFO).
 */
export interface TranscriptIndexObservation {
	/** Backend generation that answered. */
	generation: number;
	/** Highest parent ingest sequence the index had received (and so applied) when it answered. */
	ingestSeq: number;
	/**
	 * Each session the answer depended on: its lineage revision (monotone per session for the generation, bumped
	 * whenever positions of its selected lineage may have changed, never on a pure append) and the exclusive end
	 * position the answer depended on.
	 */
	sessions: readonly { sessionId: string; lineageRevision: number; dependsThrough: number }[];
}

/**
 * `current`: nothing the observation depended on has changed. `changed`: a session it depended on changed, or has a
 * notified change the index has not applied yet (retryable; `reason` names the subject). `unavailable`: the backend
 * that answered is gone, failed or replaced.
 */
export type TranscriptObservationVerdict =
	| { status: "current" }
	| { status: "changed"; reason: string }
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
	/**
	 * Every catalogued session, plus the index coverage taken in the SAME answer, so a caller can judge the listing
	 * against counts that describe exactly that catalog state (a later {@link coverage} may describe another one).
	 */
	listSessions(): Promise<
		{ status: "ok"; sessions: TranscriptSessionSummary[]; coverage: TranscriptCoverage } | TranscriptReadUnavailable
	>;
	listLineageSpans(request: TranscriptLineageSpansRequest): Promise<TranscriptLineageSpansResult>;
	/**
	 * Check selected-lineage ranges against expected range digests in one bounded request: no span bodies and no
	 * span transfer, O(1) per check in the index. At most {@link TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS} checks.
	 */
	verifyLineageRanges(request: TranscriptLineageVerifyRequest): Promise<TranscriptLineageVerifyResult>;
	/**
	 * Judge an observation against what the parent knows now: synchronous, no I/O, so it can run after a read's
	 * last await with nothing in between it and the delivery. See {@link TranscriptIndexObservation}.
	 */
	observationCurrent(observation: TranscriptIndexObservation): TranscriptObservationVerdict;
	/** Event-driven change signal; the returned function unsubscribes. */
	onIndexChanged(listener: (event: TranscriptIndexChangeEvent) => void): () => void;
	/**
	 * Start indexing on purpose (idempotent per backend generation). Owners that index in the background call it
	 * after subscribing to {@link onIndexChanged}; explicit reads start an idle backend themselves.
	 */
	start(): void;
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
