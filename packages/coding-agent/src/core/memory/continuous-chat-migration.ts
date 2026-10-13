/**
 * The ICM legacy-import sources and marker. The sources are the project's earlier sessions (listed read-only, with
 * every skip named) and the legacy forget predicate. The marker, held in `migration.json` beside the chat, is the one
 * durable record that the one-time import has completed: it records how many sessions were imported and every session
 * skipped, each with the real reason. The legacy transcript-summary store is only read here: nothing in it is deleted,
 * rewritten or turned into chat text.
 */

import { createReadStream, readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { getDefaultSessionDirCandidates, readSessionHeaderResult } from "../../kernel/session/session-manager.ts";
import { isMissingFileError, writeFileAtomic } from "../util/atomic-file.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import type {
	ContinuousChatLegacyImportMarker,
	ContinuousChatLegacyImportState,
	ContinuousChatLegacySession,
} from "./continuous-chat-legacy-import.ts";
import type { TranscriptSummaryStore } from "./transcript-summary-store.ts";

export const CONTINUOUS_CHAT_MIGRATION_SCHEMA_VERSION = 1;
export const CONTINUOUS_CHAT_MIGRATION_FILE = "migration.json";

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

async function directoryExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

/**
 * Reads the legacy forget state without a writer. A legacy root that does not exist has recorded no forget, since the
 * forget file lives beside it. Anything else goes through the store's own load, and what that cannot prove is returned
 * with its reason.
 */
async function readLegacyForgets(
	legacy: Pick<TranscriptSummaryStore, "root" | "load">,
	deadlineAt?: number,
): Promise<ContinuousChatLegacyForgets> {
	if (!(await directoryExists(legacy.root))) return { status: "ok", isForgotten: () => false };
	const state = await legacy.load(deadlineAt === undefined ? {} : { deadlineAt });
	if ("status" in state) return { status: "unavailable", reason: state.reason };
	const { forgotten } = state;
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
	legacy: Pick<TranscriptSummaryStore, "root" | "load">,
	deadlineAt?: number,
): Promise<(sessionId: string) => Promise<boolean>> {
	const forgets = await readLegacyForgets(legacy, deadlineAt);
	if (forgets.status !== "ok") throw new ContinuousChatMigrationBlockedError(forgets.reason);
	return async (sessionId) => forgets.isForgotten(sessionId);
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

async function readMigrationJsonFile(path: string): Promise<unknown> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new ContinuousChatMigrationCorruptError(path, "not JSON");
	}
}

