import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import {
	FIRST_SESSION_VERSION_WITH_ENTRY_IDS,
	getDefaultSessionDirCandidates,
	isAutoLearnSessionId,
	readSessionHeaderResult,
	resolvePath,
	type SessionEntry,
} from "../../../kernel/node.ts";
import { TranscriptIndex } from "../transcript-index.ts";
import {
	formatTranscriptSourceHandle,
	pageUtf8,
	type TranscriptCoverage,
	type TranscriptIndexChangeEvent,
	type TranscriptLineageSpansResult,
	type TranscriptReadUnavailable,
	type TranscriptSessionSummary,
	type TranscriptSourcePage,
	type TranscriptSourcePageResult,
} from "../transcript-memory-contracts.ts";
import { isTranscriptSessionIdResolvable, SessionCaptureState } from "../transcript-source.ts";
import {
	isTranscriptRecallWorkerRequest,
	TRANSCRIPT_RECALL_MAX_ERROR_CHARS,
	TRANSCRIPT_RECALL_MAX_ID_CHARS,
	TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS,
	TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS,
	type TranscriptRecallInitializeRequest,
	type TranscriptRecallLineageRequest,
	type TranscriptRecallQueryRequest,
	type TranscriptRecallSourceRequest,
	type TranscriptRecallWorkerRequest,
	type TranscriptRecallWorkerResponse,
} from "./transcript-recall-worker-protocol.ts";

/** Total UTF-8 bytes of captured span text retained in memory across every indexed session. */
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
/** Session files above this size are not read; they are reported in coverage. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const HEADER_READ_BYTES = 64 * 1024;
const MIN_SCORE = 0.34;
const MAX_COVERAGE_REASONS = 31;
const MAX_REASON_CHARS = 96;

const SKIP_BYTE_LIMIT = "byte_limit";
const SKIP_FILE_TOO_LARGE = "file_too_large";
/** Eligible session that exists at more than one location with contents that are not the same file. */
const SKIP_AMBIGUOUS_IDENTITY = "ambiguous_session_identity";
/** Format reasons: the file cannot be captured with handles that survive a restart. */
const UNSUPPORTED_PRE_ID_FORMAT = "unsupported_format:pre_id_v1";
const UNSUPPORTED_INVALID_SESSION_ID = "unsupported_format:invalid_session_id";
/** A skip or failure reason produced by `failureReason`: the source is not indexed because reading it failed. */
const FAILURE_REASON = /^(read|ingest|source|query|sessions|lineage)_error:/;

const port = parentPort;
if (!port) throw new Error("transcript recall worker requires parentPort");
const workerPort = port;

interface SessionRecord {
	sessionId: string;
	path: string;
	mtimeMs: number;
	timestamp?: string;
	isCurrent: boolean;
	/** Present while the session's captured text is held in memory and indexed. */
	state?: SessionCaptureState;
	/** Byte offset just past the last complete line captured into `state`. */
	offset: number;
	/** Bytes of `state` currently charged against the retention budget. */
	accountedBytes: number;
	/** Why the session is not held in memory. */
	skip?: string;
}

/** Session header fields the catalog needs. `version` is absent from format-v1 headers. */
interface SessionHeaderInfo {
	sessionId: string;
	cwd?: string;
	timestamp?: string;
	version?: number;
}

interface PendingIngest {
	path: string;
	rewritten: boolean;
}

type FailurePhase = "read" | "ingest" | "source" | "query" | "sessions" | "lineage";

interface ConsumeOutcome {
	offset: number;
	exceeded: boolean;
}

interface TransientLoad {
	path: string;
	mtimeMs: number;
	size: number;
	state: SessionCaptureState;
}

let generation = -1;
let projectId = "";
let agentDirectory = "";
let currentSessionId = "";
let workingDirectory = "";
let index = new TranscriptIndex();
let retainedBytes = 0;
let recordsById = new Map<string, SessionRecord>();
let recordsByPath = new Map<string, SessionRecord>();
/** Files that were seen but have no session identity in this project, by path. */
let skippedPaths = new Map<string, string>();
/** Files of eligible sessions whose format cannot be captured with stable handles, by path. */
let unsupportedPaths = new Map<string, { sessionId: string; reason: string }>();
/** Sessions found at several locations whose contents are not the same file, with every path seen. */
let ambiguousSessions = new Map<string, Set<string>>();
/** Paths that are the same file (or a byte-identical copy) as an already catalogued session, by path. */
let mergedPaths = new Map<string, string>();
let pendingIngests = new Map<string, PendingIngest>();
/** Bounded message of the most recent non-fatal read, ingest or source failure. Never cleared by a later success. */
let lastError: { at: string; message: string } | undefined;
/** When a source that had failed to read or ingest last became readable again. */
let lastRecoveryAt: string | undefined;
/** Set once a send to the parent has failed: that channel is not used again and the worker terminates. */
let transportFailure: Error | undefined;
/** Sessions whose spans changed, and those whose earlier spans may have changed, since the last change post. */
let changedSessionIds = new Set<string>();
let invalidatedSessionIds = new Set<string>();
let flushScheduled = false;
let transientLoad: TransientLoad | undefined;

