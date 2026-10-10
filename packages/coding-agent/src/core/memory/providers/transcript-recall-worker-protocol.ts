import {
	TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS,
	TRANSCRIPT_MAX_PARTS_PER_ENTRY,
	type TranscriptCaptureRole,
	type TranscriptCoverage,
	type TranscriptIndexChangeEvent,
	type TranscriptIndexObservation,
	type TranscriptLineage,
	type TranscriptLineageRangeCheck,
	type TranscriptLineageRangeVerdict,
	type TranscriptLineageReader,
	type TranscriptLineageSpansResult,
	type TranscriptLineageVerifyResult,
	type TranscriptReadUnavailableStatus,
	type TranscriptSearchHit,
	type TranscriptSessionSummary,
	type TranscriptSourcePageResult,
	type TranscriptSourceRef,
	type TranscriptSourceSpan,
} from "../transcript-memory-contracts.ts";

export const TRANSCRIPT_RECALL_MAX_QUERY_CHARS = 4_000;
/** Protocol ceiling on hits per query; callers ask for fewer. */
export const TRANSCRIPT_RECALL_MAX_HITS = 20;
export const TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS = 600;
export const TRANSCRIPT_RECALL_MAX_ERROR_CHARS = 500;
/** Protocol ceiling on one source page, in UTF-8 bytes. */
export const TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES = 16_384;
export const TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES = 4;
export const TRANSCRIPT_RECALL_MAX_ID_CHARS = 256;
/** The longest path a supported platform accepts (Windows extended-length paths), so no real session path is refused. */
export const TRANSCRIPT_RECALL_MAX_PATH_CHARS = 32_767;

/** Ceiling on sessions in one listing or change event; beyond it the worker answers `unavailable`. */
export const TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS = 50_000;
/** Ceiling on spans in one lineage page. */
export const TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS = 256;

const MAX_TIMESTAMP_CHARS = 128;
const MAX_HANDLE_CHARS = 1_024;
const MAX_SKIP_REASONS = 32;
const MAX_SKIP_REASON_CHARS = 128;
const MAX_PART_INDEX = TRANSCRIPT_MAX_PARTS_PER_ENTRY - 1;

export interface TranscriptRecallInitializeRequest {
	type: "initialize";
	generation: number;
	sessionId: string;
	agentDir: string;
	cwd: string;
	projectId: string;
	/**
	 * The active session's file, so the start scan captures it even when it is stored outside the project's
	 * default session directories. Absent when the host cannot name it.
	 */
	sessionFile?: string;
}

export interface TranscriptRecallQueryRequest {
	type: "query";
	generation: number;
	requestId: number;
	query: string;
	maxResults: number;
	includeAlternateBranches: boolean;
	includeCurrentSession: boolean;
}

export interface TranscriptRecallSourceRequest {
	type: "source";
	generation: number;
	requestId: number;
	sessionId: string;
	entryId: string;
	part: number;
	digest: string;
	cursor: number;
	maxBytes: number;
}

export interface TranscriptRecallSessionsRequest {
	type: "sessions";
	generation: number;
	requestId: number;
}

export interface TranscriptRecallLineageRequest {
	type: "lineage";
	generation: number;
	requestId: number;
	sessionId: string;
	fromIndex: number;
	maxSpans: number;
}

export interface TranscriptRecallVerifyRequest {
	type: "verify";
	generation: number;
	requestId: number;
	checks: TranscriptLineageRangeCheck[];
}

export interface TranscriptRecallIngestRequest {
	type: "ingest";
	generation: number;
	sessionId: string;
	sessionFile: string;
	/** True when the session file was rewritten and earlier byte offsets are no longer valid. */
	rewritten: boolean;
	/** The parent's post-order sequence of this ingest in its generation (from 1); answers report the highest received. */
	seq: number;
}

export interface TranscriptRecallShutdownRequest {
	type: "shutdown";
	generation: number;
}

