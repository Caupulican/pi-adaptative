/**
 * The ICM legacy-import sources and marker. The sources are the project's earlier sessions (listed read-only, with
 * every skip named) and the legacy forget predicate. The marker, held in `migration.json` beside the chat, is the one
 * durable record that the one-time import has completed: it records how many sessions were imported and every session
 * skipped, each with the real reason. The legacy transcript-summary store is only read here: nothing in it is deleted,
 * rewritten or turned into chat text.
 */

import { readdirSync, type Stats, statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { MAX_SESSION_LINE_CHARS } from "../../kernel/session/session-entry-limits.ts";
import { readSessionHeaderFromDescriptor, type SessionHeader } from "../../kernel/session/session-header.ts";
import { MAX_SESSION_HEADER_BYTES } from "../../kernel/session/session-identity.ts";
import {
	getDefaultSessionDirCandidates,
	isValidSessionId,
	readSessionHeaderResult,
} from "../../kernel/session/session-manager.ts";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import { isMissingFileError, writeFileAtomic } from "../util/atomic-file.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import {
	CONTINUOUS_CHAT_LEGACY_DUPLICATE_REASON,
	CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS,
	ContinuousChatLegacyContentError,
	type ContinuousChatLegacyImportMarker,
	type ContinuousChatLegacyImportState,
	type ContinuousChatLegacySession,
} from "./continuous-chat-legacy-import.ts";
import type { TranscriptSummaryStore } from "./transcript-summary-store.ts";

export const CONTINUOUS_CHAT_MIGRATION_SCHEMA_VERSION = 1;
export const CONTINUOUS_CHAT_MIGRATION_FILE = "migration.json";

