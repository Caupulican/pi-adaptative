/**
 * The transcript recall request processor: session catalog, capture, index, incremental ingest, source and
 * lineage reads for one worker. It owns every piece of state the worker holds and talks to its parent
 * only through {@link TranscriptRecallProcessorPort}, so the same processor runs behind the real
 * `parentPort` adapter (`transcript-recall-worker.ts`) and behind any other transport. Constructing it has
 * no side effects; file I/O is synchronous `node:fs`.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
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
	isCurrentCaptureIdentity,
	pageUtf8,
	type TranscriptCoverage,
	type TranscriptIndexChangeEvent,
	type TranscriptIndexObservation,
	type TranscriptLineageRangeVerdict,
	type TranscriptLineageSpansResult,
	type TranscriptLineageVerifyResult,
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
	type TranscriptRecallLineageBump,
	type TranscriptRecallLineageRequest,
	type TranscriptRecallQueryRequest,
	type TranscriptRecallSessionsResult,
	type TranscriptRecallSourceRequest,
	type TranscriptRecallVerifyRequest,
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
const FAILURE_REASON = /^(read|ingest|source|query|sessions|lineage|verify)_error:/;

/** The processor's only channel to its parent. */
export interface TranscriptRecallProcessorPort {
	/** Deliver one response to the parent. A throw is transport loss. */
	post(response: TranscriptRecallWorkerResponse): void;
	/** Close the channel after a shutdown request has been answered. */
	close(): void;
	/** Run `callback` on a later turn (the worker uses setImmediate). */
	schedule(callback: () => void): void;
	/** Transport loss: end the host with this error (the worker rethrows it uncaught). */
	fail(error: Error): void;
}

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

/** A source (file or directory) seen but not catalogued: why, and the path that was actually tried. */
interface SkippedSource {
	reason: string;
	/** As spelled when it was read; the map key is its normalized `pathKey`, which may not name it on disk. */
	path: string;
}

/** A non-empty session file found by a directory listing. */
interface SessionFile {
	path: string;
	mtimeMs: number;
	size: number;
}

interface PendingIngest {
	path: string;
	rewritten: boolean;
}

type FailurePhase = "read" | "ingest" | "source" | "query" | "sessions" | "lineage" | "verify";

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
 * Identity of a session file for catalog lookup. Uses the kernel's own path resolution, and compares
 * case-insensitively on Windows, so differently spelled paths of one file are the same session.
 */