export type TranscriptRecallWorkerRequest =
	| TranscriptRecallInitializeRequest
	| TranscriptRecallQueryRequest
	| TranscriptRecallSourceRequest
	| TranscriptRecallSessionsRequest
	| TranscriptRecallLineageRequest
	| TranscriptRecallVerifyRequest
	| TranscriptRecallIngestRequest
	| TranscriptRecallShutdownRequest;

export interface TranscriptRecallReadyResponse {
	type: "ready";
	generation: number;
	coverage: TranscriptCoverage;
	/** Every indexed session, so a consumer can read what became available. Nothing is invalidated. */
	change?: TranscriptIndexChangeEvent;
}

export interface TranscriptRecallResultResponse {
	type: "result";
	generation: number;
	requestId: number;
	hits: TranscriptSearchHit[];
}

export interface TranscriptRecallSourceResponse {
	type: "source";
	generation: number;
	requestId: number;
	result: TranscriptSourcePageResult;
}

/** A query that threw inside the worker; the worker keeps serving and the caller gets the real cause. */
export interface TranscriptRecallQueryFailedResponse {
	type: "queryFailed";
	generation: number;
	requestId: number;
	error: string;
}

/** A listing and the coverage of the one index state it was taken from. */
export type TranscriptRecallSessionsResult = Awaited<ReturnType<TranscriptLineageReader["listSessions"]>>;

export interface TranscriptRecallSessionsResponse {
	type: "sessions";
	generation: number;
	requestId: number;
	result: TranscriptRecallSessionsResult;
}

export interface TranscriptRecallLineageResponse {
	type: "lineage";
	generation: number;
	requestId: number;
	result: TranscriptLineageSpansResult;
}

export interface TranscriptRecallVerifyResponse {
	type: "verify";
	generation: number;
	requestId: number;
	result: TranscriptLineageVerifyResult;
}

/** A session's new lineage revision and the lowest selected-lineage position its change can have affected. */
export interface TranscriptRecallLineageBump {
	sessionId: string;
	lineageRevision: number;
	lowestChanged: number;
}

export interface TranscriptRecallCoverageResponse {
	type: "coverage";
	generation: number;
	coverage: TranscriptCoverage;
	/** Present when an ingest changed, reloaded or evicted sessions. */
	change?: TranscriptIndexChangeEvent;
	/**
	 * One per invalidated session of `change`, posted before any later answer. A ready response carries none: every
	 * revision of a new generation starts at 0.
	 */
	bumps?: TranscriptRecallLineageBump[];
}

export interface TranscriptRecallFailedResponse {
	type: "failed";
	generation: number;
	error: string;
}

export interface TranscriptRecallStoppedResponse {
	type: "stopped";
	generation: number;
}

export type TranscriptRecallWorkerResponse =
	| TranscriptRecallReadyResponse
	| TranscriptRecallResultResponse
	| TranscriptRecallQueryFailedResponse
	| TranscriptRecallSourceResponse
	| TranscriptRecallSessionsResponse
	| TranscriptRecallLineageResponse
	| TranscriptRecallVerifyResponse
	| TranscriptRecallCoverageResponse
	| TranscriptRecallFailedResponse
	| TranscriptRecallStoppedResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isBoundedString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length <= maxChars;
}

function isNonEmptyBoundedString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

const RANGE_DIGEST = /^[0-9a-f]{32}$/;

/**
 * One well-formed range check: a session id, `fromIndex >= 0`, `count >= 1`, a range end that is still a safe
 * integer, and a fixed-width lowercase hex range digest.
 */
export function isTranscriptRecallRangeCheck(value: unknown): value is TranscriptLineageRangeCheck {
	return (
		isRecord(value) &&
		isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
		isCount(value.fromIndex) &&
		isIntegerInRange(value.count, 1, Number.MAX_SAFE_INTEGER) &&
		Number.isSafeInteger(value.fromIndex + value.count) &&
		typeof value.digest === "string" &&
		RANGE_DIGEST.test(value.digest)
	);
}