/** The live project's storage authority; metadata never gets an unfenced file-only writer. */
export interface ContinuousChatMetadataStore {
	readonly rootDir: string;
	mutateMetadata<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** The file's envelope. Its schema version is the file's own; `state.version` is the import state's. */
interface ContinuousChatMigrationFile {
	schemaVersion: typeof CONTINUOUS_CHAT_MIGRATION_SCHEMA_VERSION;
	state: ContinuousChatLegacyImportState;
}

/** A `migration.json` that exists but does not parse as this schema. It is kept as it is, never rebuilt. */
export class ContinuousChatMigrationCorruptError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Continuous-chat migration marker ${path} is damaged (${reason}); it was left in place and not rebuilt.`);
		this.name = "ContinuousChatMigrationCorruptError";
		this.path = path;
	}
}

/** The legacy forget state is unknown or unavailable, so no legacy session can be decided and nothing is imported. */
export class ContinuousChatMigrationBlockedError extends Error {
	constructor(reason: string) {
		super(`Legacy memory import is blocked and nothing was imported: ${reason}`);
		this.name = "ContinuousChatMigrationBlockedError";
	}
}

/**
 * The legacy forget state as far as it can be proven. `unknown` and `unavailable` carry their reason and decide
 * nothing: the store never reads an unknown state as "nothing was forgotten".
 */
type ContinuousChatLegacyForgets =
	| { status: "ok"; isForgotten(sessionId: string): boolean }
	| { status: "unknown" | "unavailable"; reason: string };

async function directoryExists(path: string, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	try {
		await stat(path);
		signal?.throwIfAborted();
		return true;
	} catch (error) {
		signal?.throwIfAborted();
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

/**
 * Reads the legacy forget state without a writer. A legacy root that does not exist has recorded no forget, since the
 * forget file lives beside it. Otherwise read only the store's permanent-forget view; unrelated summary nodes and
 * their integrity scans are not prerequisites for deciding which sessions may be imported.
 */
async function readLegacyForgets(
	legacy: Pick<TranscriptSummaryStore, "root" | "readForgottenSessions">,
	deadlineAt?: number,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacyForgets> {
	if (!(await directoryExists(legacy.root, signal))) return { status: "ok", isForgotten: () => false };
	const forgotten = await legacy.readForgottenSessions(deadlineAt === undefined ? {} : { deadlineAt });
	signal?.throwIfAborted();
	if (forgotten.status !== "ok") return { status: forgotten.status, reason: forgotten.reason };
	const { sessions } = forgotten;
	return { status: "ok", isForgotten: (sessionId) => sessions.has(sessionId) };
}

/**
 * The real forget predicate of the legacy import. The legacy store's forget state is read once, when the predicate is
 * made. An unknown or unavailable state throws `ContinuousChatMigrationBlockedError` here, before any session is
 * decided, so no import rests on evidence that cannot be proven.
 */
export async function createContinuousChatLegacyForgetPredicate(
	legacy: Pick<TranscriptSummaryStore, "root" | "readForgottenSessions">,
	deadlineAt?: number,
	signal?: AbortSignal,
): Promise<(sessionId: string, signal?: AbortSignal) => Promise<boolean>> {
	const forgets = await readLegacyForgets(legacy, deadlineAt, signal);
	if (forgets.status !== "ok") throw new ContinuousChatMigrationBlockedError(forgets.reason);
	return async (sessionId, currentSignal) => {
		currentSignal?.throwIfAborted();
		return forgets.isForgotten(sessionId);
	};
}

/**
 * Validates an import state and returns its normalized copy, or undefined when it does not match the schema. Every
 * skipped session carries a non-empty id and reason: a skip is never recorded without its real cause.
 */
function parseImportState(value: unknown): ContinuousChatLegacyImportState | undefined {
	if (!isPlainRecord(value) || value.version !== 1) return undefined;
	const { completedAt, importedSessions, skipped } = value;
	if (typeof completedAt !== "string" || !isNonNegativeSafeInteger(importedSessions)) return undefined;
	if (!Array.isArray(skipped)) return undefined;
	const normalized: { sessionId: string; reason: string }[] = [];
	for (const entry of skipped) {
		if (!isPlainRecord(entry) || typeof entry.sessionId !== "string" || typeof entry.reason !== "string") {
			return undefined;
		}
		if (entry.sessionId.length === 0 || entry.reason.length === 0) return undefined;
		normalized.push({ sessionId: entry.sessionId, reason: entry.reason });
	}
	return { version: 1, completedAt, importedSessions, skipped: normalized };
}

async function readMigrationJsonFile(path: string, signal?: AbortSignal): Promise<unknown> {
	signal?.throwIfAborted();
	let raw: string;
	try {
		raw = await readFile(path, { encoding: "utf8", signal });
	} catch (error) {
		signal?.throwIfAborted();
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	signal?.throwIfAborted();
	try {
		return JSON.parse(raw);
	} catch {
		throw new ContinuousChatMigrationCorruptError(path, "not JSON");
	}
}

/** The recorded import state, or undefined while no import has completed. A damaged file is an error, never rebuilt. */
async function readMarkerState(
	path: string,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacyImportState | undefined> {
	const value = await readMigrationJsonFile(path, signal);
	if (value === undefined) return undefined;
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_MIGRATION_SCHEMA_VERSION) {
		throw new ContinuousChatMigrationCorruptError(path, "schema mismatch");
	}
	const state = parseImportState(value.state);
	if (state === undefined) throw new ContinuousChatMigrationCorruptError(path, "import state mismatch");
	return state;
}

/**
 * The legacy-import marker over `migration.json` in the chat's root directory, the only durable record of the import.
 * `read` is undefined until the import writes its state. `write` replaces the file atomically with the normalized state
 * and refuses a state that does not match the schema.
 */
export function createContinuousChatLegacyImportMarker(
	store: ContinuousChatMetadataStore,
): ContinuousChatLegacyImportMarker {
	const path = join(store.rootDir, CONTINUOUS_CHAT_MIGRATION_FILE);
	return {
		read: (signal) => readMarkerState(path, signal),
		write: async (state, signal) => {
			const normalized = parseImportState(state);
			if (normalized === undefined) {
				throw new TypeError(
					"Legacy import state does not match the migration schema; migration.json was not written.",
				);
			}
			const file: ContinuousChatMigrationFile = {
				schemaVersion: CONTINUOUS_CHAT_MIGRATION_SCHEMA_VERSION,
				state: normalized,
			};
			await store.mutateMetadata(() => writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`), signal);
		},
	};
}

export const CONTINUOUS_CHAT_SESSIONS_SCHEMA_VERSION = 1;
export const CONTINUOUS_CHAT_SESSIONS_FILE = "sessions.json";

export interface ContinuousChatTrackedSession {
	readonly sessionId: string;
	readonly sessionFile?: string;
}

export interface ContinuousChatSessionsState {
	readonly active: readonly ContinuousChatTrackedSession[];
	readonly settled: readonly string[];
}