function pathKey(path: string): string {
	const resolved = resolvePath(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

function unavailable(status: TranscriptReadUnavailable["status"], reason: string): TranscriptReadUnavailable {
	return { status, reason: reason.slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS) };
}

export class TranscriptRecallProcessor {
	private readonly port: TranscriptRecallProcessorPort;
	private generation = -1;
	private projectId = "";
	private agentDirectory = "";
	private currentSessionId = "";
	private workingDirectory = "";
	private index = new TranscriptIndex();
	private retainedBytes = 0;
	private recordsById = new Map<string, SessionRecord>();
	private recordsByPath = new Map<string, SessionRecord>();
	/** Files that were seen but have no session identity in this project, by path. */
	private skippedPaths = new Map<string, SkippedSource>();
	/** Files of eligible sessions whose format cannot be captured with stable handles, by path. */
	private unsupportedPaths = new Map<string, { sessionId: string; reason: string }>();
	/** Sessions found at several locations whose contents are not the same file, with every path seen. */
	private ambiguousSessions = new Map<string, Set<string>>();
	/** Paths that are the same file (or a byte-identical copy) as an already catalogued session, by path. */
	private mergedPaths = new Map<string, string>();
	private pendingIngests = new Map<string, PendingIngest>();
	/** Bounded message of the most recent non-fatal read, ingest or source failure. Never cleared by a later success. */
	private lastError: { at: string; message: string } | undefined;
	/** When a source that had failed to read or ingest last became readable again. */
	private lastRecoveryAt: string | undefined;
	/** Set once a send to the parent has failed: that channel is not used again and the host ends. */
	private transportFailure: Error | undefined;
	/** Sessions whose spans changed, and those whose earlier spans may have changed, since the last change post. */
	private changedSessionIds = new Set<string>();
	/**
	 * Sessions whose earlier selected-lineage positions may have changed since the last change post, each with the
	 * lowest position the change can have affected. The one "positions may have changed" owner: every lineage
	 * revision bump comes from it.
	 */
	private invalidatedSessionIds = new Map<string, number>();
	/**
	 * Lineage revision per session id for this generation: monotone, kept outside record and capture state so a
	 * deleted and re-created record never restarts it. Bumped only from {@link invalidatedSessionIds}.
	 */
	private lineageRevisions = new Map<string, number>();
	/** Highest parent ingest sequence received; every received ingest is applied before any read answers. */
	private receivedIngestSeq = 0;
	private flushScheduled = false;
	/** Whether the current request already re-read the recorded failed sources. */
	private failuresRefreshed = false;
	private transientLoad: TransientLoad | undefined;

	constructor(port: TranscriptRecallProcessorPort) {
		this.port = port;
	}

	/** Validate and handle one inbound message. Input outside the protocol, and anything after transport loss, is ignored. */
	receive(value: unknown): void {
		if (this.transportFailure || !isTranscriptRecallWorkerRequest(value)) return;
		try {
			this.handle(value);
		} catch (error) {
			this.post({ type: "failed", generation: value.generation, error: errorMessage(error) });
		}
	}

	/**
	 * Send to the parent. A failed send is transport loss, not a work error: it is never reported through
	 * the channel that just failed. The real cause is kept, the channel is not used again, and the host
	 * ends through `fail`, so the parent settles every pending read once with that cause.
	 */
	private post(response: TranscriptRecallWorkerResponse): void {
		if (this.transportFailure) return;
		try {
			this.port.post(response);
		} catch (error) {
			const failure = new Error(
				`transcript recall worker could not deliver a '${response.type}' response: ${errorMessage(error)}`,
				{ cause: error },
			);
			this.transportFailure = failure;
			this.port.fail(failure);
		}
	}

	/**
	 * Record a non-fatal failure: keeps the bounded real message as `lastError` and returns the coverage
	 * reason (`read_error:<code>`, `ingest_error:<code>`) naming the phase and the error class.
	 */
	private failureReason(phase: FailurePhase, error: unknown): string {
		const reason = `${phase}_error:${errorCode(error)}`;
		this.lastError = {
			at: new Date().toISOString(),
			message: `${reason}: ${errorMessage(error)}`.slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS),
		};
		return reason;
	}

	private resetState(): void {
		this.index = new TranscriptIndex();
		this.retainedBytes = 0;
		this.recordsById = new Map();
		this.recordsByPath = new Map();
		this.skippedPaths = new Map();
		this.unsupportedPaths = new Map();
		this.ambiguousSessions = new Map();
		this.mergedPaths = new Map();
		this.pendingIngests = new Map();
		this.transientLoad = undefined;
		this.lastError = undefined;
		this.lastRecoveryAt = undefined;
		this.changedSessionIds = new Set();
		this.invalidatedSessionIds = new Map();
		this.lineageRevisions = new Map();
		this.receivedIngestSeq = 0;
	}

	// -----------------------------------------------------------------------------------------
	// Session catalog and retention
	// -----------------------------------------------------------------------------------------

	/** A source that had failed to read or ingest is readable again. */
	private noteRecovery(): void {
		this.lastRecoveryAt = new Date().toISOString();
	}

	/**
	 * A second file claims a session id that is already catalogued. The same file (or a byte-identical copy)
	 * is merged into the existing record; contradictory contents make the identity ambiguous: nothing of
	 * that session is indexed, because handles into either copy could resolve to the wrong text.
	 */
	private resolveDuplicate(existing: SessionRecord, path: string, key: string, phase: FailurePhase): undefined {
		let same: boolean;
		try {
			same = isSameSessionFile(existing.path, path);
		} catch (error) {
			this.skipSource(path, this.failureReason(phase, error));
			return undefined;
		}
		if (same) {
			this.mergedPaths.set(key, existing.sessionId);
			return undefined;
		}
		const paths = new Set([pathKey(existing.path), key]);
		for (const [mergedKey, sessionId] of this.mergedPaths) {
			if (sessionId === existing.sessionId) {
				paths.add(mergedKey);
				this.mergedPaths.delete(mergedKey);
			}
		}
		this.unloadRecord(existing, SKIP_AMBIGUOUS_IDENTITY);
		this.recordsById.delete(existing.sessionId);
		this.recordsByPath.delete(pathKey(existing.path));
		this.ambiguousSessions.set(existing.sessionId, paths);
		return undefined;
	}

	/**
	 * Resolve a session file into a catalog record, or record why it has no capturable session identity in
	 * this project. Files of other working directories and auto-learn sessions are ineligible, not skipped.
	 * Eligible files whose format cannot carry stable handles are unsupported, never captured with invented ids.
	 */
	private describeFile(path: string, mtimeMs: number, phase: FailurePhase): SessionRecord | undefined {
		const key = pathKey(path);
		let header: ReturnType<typeof readSessionHeader>;
		try {
			header = readSessionHeader(path);
		} catch (error) {
			this.skipSource(path, this.failureReason(phase, error));
			return undefined;
		}
		if (!header) {
			this.skipSource(path, "no_header");
			return undefined;
		}
		const previous = this.skippedPaths.get(key)?.reason;
		if (previous !== undefined && FAILURE_REASON.test(previous)) this.noteRecovery();
		this.skippedPaths.delete(key);
		this.unsupportedPaths.delete(key);
		this.mergedPaths.delete(key);
		if (isAutoLearnSessionId(header.sessionId)) return undefined;
		if (!header.cwd || pathKey(header.cwd) !== pathKey(this.workingDirectory)) return undefined;
		if (!isTranscriptSessionIdResolvable(this.projectId, header.sessionId)) {
			this.unsupportedPaths.set(key, { sessionId: header.sessionId, reason: UNSUPPORTED_INVALID_SESSION_ID });
			return undefined;
		}
		// A format-v1 file has no entry ids; the kernel assigns random ones when it migrates the file, so
		// handles minted from an in-memory migration would not survive a restart.
		if (header.version === undefined || header.version < FIRST_SESSION_VERSION_WITH_ENTRY_IDS) {
			this.unsupportedPaths.set(key, { sessionId: header.sessionId, reason: UNSUPPORTED_PRE_ID_FORMAT });
			return undefined;
		}
		const ambiguous = this.ambiguousSessions.get(header.sessionId);
		if (ambiguous) {
			ambiguous.add(key);
			return undefined;
		}
		const existing = this.recordsById.get(header.sessionId);
		if (existing) return this.resolveDuplicate(existing, path, key, phase);
		const record: SessionRecord = {
			sessionId: header.sessionId,
			path,
			mtimeMs,
			isCurrent: header.sessionId === this.currentSessionId,
			offset: 0,
			accountedBytes: 0,
		};
		if (header.timestamp !== undefined) record.timestamp = header.timestamp;
		this.recordsById.set(record.sessionId, record);
		this.recordsByPath.set(key, record);
		return record;
	}

	private unloadRecord(record: SessionRecord, skip: string): void {
		if (record.state) {
			this.changedSessionIds.add(record.sessionId);
			this.invalidate(record.sessionId, 0);
		}
		this.retainedBytes -= record.accountedBytes;
		this.index.removeSession(record.sessionId);
		record.state = undefined;
		record.offset = 0;
		record.accountedBytes = 0;
		record.skip = skip;
	}

	private adoptState(record: SessionRecord, state: SessionCaptureState, offset: number): void {
		this.retainedBytes += state.retainedBytes - record.accountedBytes;
		if (record.skip !== undefined && FAILURE_REASON.test(record.skip)) this.noteRecovery();
		record.accountedBytes = state.retainedBytes;
		record.state = state;
		record.offset = offset;
		record.skip = undefined;
		this.changedSessionIds.add(record.sessionId);
		this.index.replaceSession(record.sessionId, state.spans(), { current: record.isCurrent });
	}

	/**
	 * Capture `record`'s file from `startOffset` into `state` under `limitBytes` and finalize its lineage.
	 * Returns the offset past the captured lines, or undefined after unloading the record with the reason
	 * it could not be held (read failure, byte limit, invalid entry graph).
	 */
	private captureInto(
		record: SessionRecord,
		state: SessionCaptureState,
		startOffset: number,
		limitBytes: number,
		phase: FailurePhase,
	): number | undefined {
		let outcome: ConsumeOutcome;
		try {
			outcome = consumeSession(record.path, state, startOffset, limitBytes);
		} catch (error) {
			this.unloadRecord(record, this.failureReason(phase, error));
			return undefined;
		}
		if (outcome.exceeded) {
			this.unloadRecord(record, SKIP_BYTE_LIMIT);
			return undefined;
		}
		try {
			state.finalize();
		} catch {
			this.unloadRecord(record, "invalid_entry_graph");
			return undefined;
		}
		return outcome.offset;
	}

	/** Read one whole session file into memory under `limitBytes`, or record why it was not held. */
	private loadRecord(record: SessionRecord, limitBytes: number, phase: FailurePhase): void {
		const state = new SessionCaptureState(this.projectId, record.sessionId);
		const offset = this.captureInto(record, state, 0, limitBytes, phase);
		if (offset === undefined) return;
		// Replacing a held state is a whole-file reload: earlier spans may differ.
		if (record.state) this.invalidate(record.sessionId, state.firstChangedPosition(record.state.selectedSpans()));
		this.adoptState(record, state, offset);
	}

	/** Evict the oldest historical sessions until retained text fits, then the protected one if it alone cannot. */
	private evictFor(protectedRecord: SessionRecord): void {
		while (this.retainedBytes > MAX_RETAINED_BYTES) {
			let victim: SessionRecord | undefined;
			for (const record of this.recordsById.values()) {
				if (!record.state || record.isCurrent || record === protectedRecord) continue;
				if (!victim || record.mtimeMs < victim.mtimeMs) victim = record;
			}
			if (!victim) break;
			this.unloadRecord(victim, SKIP_BYTE_LIMIT);
		}
		if (this.retainedBytes > MAX_RETAINED_BYTES && protectedRecord.state) {
			this.unloadRecord(protectedRecord, SKIP_BYTE_LIMIT);
		}
	}

	private computeCoverage(): TranscriptCoverage {
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
		for (const record of this.recordsById.values()) {
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
		for (let ambiguous = 0; ambiguous < this.ambiguousSessions.size; ambiguous++) skip(SKIP_AMBIGUOUS_IDENTITY);
		// A session unsupported at one path but captured (or ambiguous) at another is counted there, once.
		const unsupportedIds = new Map<string, string>();
		for (const { sessionId, reason } of this.unsupportedPaths.values()) {
			if (
				!this.recordsById.has(sessionId) &&
				!this.ambiguousSessions.has(sessionId) &&
				!unsupportedIds.has(sessionId)
			) {
				unsupportedIds.set(sessionId, reason);
			}
		}
		for (const reason of unsupportedIds.values()) countReason(unsupported, reason);
		// Files with no readable identity cannot be attributed to a session; they are skipped, not eligible.
		for (const { reason } of this.skippedPaths.values()) skip(reason);
		const coverage: TranscriptCoverage = {
			sessionsEligible: this.recordsById.size + this.ambiguousSessions.size + unsupportedIds.size,
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
		if (this.lastError !== undefined) coverage.lastError = this.lastError;
		if (this.lastRecoveryAt !== undefined) coverage.lastRecoveryAt = this.lastRecoveryAt;
		return coverage;
	}

	// -----------------------------------------------------------------------------------------
	// Initialization and incremental ingestion
	// -----------------------------------------------------------------------------------------

	/**
	 * Session files of the project's current and legacy default directories, newest first (the current
	 * directory wins a tie). The current directory failing to list is fatal to the scan; a legacy directory
	 * failing is a skipped source, so extra coverage can never take down coverage that already worked.
	 */
	private discoverSessionFiles(): SessionFile[] {
		const files: SessionFile[] = [];
		const directories = getDefaultSessionDirCandidates(this.workingDirectory, this.agentDirectory);
		for (const [position, dir] of directories.entries()) {
			try {
				files.push(...this.listSessionFiles(dir));
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				if (position === 0) throw error;
				this.skipSource(dir, this.failureReason("read", error));
			}
		}
		return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
	}

	/**
	 * The non-empty session files of one directory. A file that cannot be inspected is a skipped source; a
	 * directory that cannot be listed throws with its real cause.
	 */
	private listSessionFiles(dir: string): SessionFile[] {
		const files: SessionFile[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			try {
				const metadata = statSync(path);
				if (metadata.isFile() && metadata.size > 0)
					files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
			} catch (error) {
				this.skipSource(path, this.failureReason("read", error));
			}
		}
		return files;
	}

	private buildIndex(): void {
		for (const file of this.discoverSessionFiles()) {
			const record = this.describeFile(file.path, file.mtimeMs, "read");
			if (!record) continue;
			if (file.size > MAX_FILE_BYTES) {
				record.skip = SKIP_FILE_TOO_LARGE;
				continue;
			}
			this.loadRecord(record, MAX_RETAINED_BYTES - this.retainedBytes, "read");
		}
	}

	private applyIngest(path: string, rewritten: boolean): void {
		let metadata: ReturnType<typeof statSync>;
		try {
			metadata = statSync(path);
		} catch (error) {
			this.recordIngestFailure(path, error);
			return;
		}
		let record = this.recordsByPath.get(pathKey(path));
		if (!record) {
			record = this.describeFile(path, metadata.mtimeMs, "ingest");
			if (!record) return;
		}
		record.mtimeMs = metadata.mtimeMs;
		if (metadata.size > MAX_FILE_BYTES) {
			this.unloadRecord(record, SKIP_FILE_TOO_LARGE);
			return;
		}
		const state = record.state;
		if (state && !rewritten && metadata.size === record.offset) return;
		if (!state || rewritten || metadata.size < record.offset) {
			this.loadRecord(record, MAX_RETAINED_BYTES, "ingest");
			this.evictFor(record);
			return;
		}

		const previousBranch = state.branchEntryIds;
		// A rebuild in `finalize` replaces the selected list, so this keeps the previous one for comparison.
		const previousSelected = state.selectedSpans();
		const offset = this.captureInto(record, state, record.offset, MAX_RETAINED_BYTES, "ingest");
		if (offset === undefined) return;
		// A selected lineage that is no longer a prefix extension of the previous one is a branch switch.
		if (!state.lineageExtends(previousBranch)) {
			this.invalidate(record.sessionId, state.firstChangedPosition(previousSelected));
		}
		this.adoptState(record, state, offset);
		this.evictFor(record);
	}

	/**
	 * Capture the active session's file when the start scan did not reach it: a session stored outside the
	 * project's default session directories. It is read exactly as its next persisted batch would be. A file
	 * not written yet has no committed history; its first persisted batch announces it.
	 */
	private captureActiveSession(path: string): void {
		const key = pathKey(path);
		if (this.recordsByPath.has(key) || this.mergedPaths.has(key)) return;
		try {
			statSync(path);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
		}
		this.ingestFile(path, false);
	}

	/** One file's ingest failure is a skip reason and a diagnostic, never the end of the worker. */
	private recordIngestFailure(path: string, error: unknown): void {
		const reason = this.failureReason("ingest", error);
		const known = this.recordsByPath.get(pathKey(path));
		if (known) this.unloadRecord(known, reason);
		else this.skipSource(path, reason);
	}

	/** Record a source as skipped under its normalized key, keeping the path that was actually tried. */
	private skipSource(path: string, reason: string): void {
		this.skippedPaths.set(pathKey(path), { reason, path });
	}

	/** Ingest one file; its failure is a skip reason and a diagnostic, never the end of the batch or the scan. */
	private ingestFile(path: string, rewritten: boolean): void {
		try {
			this.applyIngest(path, rewritten);
		} catch (error) {
			this.recordIngestFailure(path, error);
		}
	}

	/** Apply every queued ingest, coalesced per file. */
	private flushIngests(): void {
		if (this.pendingIngests.size === 0) return;
		const batch = [...this.pendingIngests.values()];
		this.pendingIngests = new Map();
		for (const { path, rewritten } of batch) this.ingestFile(path, rewritten);
		this.postCoverage();
	}

	/** Tell the parent the current coverage, with the index change accumulated since the last post. */
	private postCoverage(): void {
		const taken = this.takeIndexChange();
		this.post({
			type: "coverage",
			generation: this.generation,
			coverage: this.computeCoverage(),
			...(taken ? { change: taken.change, ...(taken.bumps.length > 0 ? { bumps: taken.bumps } : {}) } : {}),
		});
	}

	/**
	 * Before a read answers that a session is missing while read failures are recorded, re-read each recorded
	 * failed source once: a file or directory that no longer exists drops its entry; one that reads now is
	 * catalogued (and its files ingested) exactly as a scan or ingest would; one that still fails keeps a fresh
	 * failure. The work list is the entries recorded when the refresh begins, and a request runs it at most once
	 * (`failuresRefreshed`); no timer or polling is involved. It runs synchronously on the worker: the parent's read
	 * deadline bounds only that read, so a slow refresh can continue after the read has timed out, and later
	 * requests wait behind it. Returns whether anything was re-read.
	 */
	private refreshFailedSources(): boolean {
		if (this.failuresRefreshed) return false;
		this.failuresRefreshed = true;
		const failed = [...this.skippedPaths].filter(([, source]) => FAILURE_REASON.test(source.reason));
		if (failed.length === 0) return false;
		// Re-read through the path as it was tried: the normalized key need not name the file on disk.
		for (const [key, { path }] of failed) {
			let isDirectory: boolean;
			try {
				isDirectory = statSync(path).isDirectory();
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					this.skippedPaths.delete(key);
					continue;
				}
				this.skipSource(path, this.failureReason("read", error));
				continue;
			}
			if (!isDirectory) {
				this.ingestFile(path, false);
				continue;
			}
			let files: SessionFile[];
			try {
				files = this.listSessionFiles(path);
			} catch (error) {
				this.skipSource(path, this.failureReason("read", error));
				continue;
			}
			this.skippedPaths.delete(key);
			for (const file of files) {
				const fileKey = pathKey(file.path);
				if (this.recordsByPath.has(fileKey) || this.mergedPaths.has(fileKey) || this.skippedPaths.has(fileKey)) {
					continue;
				}
				this.ingestFile(file.path, false);
			}
		}
		this.postCoverage();
		return true;
	}

	/** The catalog record of a session, after one failure refresh when it is missing and failures are recorded. */
	private catalogRecord(sessionId: string): SessionRecord | undefined {
		const record = this.recordsById.get(sessionId);
		if (record || !this.refreshFailedSources()) return record;
		return this.recordsById.get(sessionId);
	}

	/** Mark that positions of a session's selected lineage from `lowestChanged` on may have changed. */
	private invalidate(sessionId: string, lowestChanged: number): void {
		const known = this.invalidatedSessionIds.get(sessionId);
		this.invalidatedSessionIds.set(sessionId, known === undefined ? lowestChanged : Math.min(known, lowestChanged));
	}

	/**
	 * The accumulated change since the last post, or undefined when nothing changed. Taking it bumps the lineage
	 * revision of every invalidated session; the bumps travel with the change.
	 */
	private takeIndexChange(): { change: TranscriptIndexChangeEvent; bumps: TranscriptRecallLineageBump[] } | undefined {
		if (this.changedSessionIds.size === 0 && this.invalidatedSessionIds.size === 0) return undefined;
		const bumps: TranscriptRecallLineageBump[] = [];
		for (const [sessionId, lowestChanged] of this.invalidatedSessionIds) {
			const lineageRevision = (this.lineageRevisions.get(sessionId) ?? 0) + 1;
			this.lineageRevisions.set(sessionId, lineageRevision);
			bumps.push({ sessionId, lineageRevision, lowestChanged });
		}
		const change: TranscriptIndexChangeEvent = {
			sessionIds: [...this.changedSessionIds],
			invalidatedSessionIds: [...this.invalidatedSessionIds.keys()],
		};
		this.changedSessionIds = new Set();
		this.invalidatedSessionIds = new Map();
		return { change, bumps };
	}

	/**
	 * What an answer depended on: this generation, the highest received ingest (all applied, since every read
	 * flushes first), and per session its lineage revision and the exclusive end position the answer relied on.
	 */
	private observe(dependsThrough: ReadonlyMap<string, number>): TranscriptIndexObservation {
		return {
			generation: this.generation,
			ingestSeq: this.receivedIngestSeq,
			sessions: [...dependsThrough].map(([sessionId, through]) => ({
				sessionId,
				lineageRevision: this.lineageRevisions.get(sessionId) ?? 0,
				dependsThrough: through,
			})),
		};
	}

	private queueIngest(path: string, rewritten: boolean): void {
		const key = pathKey(path);
		this.pendingIngests.set(key, {
			path,
			rewritten: (this.pendingIngests.get(key)?.rewritten ?? false) || rewritten,
		});
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		this.port.schedule(() => {
			this.flushScheduled = false;
			try {
				this.flushIngests();
			} catch (error) {
				this.post({ type: "failed", generation: this.generation, error: errorMessage(error) });
			}
		});
	}

	// -----------------------------------------------------------------------------------------
	// Source reads
	// -----------------------------------------------------------------------------------------

	/** Capture one session that is not held in memory, for a single source read. Keeps the last one. */
	private loadSessionForRead(record: SessionRecord): SessionCaptureState | TranscriptReadUnavailable {
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
		const cached = this.transientLoad;
		if (
			cached &&
			cached.path === record.path &&
			cached.mtimeMs === metadata.mtimeMs &&
			cached.size === metadata.size
		) {
			return cached.state;
		}
		const state = new SessionCaptureState(this.projectId, record.sessionId);
		try {
			consumeSession(record.path, state, 0, Number.POSITIVE_INFINITY);
			state.finalize();
		} catch (error) {
			return unavailable("unavailable", `Session file could not be captured: ${errorMessage(error)}`);
		}
		this.transientLoad = { path: record.path, mtimeMs: metadata.mtimeMs, size: metadata.size, state };
		return state;
	}

	/**
	 * Why a session id has no catalog record: contradictory copies, an uncapturable format, a session file that
	 * could not be read (its identity is unknown, so absence cannot be confirmed), or not in this project.
	 * `not_found` is answered only when every seen file was readable.
	 */
	private missingSessionResult(sessionId: string): TranscriptReadUnavailable {
		if (this.ambiguousSessions.has(sessionId)) {
			return unavailable(
				"unavailable",
				`Session ${sessionId} exists at several locations with different contents (${SKIP_AMBIGUOUS_IDENTITY}).`,
			);
		}
		for (const unsupported of this.unsupportedPaths.values()) {
			if (unsupported.sessionId === sessionId) {
				return unavailable(
					"unavailable",
					`Session ${sessionId} cannot be read from history (${unsupported.reason}).`,
				);
			}
		}
		let unreadable = 0;
		let firstFailure: string | undefined;
		for (const { reason } of this.skippedPaths.values()) {
			if (!FAILURE_REASON.test(reason)) continue;
			unreadable++;
			firstFailure ??= reason;
		}
		if (firstFailure !== undefined) {
			return unavailable(
				"unavailable",
				`Session ${sessionId} is not in the readable history; ${unreadable} session file(s) or directories could not be read (${firstFailure}), so it may be among them.`,
			);
		}
		return unavailable("not_found", `Session ${sessionId} is not in this project's history.`);
	}

	private readSource(request: TranscriptRecallSourceRequest): TranscriptSourcePageResult {
		const record = this.catalogRecord(request.sessionId);
		if (!record) return this.missingSessionResult(request.sessionId);
		const state = record.state ?? this.loadSessionForRead(record);
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
		// The one identity verifier: the handle names the current part only if its capture identity (text and the
		// metadata bound with it) is exactly the requested one.
		const requested = {
			projectId: this.projectId,
			sessionId: request.sessionId,
			entryId: request.entryId,
			part: request.part,
			digest: request.digest,
		};
		if (!isCurrentCaptureIdentity(requested, found.part.span, found.part.text)) {
			// The position still exists: name its current source, so the exact text stays recoverable by a fresh read.
			return {
				...unavailable("stale_snapshot", "The source content changed since the handle was issued."),
				currentRef: { ...found.part.span.ref },
			};
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
	private guarded<T>(phase: FailurePhase, read: () => T): T | TranscriptReadUnavailable {
		try {
			return read();
		} catch (error) {
			return unavailable("unavailable", `${this.failureReason(phase, error)}: ${errorMessage(error)}`);
		}
	}

	/**
	 * Indexed sessions in chronological order (header timestamp, then session id), with the coverage of the same
	 * index state: both are read synchronously here, so no ingest can land between them.
	 */
	private listSessions(): TranscriptRecallSessionsResult {
		const indexed = [...this.recordsById.values()].filter((record) => record.state !== undefined);
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
		return { status: "ok", sessions, coverage: this.computeCoverage() };
	}

	/**
	 * The held selected lineage of a session, or why it cannot be read now: `not_found` when the session is not
	 * in this project's history, `unavailable` when it is but is not indexed (skipped, not loaded, ambiguous or
	 * unsupported). The one classification every lineage read uses.
	 */
	private heldLineage(sessionId: string): SessionCaptureState | TranscriptReadUnavailable {
		const record = this.catalogRecord(sessionId);
		if (!record) return this.missingSessionResult(sessionId);
		return (
			record.state ??
			unavailable("unavailable", `Session ${sessionId} is not indexed (${record.skip ?? "not loaded"}).`)
		);
	}

	private readLineage(request: TranscriptRecallLineageRequest): TranscriptLineageSpansResult {
		const state = this.heldLineage(request.sessionId);
		if (!(state instanceof SessionCaptureState)) return state;
		const selected = state.selectedSpans();
		const spans = selected.slice(request.fromIndex, request.fromIndex + request.maxSpans).map((part) => part.span);
		return {
			status: "ok",
			sessionId: request.sessionId,
			lineageDigest: state.lineageDigest(),
			fromIndex: request.fromIndex,
			spans,
			total: selected.length,
			observation: this.observe(new Map([[request.sessionId, request.fromIndex + spans.length]])),
		};
	}

	/**
	 * Check each range against the selected lineage that `readLineage` pages, from that lineage's prefix sums: O(1)
	 * per check once a session's prefix reaches the range, no span bodies. Sessions are classified exactly as
	 * `readLineage` classifies them: one that is not in this project's history (`not_found` there) is
	 * `session_gone`; one that is but is not indexed now makes the whole request answer that same `unavailable`,
	 * because a per-check verdict cannot say "not readable now". A range past the lineage's end or with another
	 * digest is `moved`.
	 */
	private verifyRanges(request: TranscriptRecallVerifyRequest): TranscriptLineageVerifyResult {
		const dependsThrough = new Map<string, number>();
		for (const check of request.checks) {
			const end = check.fromIndex + check.count;
			dependsThrough.set(check.sessionId, Math.max(dependsThrough.get(check.sessionId) ?? 0, end));
		}
		// The failure refresh a missing session can trigger runs before any session is resolved, so it cannot change
		// a session already judged: every verdict and every observed revision come from one index state. Within this
		// request `heldLineage` then only looks up (a request refreshes at most once).
		if ([...dependsThrough.keys()].some((sessionId) => !this.recordsById.has(sessionId))) this.refreshFailedSources();
		const verdicts: TranscriptLineageRangeVerdict[] = [];
		for (const check of request.checks) {
			const state = this.heldLineage(check.sessionId);
			if (state instanceof SessionCaptureState) {
				verdicts.push(state.rangeDigest(check.fromIndex, check.count) === check.digest ? "live" : "moved");
			} else if (state.status === "not_found") {
				verdicts.push("session_gone");
			} else {
				return state;
			}
		}
		return { status: "ok", verdicts, observation: this.observe(dependsThrough) };
	}

	// -----------------------------------------------------------------------------------------
	// Message handling
	// -----------------------------------------------------------------------------------------

	private initialize(request: TranscriptRecallInitializeRequest): void {
		this.generation = request.generation;
		this.projectId = request.projectId;
		this.currentSessionId = request.sessionId;
		this.workingDirectory = request.cwd;
		this.agentDirectory = request.agentDir;
		this.resetState();
		try {
			this.buildIndex();
			if (request.sessionFile !== undefined) this.captureActiveSession(request.sessionFile);
		} catch (error) {
			this.resetState();
			this.post({ type: "failed", generation: this.generation, error: errorMessage(error) });
			return;
		}
		// The initial scan is not a change, and every revision starts at 0 for the generation; the ready response
		// announces what became available instead.
		this.changedSessionIds = new Set();
		this.invalidatedSessionIds = new Map();
		const indexed = [...this.recordsById.values()].filter((record) => record.state !== undefined);
		this.post({
			type: "ready",
			generation: this.generation,
			coverage: this.computeCoverage(),
			// Above the listing ceiling the consumer learns the same limit from `listSessions`.
			...(indexed.length <= TRANSCRIPT_RECALL_MAX_LISTED_SESSIONS
				? { change: { sessionIds: indexed.map((record) => record.sessionId), invalidatedSessionIds: [] } }
				: {}),
		});
	}

	private query(request: TranscriptRecallQueryRequest): void {
		try {
			this.runQuery(request);
		} catch (error) {
			this.failureReason("query", error);
			this.post({
				type: "queryFailed",
				generation: this.generation,
				requestId: request.requestId,
				error: errorMessage(error),
			});
		}
	}

	private runQuery(request: TranscriptRecallQueryRequest): void {
		this.flushIngests();
		const hits = this.index.query(request.query, {
			k: request.maxResults,
			minScore: MIN_SCORE,
			maxSnippetChars: TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS,
			includeAlternateBranches: request.includeAlternateBranches,
			includeCurrentSession: request.includeCurrentSession,
		});
		this.post({ type: "result", generation: this.generation, requestId: request.requestId, hits });
	}

	private handle(request: TranscriptRecallWorkerRequest): void {
		if (request.type === "shutdown") {
			this.post({ type: "stopped", generation: request.generation });
			this.port.close();
			return;
		}
		if (request.type === "initialize") {
			this.initialize(request);
			return;
		}
		if (request.generation !== this.generation) return;
		// Each request may re-read recorded failed sources once (see refreshFailedSources).
		this.failuresRefreshed = false;
		switch (request.type) {
			case "ingest":
				this.receivedIngestSeq = Math.max(this.receivedIngestSeq, request.seq);
				this.queueIngest(request.sessionFile, request.rewritten);
				break;
			case "query":
				this.query(request);
				break;
			case "sessions":
				this.flushIngests();
				this.post({
					type: "sessions",
					generation: this.generation,
					requestId: request.requestId,
					result: this.guarded("sessions", () => this.listSessions()),
				});
				break;
			case "lineage":
				this.flushIngests();
				this.post({
					type: "lineage",
					generation: this.generation,
					requestId: request.requestId,
					result: this.guarded("lineage", () => this.readLineage(request)),
				});
				break;
			case "verify":
				this.flushIngests();
				this.post({
					type: "verify",
					generation: this.generation,
					requestId: request.requestId,
					result: this.guarded("verify", () => this.verifyRanges(request)),
				});
				break;
			case "source":
				this.flushIngests();
				this.post({
					type: "source",
					generation: this.generation,
					requestId: request.requestId,
					result: this.guarded("source", () => this.readSource(request)),
				});
				break;
		}
	}
}