/**
 * Send to the parent. A failed send is transport loss, not a work error: it is never reported through
 * the channel that just failed. The real cause is kept, the channel is not used again, and the worker
 * ends through its uncaught-error path, so the parent settles every pending read once with that cause.
 */
function post(response: TranscriptRecallWorkerResponse): void {
	if (transportFailure) return;
	try {
		workerPort.postMessage(response);
	} catch (error) {
		const failure = new Error(
			`transcript recall worker could not deliver a '${response.type}' response: ${errorMessage(error)}`,
			{ cause: error },
		);
		transportFailure = failure;
		setImmediate(() => {
			throw failure;
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
}

function errorCode(error: unknown): string {
	if (isRecord(error) && typeof error.code === "string") return error.code.slice(0, MAX_REASON_CHARS);
	return (error instanceof Error ? error.name : "error").slice(0, MAX_REASON_CHARS);
}

/**
 * Record a non-fatal failure: keeps the bounded real message as `lastError` and returns the coverage
 * reason (`read_error:<code>`, `ingest_error:<code>`) naming the phase and the error class.
 */
function failureReason(phase: FailurePhase, error: unknown): string {
	const reason = `${phase}_error:${errorCode(error)}`;
	lastError = {
		at: new Date().toISOString(),
		message: `${reason}: ${errorMessage(error)}`.slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS),
	};
	return reason;
}

/**
 * Identity of a session file for catalog lookup. Uses the kernel's own path resolution, and compares
 * case-insensitively on Windows, so differently spelled paths of one file are the same session.
 */
function pathKey(path: string): string {
	const resolved = resolvePath(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resetState(): void {
	index = new TranscriptIndex();
	retainedBytes = 0;
	recordsById = new Map();
	recordsByPath = new Map();
	skippedPaths = new Map();
	unsupportedPaths = new Map();
	ambiguousSessions = new Map();
	mergedPaths = new Map();
	pendingIngests = new Map();
	transientLoad = undefined;
	lastError = undefined;
	lastRecoveryAt = undefined;
	changedSessionIds = new Set();
	invalidatedSessionIds = new Set();
}

// ---------------------------------------------------------------------------------------------
// Reading session files
// ---------------------------------------------------------------------------------------------

/**
 * Stream complete lines from `startOffset`, bounded to the file size at open. Returns the offset just
 * past the last consumed line. An unterminated tail is offered to `onTail`; it is consumed only when
 * that returns true (a complete JSON line written without its newline), otherwise it is left for the
 * next read because the writer may still be appending it.
 */
function readCompleteLines(
	path: string,
	startOffset: number,
	onLine: (line: string) => boolean,
	onTail: (line: string) => boolean,
): number {
	const fd = openSync(path, "r");
	try {
		const end = fstatSync(fd).size;
		const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let position = startOffset;
		let consumed = startOffset;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		while (position < end) {
			const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
			if (bytesRead === 0) break;
			const chunkStart = position;
			position += bytesRead;
			const view = buffer.subarray(0, bytesRead);
			let segmentStart = 0;
			while (segmentStart < bytesRead) {
				const newline = view.indexOf(0x0a, segmentStart);
				if (newline === -1) {
					const rest = Buffer.from(view.subarray(segmentStart));
					pending.push(rest);
					pendingBytes += rest.length;
					break;
				}
				const piece = view.subarray(segmentStart, newline);
				const lineBytes = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
				pending = [];
				pendingBytes = 0;
				segmentStart = newline + 1;
				consumed = chunkStart + segmentStart;
				if (!onLine(lineBytes.toString("utf8"))) return consumed;
			}
		}
		if (pendingBytes > 0 && onTail(Buffer.concat(pending).toString("utf8"))) consumed = end;
		return consumed;
	} finally {
		closeSync(fd);
	}
}

/**
 * Capture the entries of one session file into `state`, from `startOffset`. Stops early (exceeded)
 * when the state's retained text passes `limitBytes`, so an oversized session is never fully parsed.
 */
function consumeSession(
	path: string,
	state: SessionCaptureState,
	startOffset: number,
	limitBytes: number,
): ConsumeOutcome {
	let exceeded = false;
	const accept = (line: string, complete: boolean): boolean => {
		if (line.trim() === "") return true;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			if (complete) state.noteUncapturedLine("malformed_line");
			return complete;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			state.noteUncapturedLine("malformed_line");
			return true;
		}
		if (parsed.type === "session") return true;
		const hasId = typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 256;
		const hasParent = parsed.parentId === null || typeof parsed.parentId === "string";
		if (!hasId || !hasParent) {
			state.noteUncapturedLine("missing_entry_id");
			return true;
		}
		state.add(parsed as unknown as SessionEntry);
		if (complete && state.retainedBytes > limitBytes) {
			exceeded = true;
			return false;
		}
		return true;
	};
	const offset = readCompleteLines(
		path,
		startOffset,
		(line) => accept(line, true),
		(line) => accept(line, false),
	);
	if (!exceeded && state.retainedBytes > limitBytes) exceeded = true;
	return { offset, exceeded };
}

/**
 * The catalog view of a session file's header: undefined when the file is not a session or its id cannot
 * name a handle. An I/O failure is thrown with its real cause, never folded into "not a session".
 */
function readSessionHeader(path: string): SessionHeaderInfo | undefined {
	const result = readSessionHeaderResult(path, HEADER_READ_BYTES);
	if (!result.ok) {
		if (result.reason === "unreadable") throw result.cause;
		return undefined;
	}
	const { id, cwd, timestamp, version } = result.header;
	if (id.length === 0 || id.length > TRANSCRIPT_RECALL_MAX_ID_CHARS) return undefined;
	const header: SessionHeaderInfo = { sessionId: id };
	if (typeof version === "number") header.version = version;
	if (typeof cwd === "string") header.cwd = cwd;
	if (typeof timestamp === "string") header.timestamp = timestamp.slice(0, 128);
	return header;
}

// ---------------------------------------------------------------------------------------------
// Session catalog and retention
// ---------------------------------------------------------------------------------------------

/** Whether two files hold byte-identical content of the given size. Stops at the first difference. */
function haveEqualBytes(left: string, right: string, size: number): boolean {
	const leftFd = openSync(left, "r");
	try {
		const rightFd = openSync(right, "r");
		try {
			const leftBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
			const rightBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
			for (let position = 0; position < size; ) {
				const length = Math.min(READ_CHUNK_BYTES, size - position);
				const leftRead = readSync(leftFd, leftBuffer, 0, length, position);
				const rightRead = readSync(rightFd, rightBuffer, 0, length, position);
				if (leftRead !== length || rightRead !== length) return false;
				if (!leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
				position += length;
			}
			return true;
		} finally {
			closeSync(rightFd);
		}
	} finally {
		closeSync(leftFd);
	}
}

/**
 * Whether two paths hold the same session file: one underlying file, or a byte-identical copy (a
 * session that exists in both the current and the legacy directory). Anything else with one session id
 * is a contradictory identity.
 */
function isSameSessionFile(left: string, right: string): boolean {
	const leftStat = statSync(left);
	const rightStat = statSync(right);
	if (leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
	if (leftStat.size !== rightStat.size || leftStat.size > MAX_FILE_BYTES) return false;
	return haveEqualBytes(left, right, leftStat.size);
}

/** A source that had failed to read or ingest is readable again. */
function noteRecovery(): void {
	lastRecoveryAt = new Date().toISOString();
}

/**
 * A second file claims a session id that is already catalogued. The same file (or a byte-identical copy)
 * is merged into the existing record; contradictory contents make the identity ambiguous: nothing of
 * that session is indexed, because handles into either copy could resolve to the wrong text.
 */
function resolveDuplicate(existing: SessionRecord, path: string, key: string, phase: FailurePhase): undefined {
	let same: boolean;
	try {
		same = isSameSessionFile(existing.path, path);
	} catch (error) {
		skippedPaths.set(key, failureReason(phase, error));
		return undefined;
	}
	if (same) {
		mergedPaths.set(key, existing.sessionId);
		return undefined;
	}
	const paths = new Set([pathKey(existing.path), key]);
	for (const [mergedKey, sessionId] of mergedPaths) {
		if (sessionId === existing.sessionId) {
			paths.add(mergedKey);
			mergedPaths.delete(mergedKey);
		}
	}
	unloadRecord(existing, SKIP_AMBIGUOUS_IDENTITY);
	recordsById.delete(existing.sessionId);
	recordsByPath.delete(pathKey(existing.path));
	ambiguousSessions.set(existing.sessionId, paths);
	return undefined;
}

/**
 * Resolve a session file into a catalog record, or record why it has no capturable session identity in
 * this project. Files of other working directories and auto-learn sessions are ineligible, not skipped.
 * Eligible files whose format cannot carry stable handles are unsupported, never captured with invented ids.
 */
function describeFile(path: string, mtimeMs: number, phase: FailurePhase): SessionRecord | undefined {
	const key = pathKey(path);
	let header: ReturnType<typeof readSessionHeader>;
	try {
		header = readSessionHeader(path);
	} catch (error) {
		skippedPaths.set(key, failureReason(phase, error));
		return undefined;
	}
	if (!header) {
		skippedPaths.set(key, "no_header");
		return undefined;
	}
	const previous = skippedPaths.get(key);
	if (previous !== undefined && FAILURE_REASON.test(previous)) noteRecovery();
	skippedPaths.delete(key);
	unsupportedPaths.delete(key);
	mergedPaths.delete(key);
	if (isAutoLearnSessionId(header.sessionId)) return undefined;
	if (!header.cwd || pathKey(header.cwd) !== pathKey(workingDirectory)) return undefined;
	if (!isTranscriptSessionIdResolvable(projectId, header.sessionId)) {
		unsupportedPaths.set(key, { sessionId: header.sessionId, reason: UNSUPPORTED_INVALID_SESSION_ID });
		return undefined;
	}
	// A format-v1 file has no entry ids; the kernel assigns random ones when it migrates the file, so
	// handles minted from an in-memory migration would not survive a restart.
	if (header.version === undefined || header.version < FIRST_SESSION_VERSION_WITH_ENTRY_IDS) {
		unsupportedPaths.set(key, { sessionId: header.sessionId, reason: UNSUPPORTED_PRE_ID_FORMAT });
		return undefined;
	}
	const ambiguous = ambiguousSessions.get(header.sessionId);
	if (ambiguous) {
		ambiguous.add(key);
		return undefined;
	}
	const existing = recordsById.get(header.sessionId);
	if (existing) return resolveDuplicate(existing, path, key, phase);
	const record: SessionRecord = {
		sessionId: header.sessionId,
		path,
		mtimeMs,
		isCurrent: header.sessionId === currentSessionId,
		offset: 0,
		accountedBytes: 0,
	};
	if (header.timestamp !== undefined) record.timestamp = header.timestamp;
	recordsById.set(record.sessionId, record);
	recordsByPath.set(key, record);
	return record;
}

function unloadRecord(record: SessionRecord, skip: string): void {
	if (record.state) {
		changedSessionIds.add(record.sessionId);
		invalidatedSessionIds.add(record.sessionId);
	}
	retainedBytes -= record.accountedBytes;
	index.removeSession(record.sessionId);
	record.state = undefined;
	record.offset = 0;
	record.accountedBytes = 0;
	record.skip = skip;
}

function adoptState(record: SessionRecord, state: SessionCaptureState, offset: number): void {
	retainedBytes += state.retainedBytes - record.accountedBytes;
	if (record.skip !== undefined && FAILURE_REASON.test(record.skip)) noteRecovery();
	record.accountedBytes = state.retainedBytes;
	record.state = state;
	record.offset = offset;
	record.skip = undefined;
	changedSessionIds.add(record.sessionId);
	index.replaceSession(record.sessionId, state.spans(), { current: record.isCurrent });
}

/** Read one whole session file into memory under `limitBytes`, or record why it was not held. */
function loadRecord(record: SessionRecord, limitBytes: number, phase: FailurePhase): void {
	const state = new SessionCaptureState(projectId, record.sessionId);
	let outcome: ConsumeOutcome;
	try {
		outcome = consumeSession(record.path, state, 0, limitBytes);
	} catch (error) {
		unloadRecord(record, failureReason(phase, error));
		return;
	}
	if (outcome.exceeded) {
		unloadRecord(record, SKIP_BYTE_LIMIT);
		return;
	}
	try {
		state.finalize();
	} catch {
		unloadRecord(record, "invalid_entry_graph");
		return;
	}
	// Replacing a held state is a whole-file reload: earlier spans may differ.
	if (record.state) invalidatedSessionIds.add(record.sessionId);
	adoptState(record, state, outcome.offset);
}

/** Evict the oldest historical sessions until retained text fits, then the protected one if it alone cannot. */
function evictFor(protectedRecord: SessionRecord): void {
	while (retainedBytes > MAX_RETAINED_BYTES) {
		let victim: SessionRecord | undefined;
		for (const record of recordsById.values()) {
			if (!record.state || record.isCurrent || record === protectedRecord) continue;
			if (!victim || record.mtimeMs < victim.mtimeMs) victim = record;
		}
		if (!victim) break;
		unloadRecord(victim, SKIP_BYTE_LIMIT);
	}
	if (retainedBytes > MAX_RETAINED_BYTES && protectedRecord.state) unloadRecord(protectedRecord, SKIP_BYTE_LIMIT);
}

/** Keep the most frequent reasons and fold the rest into `other`, so a coverage record stays bounded. */
function foldReasons(reasons: ReadonlyMap<string, number>): Record<string, number> {
	const ranked = [...reasons].sort((left, right) => right[1] - left[1]);
	const folded: Record<string, number> = {};
	let other = 0;
	ranked.forEach(([reason, count], position) => {
		if (position < MAX_COVERAGE_REASONS) folded[reason] = count;
		else other += count;
	});
	if (other > 0) folded.other = other;
	return folded;
}

function countReason(reasons: Map<string, number>, reason: string, amount = 1): void {
	reasons.set(reason, (reasons.get(reason) ?? 0) + amount);
}

function computeCoverage(): TranscriptCoverage {
	const skipped = new Map<string, number>();
	const unsupported = new Map<string, number>();
	const uncaptured = new Map<string, number>();
	let sessionsIndexed = 0;
	let sessionsSkipped = 0;
	let spansIndexed = 0;
	let spansUncaptured = 0;
	let activeFailures = 0;
	let truncated = false;
	const skip = (reason: string): void => {
		sessionsSkipped++;
		countReason(skipped, reason);
		if (FAILURE_REASON.test(reason)) activeFailures++;
	};
	for (const record of recordsById.values()) {
		if (record.state) {
			sessionsIndexed++;
			spansIndexed += record.state.spanCount;
			for (const [reason, count] of Object.entries(record.state.uncaptured)) {
				spansUncaptured += count;
				countReason(uncaptured, reason, count);
			}
		} else if (record.skip) {
			skip(record.skip);
			if (record.skip === SKIP_BYTE_LIMIT || record.skip === SKIP_FILE_TOO_LARGE) truncated = true;
		}
	}
	for (let ambiguous = 0; ambiguous < ambiguousSessions.size; ambiguous++) skip(SKIP_AMBIGUOUS_IDENTITY);
	// A session unsupported at one path but captured (or ambiguous) at another is counted there, once.
	const unsupportedIds = new Map<string, string>();
	for (const { sessionId, reason } of unsupportedPaths.values()) {
		if (!recordsById.has(sessionId) && !ambiguousSessions.has(sessionId) && !unsupportedIds.has(sessionId)) {
			unsupportedIds.set(sessionId, reason);
		}
	}
	for (const reason of unsupportedIds.values()) countReason(unsupported, reason);
	// Files with no readable identity cannot be attributed to a session; they are skipped, not eligible.
	for (const reason of skippedPaths.values()) skip(reason);
	const coverage: TranscriptCoverage = {
		sessionsEligible: recordsById.size + ambiguousSessions.size + unsupportedIds.size,
		sessionsIndexed,
		sessionsUnsupported: unsupportedIds.size,
		sessionsSkipped,
		spansIndexed,
		spansUncaptured,
		skipped: foldReasons(skipped),
		unsupported: foldReasons(unsupported),
		uncaptured: foldReasons(uncaptured),
		activeFailures,
		truncated,
	};
	if (lastError !== undefined) coverage.lastError = lastError;
	if (lastRecoveryAt !== undefined) coverage.lastRecoveryAt = lastRecoveryAt;
	return coverage;
}

// ---------------------------------------------------------------------------------------------
// Initialization and incremental ingestion
// ---------------------------------------------------------------------------------------------

/**
 * Session files of the project's current and legacy default directories, newest first (the current
 * directory wins a tie). The current directory failing to list is fatal to the scan; a legacy directory
 * failing is a skipped source, so extra coverage can never take down coverage that already worked.
 */
function discoverSessionFiles(): Array<{ path: string; mtimeMs: number; size: number }> {
	const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
	const directories = getDefaultSessionDirCandidates(workingDirectory, agentDirectory);
	for (const [position, dir] of directories.entries()) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			if (position === 0) throw error;
			skippedPaths.set(pathKey(dir), failureReason("read", error));
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			try {
				const metadata = statSync(path);
				if (metadata.isFile() && metadata.size > 0)
					files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
			} catch (error) {
				skippedPaths.set(pathKey(path), failureReason("read", error));
			}
		}
	}
	return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function buildIndex(): void {
	for (const file of discoverSessionFiles()) {
		const record = describeFile(file.path, file.mtimeMs, "read");
		if (!record) continue;
		if (file.size > MAX_FILE_BYTES) {
			record.skip = SKIP_FILE_TOO_LARGE;
			continue;
		}
		loadRecord(record, MAX_RETAINED_BYTES - retainedBytes, "read");
	}
}

function applyIngest(path: string, rewritten: boolean): void {
	let metadata: ReturnType<typeof statSync>;
	try {
		metadata = statSync(path);
	} catch (error) {
		recordIngestFailure(path, error);
		return;
	}
	let record = recordsByPath.get(pathKey(path));
	if (!record) {
		record = describeFile(path, metadata.mtimeMs, "ingest");
		if (!record) return;
	}
	record.mtimeMs = metadata.mtimeMs;
	if (metadata.size > MAX_FILE_BYTES) {
		unloadRecord(record, SKIP_FILE_TOO_LARGE);
		return;
	}
	const state = record.state;
	if (state && !rewritten && metadata.size === record.offset) return;
	if (!state || rewritten || metadata.size < record.offset) {
		loadRecord(record, MAX_RETAINED_BYTES, "ingest");
		evictFor(record);
		return;
	}

	const previousBranch = state.branchEntryIds;
	let outcome: ConsumeOutcome;
	try {
		outcome = consumeSession(record.path, state, record.offset, MAX_RETAINED_BYTES);
	} catch (error) {
		unloadRecord(record, failureReason("ingest", error));
		return;
	}
	if (outcome.exceeded) {
		unloadRecord(record, SKIP_BYTE_LIMIT);
		return;
	}
	try {
		state.finalize();
	} catch {
		unloadRecord(record, "invalid_entry_graph");
		return;
	}
	// A selected lineage that is no longer a prefix extension of the previous one is a branch switch.
	if (!state.lineageExtends(previousBranch)) invalidatedSessionIds.add(record.sessionId);
	adoptState(record, state, outcome.offset);
	evictFor(record);
}

/** One file's ingest failure is a skip reason and a diagnostic, never the end of the worker. */
function recordIngestFailure(path: string, error: unknown): void {
	const reason = failureReason("ingest", error);
	const known = recordsByPath.get(pathKey(path));
	if (known) unloadRecord(known, reason);
	else skippedPaths.set(pathKey(path), reason);
}

/** Apply every queued ingest, coalesced per file. */
function flushIngests(): void {
	if (pendingIngests.size === 0) return;
	const batch = [...pendingIngests.values()];
	pendingIngests = new Map();
	for (const { path, rewritten } of batch) {
		try {
			applyIngest(path, rewritten);
		} catch (error) {
			recordIngestFailure(path, error);
		}
	}
	const change = takeIndexChange();
	post({
		type: "coverage",
		generation,
		coverage: computeCoverage(),
		...(change ? { change } : {}),
	});
}

/** The accumulated change since the last post, or undefined when nothing changed. */
function takeIndexChange(): TranscriptIndexChangeEvent | undefined {
	if (changedSessionIds.size === 0 && invalidatedSessionIds.size === 0) return undefined;
	const change: TranscriptIndexChangeEvent = {
		sessionIds: [...changedSessionIds],
		invalidatedSessionIds: [...invalidatedSessionIds],
	};
	changedSessionIds = new Set();
	invalidatedSessionIds = new Set();
	return change;
}

function queueIngest(path: string, rewritten: boolean): void {
	const key = pathKey(path);
	pendingIngests.set(key, { path, rewritten: (pendingIngests.get(key)?.rewritten ?? false) || rewritten });
	if (flushScheduled) return;
	flushScheduled = true;
	setImmediate(() => {
		flushScheduled = false;
		try {
			flushIngests();
		} catch (error) {
			post({ type: "failed", generation, error: errorMessage(error) });
		}
	});
}

// ---------------------------------------------------------------------------------------------
// Source reads
// ---------------------------------------------------------------------------------------------

function unavailable(status: TranscriptReadUnavailable["status"], reason: string): TranscriptReadUnavailable {
	return { status, reason: reason.slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS) };
}

/** Capture one session that is not held in memory, for a single source read. Keeps the last one. */
function loadSessionForRead(record: SessionRecord): SessionCaptureState | TranscriptReadUnavailable {
	let metadata: ReturnType<typeof statSync>;
	try {
		metadata = statSync(record.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return unavailable("expired", "The session file no longer exists.");
		return unavailable("unavailable", `Session file could not be read: ${errorMessage(error)}`);
	}
	if (metadata.size > MAX_FILE_BYTES) {
		return unavailable("unavailable", `The session file exceeds the ${MAX_FILE_BYTES} byte capture limit.`);
	}
	const cached = transientLoad;
	if (cached && cached.path === record.path && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
		return cached.state;
	}
	const state = new SessionCaptureState(projectId, record.sessionId);
	try {
		consumeSession(record.path, state, 0, Number.POSITIVE_INFINITY);
		state.finalize();
	} catch (error) {
		return unavailable("unavailable", `Session file could not be captured: ${errorMessage(error)}`);
	}
	transientLoad = { path: record.path, mtimeMs: metadata.mtimeMs, size: metadata.size, state };
	return state;
}

/** Why a session id has no catalog record: contradictory copies, an uncapturable format, or not in this project. */
function missingSessionResult(sessionId: string): TranscriptReadUnavailable {
	if (ambiguousSessions.has(sessionId)) {
		return unavailable(
			"unavailable",
			`Session ${sessionId} exists at several locations with different contents (${SKIP_AMBIGUOUS_IDENTITY}).`,
		);
	}
	for (const unsupported of unsupportedPaths.values()) {
		if (unsupported.sessionId === sessionId) {
			return unavailable("unavailable", `Session ${sessionId} cannot be read from history (${unsupported.reason}).`);
		}
	}
	return unavailable("not_found", `Session ${sessionId} is not in this project's history.`);
}

function readSource(request: TranscriptRecallSourceRequest): TranscriptSourcePageResult {
	const record = recordsById.get(request.sessionId);
	if (!record) return missingSessionResult(request.sessionId);
	const state = record.state ?? loadSessionForRead(record);
	if (!(state instanceof SessionCaptureState)) return state;

	const found = state.lookup(request.entryId, request.part);
	if (!found.entryExists) {
		return unavailable("not_found", `Entry ${request.entryId} is not a conversation entry of this session.`);
	}
	if (!found.part) {
		if (found.uncapturedReason !== undefined) {
			return unavailable(
				"uncaptured",
				`Part ${request.part} of this entry was not captured: ${found.uncapturedReason}.`,
			);
		}
		return unavailable("not_found", `Entry ${request.entryId} has no part ${request.part}.`);
	}
	if (found.part.span.ref.digest !== request.digest) {
		return unavailable("stale_snapshot", "The source content changed since the handle was issued.");
	}
	const page = pageUtf8(found.part.text, request.cursor, request.maxBytes);
	const result: TranscriptSourcePage = {
		status: "ok",
		span: found.part.span,
		text: page.text,
		cursor: page.cursor,
	};
	if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
	if (found.nextPart) result.nextPartHandle = formatTranscriptSourceHandle(found.nextPart.span.ref);
	return result;
}

/** Run a read that answers with a typed result; a throw becomes `unavailable` with its real cause. */
function guarded<T>(phase: FailurePhase, read: () => T): T | TranscriptReadUnavailable {
	try {
		return read();
	} catch (error) {
		return unavailable("unavailable", `${failureReason(phase, error)}: ${errorMessage(error)}`);
	}
}

/** Indexed sessions in chronological order (header timestamp, then session id). */
function listSessions(): { status: "ok"; sessions: TranscriptSessionSummary[] } | TranscriptReadUnavailable {
	const indexed = [...recordsById.values()].filter((record) => record.state !== undefined);
	if (indexed.length > TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS) {
		return unavailable(
			"unavailable",
			`${indexed.length} sessions are indexed; listing is limited to ${TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS}.`,
		);
	}
	indexed.sort((left, right) => {
		const leftKey = left.timestamp ?? "";
		const rightKey = right.timestamp ?? "";
		if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
		return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
	});
	const sessions: TranscriptSessionSummary[] = [];
	for (const record of indexed) {
		const state = record.state;
		if (!state) continue;
		const summary: TranscriptSessionSummary = {
			sessionId: record.sessionId,
			current: record.isCurrent,
			selectedSpanCount: state.selectedSpans().length,
			lineageDigest: state.lineageDigest(),
		};
		if (record.timestamp !== undefined) summary.timestamp = record.timestamp;
		sessions.push(summary);
	}
	return { status: "ok", sessions };
}

function readLineage(request: TranscriptRecallLineageRequest): TranscriptLineageSpansResult {
	const record = recordsById.get(request.sessionId);
	if (!record) return missingSessionResult(request.sessionId);
	const state = record.state;
	if (!state) {
		return unavailable(
			"unavailable",
			`Session ${request.sessionId} is not indexed (${record.skip ?? "not loaded"}).`,
		);
	}
	const selected = state.selectedSpans();
	return {
		status: "ok",
		sessionId: record.sessionId,
		lineageDigest: state.lineageDigest(),
		fromIndex: request.fromIndex,
		spans: selected.slice(request.fromIndex, request.fromIndex + request.maxSpans).map((part) => part.span),
		total: selected.length,
	};
}

// ---------------------------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------------------------

function initialize(request: TranscriptRecallInitializeRequest): void {
	generation = request.generation;
	projectId = request.projectId;
	currentSessionId = request.sessionId;
	workingDirectory = request.cwd;
	agentDirectory = request.agentDir;
	resetState();
	try {
		buildIndex();
	} catch (error) {
		resetState();
		post({ type: "failed", generation, error: errorMessage(error) });
		return;
	}
	// The initial scan is not a change; the ready response announces what became available instead.
	changedSessionIds = new Set();
	invalidatedSessionIds = new Set();
	const indexed = [...recordsById.values()].filter((record) => record.state !== undefined);
	post({
		type: "ready",
		generation,
		coverage: computeCoverage(),
		// Above the listing ceiling the consumer learns the same limit from `listSessions`.
		...(indexed.length <= TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS
			? { change: { sessionIds: indexed.map((record) => record.sessionId), invalidatedSessionIds: [] } }
			: {}),
	});
}

function query(request: TranscriptRecallQueryRequest): void {
	try {
		runQuery(request);
	} catch (error) {
		failureReason("query", error);
		post({ type: "queryFailed", generation, requestId: request.requestId, error: errorMessage(error) });
	}
}

function runQuery(request: TranscriptRecallQueryRequest): void {
	flushIngests();
	const hits = index.query(request.query, {
		k: request.maxResults,
		minScore: MIN_SCORE,
		maxSnippetChars: TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS,
		includeAlternateBranches: request.includeAlternateBranches,
		includeCurrentSession: request.includeCurrentSession,
	});
	post({ type: "result", generation, requestId: request.requestId, hits });
}

function handle(request: TranscriptRecallWorkerRequest): void {
	if (request.type === "shutdown") {
		post({ type: "stopped", generation: request.generation });
		workerPort.close();
		return;
	}
	if (request.type === "initialize") {
		initialize(request);
		return;
	}
	if (request.generation !== generation) return;
	switch (request.type) {
		case "ingest":
			queueIngest(request.sessionFile, request.rewritten);
			break;
		case "query":
			query(request);
			break;
		case "sessions":
			flushIngests();
			post({
				type: "sessions",
				generation,
				requestId: request.requestId,
				result: guarded("sessions", listSessions),
			});
			break;
		case "lineage":
			flushIngests();
			post({
				type: "lineage",
				generation,
				requestId: request.requestId,
				result: guarded("lineage", () => readLineage(request)),
			});
			break;
		case "source":
			flushIngests();
			post({
				type: "source",
				generation,
				requestId: request.requestId,
				result: guarded("source", () => readSource(request)),
			});
			break;
	}
}

workerPort.on("message", (value: unknown) => {
	if (transportFailure || !isTranscriptRecallWorkerRequest(value)) return;
	try {
		handle(value);
	} catch (error) {
		post({ type: "failed", generation: value.generation, error: errorMessage(error) });
	}
});