export function isTranscriptRecallWorkerRequest(value: unknown): value is TranscriptRecallWorkerRequest {
	if (!isRecord(value) || !Number.isSafeInteger(value.generation)) return false;
	switch (value.type) {
		case "shutdown":
			return true;
		case "query":
			return (
				isCount(value.requestId) &&
				isBoundedString(value.query, TRANSCRIPT_RECALL_MAX_QUERY_CHARS) &&
				isIntegerInRange(value.maxResults, 1, TRANSCRIPT_RECALL_MAX_HITS) &&
				typeof value.includeAlternateBranches === "boolean" &&
				typeof value.includeCurrentSession === "boolean"
			);
		case "source":
			return (
				isCount(value.requestId) &&
				isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isNonEmptyBoundedString(value.entryId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isIntegerInRange(value.part, 0, MAX_PART_INDEX) &&
				isNonEmptyBoundedString(value.digest, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isCount(value.cursor) &&
				isIntegerInRange(
					value.maxBytes,
					TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES,
					TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
				)
			);
		case "sessions":
			return isCount(value.requestId);
		case "lineage":
			return (
				isCount(value.requestId) &&
				isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isCount(value.fromIndex) &&
				isIntegerInRange(value.maxSpans, 1, TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS)
			);
		case "verify":
			return (
				isCount(value.requestId) &&
				Array.isArray(value.checks) &&
				value.checks.length >= 1 &&
				value.checks.length <= TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS &&
				value.checks.every(isTranscriptRecallRangeCheck)
			);
		case "ingest":
			return (
				isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isNonEmptyBoundedString(value.sessionFile, TRANSCRIPT_RECALL_MAX_PATH_CHARS) &&
				typeof value.rewritten === "boolean" &&
				isIntegerInRange(value.seq, 1, Number.MAX_SAFE_INTEGER)
			);
		case "initialize":
			return (
				isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isNonEmptyBoundedString(value.agentDir, TRANSCRIPT_RECALL_MAX_PATH_CHARS) &&
				isNonEmptyBoundedString(value.cwd, TRANSCRIPT_RECALL_MAX_PATH_CHARS) &&
				isNonEmptyBoundedString(value.projectId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				(value.sessionFile === undefined ||
					isNonEmptyBoundedString(value.sessionFile, TRANSCRIPT_RECALL_MAX_PATH_CHARS))
			);
		default:
			return false;
	}
}

const CAPTURE_ROLES: ReadonlySet<TranscriptCaptureRole> = new Set(["user", "assistant", "tool_call", "tool_result"]);
const LINEAGES: ReadonlySet<TranscriptLineage> = new Set(["selected", "alternate"]);
const UNAVAILABLE_STATUSES: ReadonlySet<TranscriptReadUnavailableStatus> = new Set([
	"not_found",
	"expired",
	"uncaptured",
	"forbidden",
	"pending",
	"stale_snapshot",
	"unavailable",
]);

function isSourceRef(value: unknown): value is TranscriptSourceRef {
	return (
		isRecord(value) &&
		isNonEmptyBoundedString(value.projectId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
		isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
		isNonEmptyBoundedString(value.entryId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
		isIntegerInRange(value.part, 0, MAX_PART_INDEX) &&
		isNonEmptyBoundedString(value.digest, TRANSCRIPT_RECALL_MAX_ID_CHARS)
	);
}

function isSourceSpan(value: unknown): value is TranscriptSourceSpan {
	if (!isRecord(value) || !isSourceRef(value.ref)) return false;
	return (
		typeof value.role === "string" &&
		CAPTURE_ROLES.has(value.role as TranscriptCaptureRole) &&
		typeof value.lineage === "string" &&
		LINEAGES.has(value.lineage as TranscriptLineage) &&
		(value.timestamp === undefined || isBoundedString(value.timestamp, MAX_TIMESTAMP_CHARS)) &&
		(value.toolName === undefined || isBoundedString(value.toolName, TRANSCRIPT_RECALL_MAX_ID_CHARS)) &&
		(value.toolCallId === undefined || isBoundedString(value.toolCallId, TRANSCRIPT_RECALL_MAX_ID_CHARS)) &&
		(value.isError === undefined || typeof value.isError === "boolean") &&
		(value.origin === undefined || value.origin === "host") &&
		isCount(value.bytes) &&
		isNonEmptyBoundedString(value.textDigest, TRANSCRIPT_RECALL_MAX_ID_CHARS)
	);
}

function isObservation(value: unknown): value is TranscriptIndexObservation {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.generation) &&
		isCount(value.ingestSeq) &&
		Array.isArray(value.sessions) &&
		value.sessions.length <= TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS &&
		value.sessions.every(
			(session) =>
				isRecord(session) &&
				isNonEmptyBoundedString(session.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isCount(session.lineageRevision) &&
				isCount(session.dependsThrough),
		)
	);
}

function isLineageBumps(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS &&
		value.every(
			(bump) =>
				isRecord(bump) &&
				isNonEmptyBoundedString(bump.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
				isIntegerInRange(bump.lineageRevision, 1, Number.MAX_SAFE_INTEGER) &&
				isCount(bump.lowestChanged),
		)
	);
}

function isSearchHit(value: unknown): value is TranscriptSearchHit {
	return (
		isRecord(value) &&
		isSourceSpan(value.span) &&
		typeof value.score === "number" &&
		Number.isFinite(value.score) &&
		isBoundedString(value.snippet, TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS + 6)
	);
}

function isReasonCounts(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const reasons = Object.entries(value);
	return (
		reasons.length <= MAX_SKIP_REASONS &&
		reasons.every(([reason, count]) => reason.length <= MAX_SKIP_REASON_CHARS && isCount(count))
	);
}

function isLastError(value: unknown): value is NonNullable<TranscriptCoverage["lastError"]> {
	return (
		isRecord(value) &&
		isNonEmptyBoundedString(value.at, MAX_TIMESTAMP_CHARS) &&
		isBoundedString(value.message, TRANSCRIPT_RECALL_MAX_ERROR_CHARS)
	);
}

function isCoverage(value: unknown): value is TranscriptCoverage {
	if (
		!isRecord(value) ||
		!isCount(value.sessionsEligible) ||
		!isCount(value.sessionsIndexed) ||
		!isCount(value.sessionsUnsupported) ||
		!isCount(value.sessionsSkipped) ||
		!isCount(value.spansIndexed) ||
		!isCount(value.spansUncaptured) ||
		!isCount(value.activeFailures) ||
		typeof value.truncated !== "boolean" ||
		(value.lastError !== undefined && !isLastError(value.lastError)) ||
		(value.lastRecoveryAt !== undefined && !isNonEmptyBoundedString(value.lastRecoveryAt, MAX_TIMESTAMP_CHARS))
	) {
		return false;
	}
	return isReasonCounts(value.skipped) && isReasonCounts(value.unsupported) && isReasonCounts(value.uncaptured);
}

function isIdList(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS &&
		value.every((id) => isNonEmptyBoundedString(id, TRANSCRIPT_RECALL_MAX_ID_CHARS))
	);
}

function isIndexChange(value: unknown): value is TranscriptIndexChangeEvent {
	return isRecord(value) && isIdList(value.sessionIds) && isIdList(value.invalidatedSessionIds);
}

function isUnavailable(value: Record<string, unknown>): boolean {
	return (
		typeof value.status === "string" &&
		UNAVAILABLE_STATUSES.has(value.status as TranscriptReadUnavailableStatus) &&
		isBoundedString(value.reason, TRANSCRIPT_RECALL_MAX_ERROR_CHARS) &&
		// The recovery pointer exists only on a stale exact-source answer.
		(value.currentRef === undefined || (value.status === "stale_snapshot" && isSourceRef(value.currentRef)))
	);
}

function isSessionSummary(value: unknown): value is TranscriptSessionSummary {
	return (
		isRecord(value) &&
		isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
		(value.timestamp === undefined || isBoundedString(value.timestamp, MAX_TIMESTAMP_CHARS)) &&
		typeof value.current === "boolean" &&
		isCount(value.selectedSpanCount) &&
		isNonEmptyBoundedString(value.lineageDigest, TRANSCRIPT_RECALL_MAX_ID_CHARS)
	);
}

function isSessionsResult(value: unknown): value is TranscriptRecallSessionsResult {
	if (!isRecord(value)) return false;
	if (value.status === "ok") {
		return (
			Array.isArray(value.sessions) &&
			value.sessions.length <= TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS &&
			value.sessions.every(isSessionSummary) &&
			isCoverage(value.coverage)
		);
	}
	return isUnavailable(value);
}

function isLineageResult(value: unknown): value is TranscriptLineageSpansResult {
	if (!isRecord(value)) return false;
	if (value.status === "ok") {
		return (
			isNonEmptyBoundedString(value.sessionId, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
			isNonEmptyBoundedString(value.lineageDigest, TRANSCRIPT_RECALL_MAX_ID_CHARS) &&
			isCount(value.fromIndex) &&
			isCount(value.total) &&
			Array.isArray(value.spans) &&
			value.spans.length <= TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS &&
			value.spans.every(isSourceSpan) &&
			isObservation(value.observation)
		);
	}
	return isUnavailable(value);
}

const RANGE_VERDICTS: ReadonlySet<TranscriptLineageRangeVerdict> = new Set(["live", "moved", "session_gone"]);

function isVerifyResult(value: unknown): value is TranscriptLineageVerifyResult {
	if (!isRecord(value)) return false;
	if (value.status === "ok") {
		return (
			Array.isArray(value.verdicts) &&
			value.verdicts.length <= TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS &&
			value.verdicts.every(
				(verdict) => typeof verdict === "string" && RANGE_VERDICTS.has(verdict as TranscriptLineageRangeVerdict),
			) &&
			isObservation(value.observation)
		);
	}
	return isUnavailable(value);
}

function isSourcePageResult(value: unknown): value is TranscriptSourcePageResult {
	if (!isRecord(value)) return false;
	if (value.status === "ok") {
		return (
			isSourceSpan(value.span) &&
			isBoundedString(value.text, TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES) &&
			isCount(value.cursor) &&
			(value.nextCursor === undefined || isCount(value.nextCursor)) &&
			(value.nextPartHandle === undefined || isBoundedString(value.nextPartHandle, MAX_HANDLE_CHARS))
		);
	}
	return isUnavailable(value);
}

export function isTranscriptRecallWorkerResponse(value: unknown): value is TranscriptRecallWorkerResponse {
	if (!isRecord(value) || !Number.isSafeInteger(value.generation)) return false;
	switch (value.type) {
		case "ready":
			return isCoverage(value.coverage) && (value.change === undefined || isIndexChange(value.change));
		case "coverage":
			return (
				isCoverage(value.coverage) &&
				(value.change === undefined || isIndexChange(value.change)) &&
				(value.bumps === undefined || isLineageBumps(value.bumps))
			);
		case "failed":
			return isBoundedString(value.error, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
		case "stopped":
			return true;
		case "result":
			return (
				isCount(value.requestId) &&
				Array.isArray(value.hits) &&
				value.hits.length <= TRANSCRIPT_RECALL_MAX_HITS &&
				value.hits.every(isSearchHit)
			);
		case "queryFailed":
			return isCount(value.requestId) && isBoundedString(value.error, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
		case "source":
			return isCount(value.requestId) && isSourcePageResult(value.result);
		case "sessions":
			return isCount(value.requestId) && isSessionsResult(value.result);
		case "lineage":
			return isCount(value.requestId) && isLineageResult(value.result);
		case "verify":
			return isCount(value.requestId) && isVerifyResult(value.result);
		default:
			return false;
	}
}