/** The recorded import state, or undefined while no import has completed. A damaged file is an error, never rebuilt. */
async function readMarkerState(path: string): Promise<ContinuousChatLegacyImportState | undefined> {
	const value = await readMigrationJsonFile(path);
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
export function createContinuousChatLegacyImportMarker(rootDir: string): ContinuousChatLegacyImportMarker {
	const path = join(rootDir, CONTINUOUS_CHAT_MIGRATION_FILE);
	return {
		read: () => readMarkerState(path),
		write: async (state) => {
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
			await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
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
	read(): Promise<ContinuousChatSessionsState>;
	recordAttached(sessionId: string, sessionFile?: string): Promise<void>;
	markSettled(sessionIds: readonly string[]): Promise<void>;
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

async function readSessionsState(path: string): Promise<ContinuousChatSessionsState> {
	const value = await readMigrationJsonFile(path);
	if (value === undefined) return { active: [], settled: [] };
	const state = parseSessionsState(value);
	if (state === undefined) {
		throw new ContinuousChatMigrationCorruptError(path, "sessions state mismatch");
	}
	return state;
}

export function createContinuousChatSessionLedger(rootDir: string): ContinuousChatSessionLedger {
	const path = join(rootDir, CONTINUOUS_CHAT_SESSIONS_FILE);
	let tail: Promise<void> = Promise.resolve();

	const runSerialized = <T>(action: () => Promise<T>): Promise<T> => {
		const next = tail.then(action);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		read: () => readSessionsState(path),
		recordAttached: (sessionId: string, sessionFile?: string) =>
			runSerialized(async () => {
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
			}),
		markSettled: (sessionIds: readonly string[]) =>
			runSerialized(async () => {
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
			}),
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
	/** Readable sessions, by header timestamp then file name. Each one's entries keep their file order. */
	readonly sessions: ContinuousChatLegacySession[];
	readonly blocked: ContinuousChatLegacySessionSkip[];
}

type LegacySessionReading =
	| { kind: "session"; session: ContinuousChatLegacySession }
	| { kind: "blocked"; sessionId: string; reason: string }
	| { kind: "empty" };

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

/** Streams validated body entries. A malformed line blocks completion, so repairing the file is retried next start. */
export async function* streamLegacySessionEntries(path: string): AsyncGenerator<SessionEntry> {
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	let header = true;
	let lineNumber = 0;
	for await (const line of lines) {
		lineNumber++;
		if (line.trim() === "") continue;
		if (header) {
			header = false;
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new ContinuousChatMigrationBlockedError(`${path}:${lineNumber} is not JSON`);
		}
		if (!isSessionEntryShape(value) || value.type === "session") {
			throw new ContinuousChatMigrationBlockedError(`${path}:${lineNumber} is not one session entry`);
		}
		yield value as SessionEntry;
	}
}

/**
 * Reads one session file with the kernel's read-only loader. The file is skipped, with its cause, when its header is
 * not a usable session header, when it cannot be loaded, or when any non-empty line is not a session entry. The loader
 * drops unparseable lines silently, so they are counted here and never lost unrecorded. A zero-byte file holds no
 * session and is not listed.
 */
async function readLegacySessionFile(path: string, file: string): Promise<LegacySessionReading> {
	let inspection: { file: boolean; size: number };
	try {
		const metadata = statSync(path);
		inspection = { file: metadata.isFile(), size: metadata.size };
	} catch (error) {
		return { kind: "blocked", sessionId: file, reason: `the file cannot be inspected: ${causeText(error)}` };
	}
	if (!inspection.file || inspection.size === 0) return { kind: "empty" };

	const header = readSessionHeaderResult(path);
	if (!header.ok) {
		const reason =
			header.reason === "unreadable"
				? `the file cannot be read: ${causeText(header.cause)}`
				: header.reason === "invalid_session_id"
					? "the session header's id is not a valid session id"
					: "the first line is not a session header";
		return { kind: "blocked", sessionId: file, reason };
	}
	const sessionId = header.header.id;
	const timestamp = header.header.timestamp;
	if (Number.isNaN(Date.parse(timestamp))) {
		return { kind: "blocked", sessionId, reason: "the session header's timestamp is not a valid time" };
	}
	return {
		kind: "session",
		session: { sessionId, timestamp, file, entries: () => streamLegacySessionEntries(path) },
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
 * current encoding first, as the transcript index reads them. Every session that is not listed is named in `skipped`
 * with its real cause. A session id that another file already listed is skipped too, so no entry is imported twice.
 * The current session is not excluded here: the caller excludes it, because it is logged live.
 */
export async function listContinuousChatLegacySessions(
	scope: ContinuousChatLegacySessionScope,
): Promise<ContinuousChatLegacySessionListing> {
	const sessions: ContinuousChatLegacySession[] = [];
	const blocked: ContinuousChatLegacySessionSkip[] = [];
	const listed = new Set<string>();
	for (const directory of getDefaultSessionDirCandidates(scope.cwd, scope.agentDir)) {
		for (const file of listSessionFileNames(directory)) {
			const reading = await readLegacySessionFile(join(directory, file), file);
			if (reading.kind === "empty") continue;
			if (reading.kind === "blocked") {
				blocked.push({ sessionId: reading.sessionId, reason: reading.reason });
				continue;
			}
			const { sessionId } = reading.session;
			if (listed.has(sessionId)) {
				blocked.push({ sessionId, reason: "the same session id is already listed from another session file" });
				continue;
			}
			listed.add(sessionId);
			sessions.push(reading.session);
		}
	}
	sessions.sort(compareLegacySessions);
	return { sessions, blocked };
}