export interface ContinuousChatSessionLedger {
	read(signal?: AbortSignal): Promise<ContinuousChatSessionsState>;
	recordAttached(sessionId: string, sessionFile?: string, signal?: AbortSignal): Promise<void>;
	markSettled(sessionIds: readonly string[], signal?: AbortSignal): Promise<void>;
}

interface ContinuousChatSessionsFile {
	schemaVersion: typeof CONTINUOUS_CHAT_SESSIONS_SCHEMA_VERSION;
	active: readonly ContinuousChatTrackedSession[];
	settled: readonly string[];
}

function parseSessionsState(value: unknown): ContinuousChatSessionsState | undefined {
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_SESSIONS_SCHEMA_VERSION) {
		return undefined;
	}
	const { active, settled } = value;
	if (!Array.isArray(active) || !Array.isArray(settled)) return undefined;
	const normalizedActive: ContinuousChatTrackedSession[] = [];
	for (const entry of active) {
		if (!isPlainRecord(entry) || typeof entry.sessionId !== "string" || entry.sessionId.length === 0) {
			return undefined;
		}
		if (
			entry.sessionFile !== undefined &&
			(typeof entry.sessionFile !== "string" || entry.sessionFile.length === 0)
		) {
			return undefined;
		}
		normalizedActive.push({
			sessionId: entry.sessionId,
			...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
		});
	}
	const normalizedSettled: string[] = [];
	for (const id of settled) {
		if (typeof id !== "string" || id.length === 0) return undefined;
		normalizedSettled.push(id);
	}
	return { active: normalizedActive, settled: normalizedSettled };
}

async function readSessionsState(path: string, signal?: AbortSignal): Promise<ContinuousChatSessionsState> {
	const value = await readMigrationJsonFile(path, signal);
	if (value === undefined) return { active: [], settled: [] };
	const state = parseSessionsState(value);
	if (state === undefined) {
		throw new ContinuousChatMigrationCorruptError(path, "sessions state mismatch");
	}
	return state;
}

export function createContinuousChatSessionLedger(store: ContinuousChatMetadataStore): ContinuousChatSessionLedger {
	const path = join(store.rootDir, CONTINUOUS_CHAT_SESSIONS_FILE);
	return {
		read: (signal) => readSessionsState(path, signal),
		recordAttached: (sessionId: string, sessionFile?: string, signal?: AbortSignal) =>
			store.mutateMetadata(async () => {
				const current = await readSessionsState(path);
				const existing = current.active.find((entry) => entry.sessionId === sessionId);
				const resolvedSessionFile = sessionFile ?? existing?.sessionFile;
				const updatedEntry: ContinuousChatTrackedSession = {
					sessionId,
					...(resolvedSessionFile ? { sessionFile: resolvedSessionFile } : {}),
				};
				const nextActive = current.active.filter((entry) => entry.sessionId !== sessionId).concat(updatedEntry);
				const nextSettled = current.settled.filter((id) => id !== sessionId);
				const file: ContinuousChatSessionsFile = {
					schemaVersion: CONTINUOUS_CHAT_SESSIONS_SCHEMA_VERSION,
					active: nextActive,
					settled: nextSettled,
				};
				await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
			}, signal),
		markSettled: (sessionIds: readonly string[], signal?: AbortSignal) =>
			store.mutateMetadata(async () => {
				const current = await readSessionsState(path);
				const toSettle = new Set(sessionIds.filter((id) => id.length > 0));
				const nextActive = current.active.filter((entry) => !toSettle.has(entry.sessionId));
				const settledSet = new Set(current.settled);
				for (const id of toSettle) {
					settledSet.add(id);
				}
				const nextSettled = Array.from(settledSet);
				const file: ContinuousChatSessionsFile = {
					schemaVersion: CONTINUOUS_CHAT_SESSIONS_SCHEMA_VERSION,
					active: nextActive,
					settled: nextSettled,
				};
				await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
			}, signal),
	};
}

/** The project whose legacy sessions are listed: the same scope the transcript index reads. */
export interface ContinuousChatLegacySessionScope {
	readonly cwd: string;
	readonly agentDir: string;
}

export interface ContinuousChatLegacySessionSkip {
	/** The session id from the header, or the file name when the header gives no usable id. */
	readonly sessionId: string;
	/** The real cause the session was not listed. */
	readonly reason: string;
}

export interface ContinuousChatLegacySessionListing {
	/** Readable sessions, intact or repaired, by start time then file name. Each one's entries keep their file order. */
	readonly sessions: ContinuousChatLegacySession[];
	/** Sources that cannot be read now (inspection or read failures): transient, they block completion. */
	readonly blocked: ContinuousChatLegacySessionSkip[];
	/** Sources whose content can never be read as a session: permanent, recorded as skips with their cause. */
	readonly invalid: ContinuousChatLegacySessionSkip[];
}

/** One session file as the legacy import reads it: a session, a transient failure, a permanent fault, or nothing. */
export type ContinuousChatLegacySessionReading =
	| { kind: "session"; session: ContinuousChatLegacySession }
	| { kind: "blocked"; sessionId: string; reason: string }
	| { kind: "invalid"; sessionId: string; reason: string }
	| { kind: "empty" };

/** The repair of a file that holds a session's body without its header line. The file itself is never rewritten. */
export const CONTINUOUS_CHAT_LEGACY_HEADER_REPAIR = "session header reconstructed from the file name";

/** The kernel's session file name: `<start time with ':' and '.' as '-'>_<session id>.jsonl`. */
const SESSION_FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;
const LEGACY_LIST_YIELD_BATCH = 32;

function causeText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The loader keeps every truthy JSON value; a session entry is an object with a string type and id. */
function isSessionEntryShape(value: unknown): value is { type: string; id: string } {
	return isPlainRecord(value) && typeof value.type === "string" && typeof value.id === "string";
}

/**
 * The `.jsonl` files of one session directory, in name order. A missing directory holds no sessions. A directory that
 * exists but cannot be listed blocks the import: its sessions are unknown, so none may be silently left out.
 */
function listSessionFileNames(directory: string): string[] {
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw new ContinuousChatMigrationBlockedError(
			`the session directory ${directory} cannot be listed: ${causeText(error)}`,
		);
	}
}

type SessionBodyLine = { ok: true; entry: SessionEntry } | { ok: false; fault: string };

type LegacySourceIdentity = { kind: "header"; header: SessionHeader } | { kind: "headerless"; revision: Stats };

/** One non-empty line read as a session body entry, or what keeps it from being one. */
function parseSessionBodyLine(line: string): SessionBodyLine {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { ok: false, fault: "is not JSON" };
	}
	if (!isSessionEntryShape(value) || value.type === "session") return { ok: false, fault: "is not one session entry" };
	return { ok: true, entry: value as SessionEntry };
}

/**
 * Reads the descriptor whose identity was checked before the first entry is yielded. Headerless recovery instead
 * binds the exact file revision it validated. Changed sources and oversized lines remain retryable read failures;
 * malformed body entries retain their separate content classification.
 */
export async function* streamLegacySessionEntries(
	path: string,
	identity: LegacySourceIdentity,
	signal?: AbortSignal,
): AsyncGenerator<SessionEntry> {
	signal?.throwIfAborted();
	const before = await stat(path);
	signal?.throwIfAborted();
	if (!before.isFile()) throw new Error(`Legacy session ${path} is not a regular file.`);
	const file = await open(path, "r");
	try {
		const opened = await file.stat();
		signal?.throwIfAborted();
		if (!opened.isFile() || !sameFileVersion(before, opened))
			throw new Error(`Legacy session ${path} changed while opening it.`);
		if (identity.kind === "headerless") {
			if (!sameFileVersion(identity.revision, opened))
				throw new Error(`Headerless legacy session ${path} changed after validation.`);
		} else {
			const read = readSessionHeaderFromDescriptor(file.fd, MAX_SESSION_HEADER_BYTES);
			const expected = identity.header;
			if (
				!read.ok ||
				read.header.id !== expected.id ||
				read.header.timestamp !== expected.timestamp ||
				read.header.cwd !== expected.cwd ||
				read.header.version !== expected.version ||
				read.header.parentSession !== expected.parentSession
			)
				throw new Error(`Legacy session ${path} no longer matches its listed header.`);
		}
		const assertUnchanged = async (): Promise<void> => {
			const current = await file.stat();
			const currentPath = await stat(path);
			signal?.throwIfAborted();
			if (!sameFileVersion(opened, current) || !sameFileVersion(opened, currentPath))
				throw new Error(`Legacy session ${path} changed during its read; retry the import.`);
		};
		const input = file.createReadStream({
			encoding: "utf8",
			start: 0,
			end: opened.size - 1,
			autoClose: false,
			signal,
		});
		const decoder = new StreamingLineDecoder(MAX_SESSION_LINE_CHARS, { overflow: "throw", lineEndings: "any" });
		let header = identity.kind === "header";
		let lineNumber = 0;
		const body = (line: string): SessionEntry | undefined => {
			lineNumber++;
			if (line.trim() === "") return undefined;
			if (header) {
				header = false;
				return undefined;
			}
			const parsed = parseSessionBodyLine(line);
			if (!parsed.ok)
				throw new ContinuousChatLegacyContentError(path, `${basename(path)}:${lineNumber} ${parsed.fault}`);
			return parsed.entry;
		};
		try {
			for await (const chunk of input) {
				signal?.throwIfAborted();
				if (typeof chunk !== "string") throw new TypeError("Legacy session stream did not decode UTF-8 text.");
				for (const line of decoder.push(chunk)) {
					const entry = body(line);
					if (entry) yield entry;
				}
			}
			signal?.throwIfAborted();
			const last = decoder.finish();
			if (last !== undefined) {
				const entry = body(last);
				if (entry) yield entry;
			}
			await assertUnchanged();
			signal?.throwIfAborted();
		} catch (error) {
			signal?.throwIfAborted();
			// A racing rewrite is unavailable input, not permanent malformed history.
			if (error instanceof ContinuousChatLegacyContentError) await assertUnchanged();
			throw error;
		} finally {
			input.destroy();
		}
	} finally {
		await file.close();
	}
}

/** The session id and start time a kernel session file name carries, or undefined when it carries no usable pair. */
function sessionFileNameIdentity(file: string): { sessionId: string; timestamp: string } | undefined {
	const match = SESSION_FILE_NAME.exec(file);
	if (match === null) return undefined;
	const [, day, hours, minutes, seconds, milliseconds, sessionId] = match;
	// The kernel's header reader admits only ids this rule accepts; a reconstructed header is held to the same rule.
	if (sessionId === undefined || !isValidSessionId(sessionId)) return undefined;
	const timestamp = `${day}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;
	const time = Date.parse(timestamp);
	// The round trip refuses a time the pattern admits but the calendar does not, such as month 13.
	if (Number.isNaN(time) || new Date(time).toISOString() !== timestamp) return undefined;
	return { sessionId, timestamp };
}

/**
 * A file whose first line is not a session header is read as a session only when it holds a session's body without
 * its header: every non-empty line, the first included, is a session entry, and the file name carries the session's id
 * and start time. The header is then reconstructed in memory from the name; the file is never rewritten. Anything else
 * is a permanent fault of the file, listed as invalid with its cause. The whole body is checked here, before listing,
 * so a repaired session never fails midway through an import or a recovery.
 */
async function readHeaderlessSessionFile(
	path: string,
	file: string,
	revision: Stats,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacySessionReading> {
	const headerFault = CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS.header;
	const identity = sessionFileNameIdentity(file);
	if (identity === undefined) {
		return {
			kind: "invalid",
			sessionId: file,
			reason: `${headerFault}; the file name carries no valid session id and start time`,
		};
	}
	let entries = 0;
	try {
		for await (const entry of streamLegacySessionEntries(path, { kind: "headerless", revision }, signal)) {
			void entry;
			entries++;
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof ContinuousChatLegacyContentError)
			return { kind: "invalid", sessionId: file, reason: `${headerFault}; ${error.reason}` };
		return {
			kind: "blocked",
			sessionId: file,
			reason: `${CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS.read} ${causeText(error)}`,
		};
	}
	if (entries === 0) {
		return { kind: "invalid", sessionId: file, reason: `${headerFault}; the file holds no session entry` };
	}
	return {
		kind: "session",
		session: {
			...identity,
			file,
			repaired: CONTINUOUS_CHAT_LEGACY_HEADER_REPAIR,
			entries: (readSignal) => streamLegacySessionEntries(path, { kind: "headerless", revision }, readSignal),
		},
	};
}

/**
 * Reads one session file for the legacy import and ICM recovery. A file that cannot be inspected or read now is
 * blocked: the failure is transient and retried. A file whose header id is not a valid session id, whose header time
 * is not a time, or whose first line is not a session header and that cannot be repaired from its file name is invalid:
 * the fault is in the content and permanent. A zero-byte file holds no session and is not listed.
 */
export async function readContinuousChatLegacySessionFile(
	path: string,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacySessionReading> {
	signal?.throwIfAborted();
	const file = basename(path);
	let inspection: Stats;
	try {
		inspection = statSync(path);
	} catch (error) {
		return {
			kind: "blocked",
			sessionId: file,
			reason: `${CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS.inspection} ${causeText(error)}`,
		};
	}
	if (!inspection.isFile() || inspection.size === 0) return { kind: "empty" };

	const header = readSessionHeaderResult(path);
	if (!header.ok) {
		if (header.reason === "unreadable") {
			return {
				kind: "blocked",
				sessionId: file,
				reason: `${CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS.read} ${causeText(header.cause)}`,
			};
		}
		// A header is present but names an invalid id: nothing may be derived from it, so it is not repaired.
		if (header.reason === "invalid_session_id") {
			return { kind: "invalid", sessionId: file, reason: CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS.id };
		}
		return readHeaderlessSessionFile(path, file, inspection, signal);
	}
	const sessionId = header.header.id;
	const timestamp = header.header.timestamp;
	if (Number.isNaN(Date.parse(timestamp))) {
		return { kind: "invalid", sessionId, reason: "the session header's timestamp is not a valid time" };
	}
	return {
		kind: "session",
		session: {
			sessionId,
			timestamp,
			file,
			entries: (readSignal) =>
				streamLegacySessionEntries(path, { kind: "header", header: header.header }, readSignal),
		},
	};
}

function compareLegacySessions(left: ContinuousChatLegacySession, right: ContinuousChatLegacySession): number {
	const byTime = Date.parse(left.timestamp) - Date.parse(right.timestamp);
	if (byTime !== 0) return byTime;
	if (left.file === right.file) return 0;
	return left.file < right.file ? -1 : 1;
}

/**
 * The legacy sessions of one project, for the one-time import. The scope is the cwd's default session directories,
 * current encoding first, as the transcript index reads them. Sources that cannot be read now block completion with
 * their real cause; sources whose content can never be a session are listed as invalid with theirs. Valid copies of an
 * already-selected session are deduplicated, preserving first-directory precedence, except that an intact file always
 * wins over a header reconstructed from a file name; a repaired copy left out is listed as invalid, so its file stays
 * accounted for. The current session is not excluded here: the caller excludes it, because it is logged live.
 */
export async function listContinuousChatLegacySessions(
	scope: ContinuousChatLegacySessionScope,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacySessionListing> {
	signal?.throwIfAborted();
	const sessions: ContinuousChatLegacySession[] = [];
	const blocked: ContinuousChatLegacySessionSkip[] = [];
	const invalid: ContinuousChatLegacySessionSkip[] = [];
	const listedAt = new Map<string, number>();
	let inspected = 0;
	for (const directory of getDefaultSessionDirCandidates(scope.cwd, scope.agentDir)) {
		signal?.throwIfAborted();
		for (const file of listSessionFileNames(directory)) {
			// Valid headers use synchronous bounded reads. Yield between batches so an
			// actual close/abort event can arrive instead of living only in microtasks.
			if (inspected++ % LEGACY_LIST_YIELD_BATCH === 0) await yieldToEventLoop(undefined, { signal });
			const reading = await readContinuousChatLegacySessionFile(join(directory, file), signal);
			signal?.throwIfAborted();
			if (reading.kind === "empty") continue;
			if (reading.kind === "blocked") {
				blocked.push({ sessionId: reading.sessionId, reason: reading.reason });
				continue;
			}
			if (reading.kind === "invalid") {
				invalid.push({ sessionId: reading.sessionId, reason: reading.reason });
				continue;
			}
			const { session } = reading;
			const index = listedAt.get(session.sessionId);
			if (index === undefined) {
				listedAt.set(session.sessionId, sessions.length);
				sessions.push(session);
				continue;
			}
			const listed = sessions[index];
			if (listed?.repaired !== undefined && session.repaired === undefined) {
				sessions[index] = session;
				invalid.push({ sessionId: listed.file, reason: CONTINUOUS_CHAT_LEGACY_DUPLICATE_REASON });
			} else if (session.repaired !== undefined) {
				invalid.push({ sessionId: session.file, reason: CONTINUOUS_CHAT_LEGACY_DUPLICATE_REASON });
			}
		}
	}
	signal?.throwIfAborted();
	sessions.sort(compareLegacySessions);
	return { sessions, blocked, invalid };
}
