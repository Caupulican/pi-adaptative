/**
 * Legacy import: the project's earlier sessions enter the chat once, as `note` records, through the ingestor and its
 * one append path. The source decides what is readable and what is forgotten; this module decides only what it can
 * log. The marker records completion with every session that was not imported and the real reason.
 */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { continuousChatDay } from "./continuous-chat-contracts.ts";
import type { ContinuousChatIngestor } from "./continuous-chat-ingest.ts";

export interface ContinuousChatLegacySession {
	sessionId: string;
	/** The session's start time: the first import order key. */
	timestamp: string;
	/** The session file name: the tie-break after the time. */
	file: string;
	/** What was repaired, in memory only, to read the file as a session; absent for an intact file. */
	repaired?: string;
	/**
	 * Opens this session's entries on demand. Only one session is resident/importing at a time. A line that is not a
	 * session entry throws `ContinuousChatLegacyContentError`; any other failure is an I/O failure.
	 */
	entries(): AsyncIterable<SessionEntry>;
}

export interface ContinuousChatLegacySkip {
	sessionId: string;
	reason: string;
}

/** Historical listing failures identify a filename, since no usable session identity was read. */
export const CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS = {
	inspection: "the file cannot be inspected:",
	read: "the file cannot be read:",
	id: "the session header's id is not a valid session id",
	header: "the first line is not a session header",
} as const;

/** A copy of a session already listed from another file. It is recorded once and never retried. */
export const CONTINUOUS_CHAT_LEGACY_DUPLICATE_REASON =
	"the same session id is already listed from another session file";

/** A session file line that is not one session entry: a permanent fault of the file's content, never of reading it. */
export class ContinuousChatLegacyContentError extends Error {
	/** The fault as the import records it: the file name, the line number and what is wrong with the line. */
	readonly reason: string;

	constructor(path: string, reason: string) {
		super(`Legacy session ${path} has malformed content: ${reason}`);
		this.name = "ContinuousChatLegacyContentError";
		this.reason = reason;
	}
}

export interface ContinuousChatLegacyListing {
	/** Readable sessions in import order, intact or repaired. Each one's entries keep their file order. */
	readonly sessions: readonly ContinuousChatLegacySession[];
	/** Sources that cannot currently be read. They block completion and are retried on the next activation. */
	readonly blocked: readonly ContinuousChatLegacySkip[];
	/** Sources whose content can never be read as a session. They are recorded as skips with their real reason. */
	readonly invalid: readonly ContinuousChatLegacySkip[];
}

/** The durable record that the one-time import completed: what it imported, and what it skipped with the real reason. */
export interface ContinuousChatLegacyImportState {
	version: 1;
	completedAt: string;
	importedSessions: number;
	skipped: ContinuousChatLegacySkip[];
}

/** The import's marker. The migration ledger (`migration.json`) implements it; no other marker exists. */
export interface ContinuousChatLegacyImportMarker {
	read(): Promise<ContinuousChatLegacyImportState | undefined>;
	write(state: ContinuousChatLegacyImportState): Promise<void>;
}

/** Where the earlier sessions come from, and which of them were forgotten. */
export interface ContinuousChatLegacySource {
	sessions(): Promise<ContinuousChatLegacyListing>;
	isForgotten(sessionId: string): Promise<boolean>;
}

export interface ContinuousChatLegacyImportOptions {
	source: ContinuousChatLegacySource;
	marker: ContinuousChatLegacyImportMarker;
	/** The live session. It is logged live, so it is neither imported nor recorded as skipped. */
	currentSessionId: string;
	/** Attached ICM sessions recover through the host's canonical path, never as legacy notes. */
	activeSessionIds: ReadonlySet<string>;
	ingestor: Pick<ContinuousChatIngestor, "importLegacySession" | "settled">;
	now(): string;
	/** Reports each repaired source and each skipped malformed source once, when the marker first records it. */
	note?(message: string): void;
}

/** The reason a session cannot be ordered in the chat, or undefined when its start time is a loggable day. */
function unsupportedReason(session: ContinuousChatLegacySession): string | undefined {
	try {
		continuousChatDay(session.timestamp);
		return undefined;
	} catch {
		return `unsupported session start time: ${session.timestamp}`;
	}
}

const CONTINUOUS_CHAT_MAX_IMPORTED_LEGACY_SESSIONS = 8;

/**
 * The content fault that keeps a session's entries from being imported, or undefined when every entry reads. Read
 * failures rethrow: they are transient and keep the import incomplete.
 */
async function contentFault(session: ContinuousChatLegacySession): Promise<string | undefined> {
	try {
		for await (const entry of session.entries()) void entry;
		return undefined;
	} catch (error) {
		if (error instanceof ContinuousChatLegacyContentError) return error.reason;
		throw error;
	}
}

function skipKey(entry: ContinuousChatLegacySkip): string {
	return `${entry.sessionId}\u0000${entry.reason}`;
}

/**
 * Imports every eligible session once (up to the most recent bounded window) and then writes the marker. Nothing is
 * written for an already-complete marker. Older markers that incorrectly finalized failures retry only those recorded
 * sources, within the original eight-session allowance. Their completion time stays fixed for the host's later-session
 * recovery. A source whose content can never be read as a session is recorded as a skip with its real cause instead
 * of blocking completion, and a session in the import window whose body holds such a line is skipped the same way
 * before anything of it is imported, leaving its place to an older one. Repaired and malformed sources are reported
 * through `note` once, when the marker first records them. The marker is written only after every queued note has
 * settled; source keys make interrupted retries safe.
 */
export async function importContinuousChatLegacyHistory(options: ContinuousChatLegacyImportOptions): Promise<void> {
	const previous = await options.marker.read();
	const retryEntries: ContinuousChatLegacySkip[] = [];
	const skipped: ContinuousChatLegacySkip[] = [];
	const intentional = new Set<string>();
	/** Skips recorded with these exact reasons are already reported. */
	const recorded = new Set((previous?.skipped ?? []).map(skipKey));
	/** Skips whose source is malformed: each is reported when first recorded. */
	const malformed = new Set<string>();
	for (const entry of previous?.skipped ?? []) {
		if (entry.reason === CONTINUOUS_CHAT_LEGACY_DUPLICATE_REASON) {
			// An ignored duplicate copy is not an exclusion of the canonical session's failed import.
			skipped.push(entry);
		} else if (
			entry.reason === "forgotten" ||
			entry.reason === "superseded_by_recent_history" ||
			entry.reason.startsWith("unsupported session start time: ")
		) {
			skipped.push(entry);
			intentional.add(entry.sessionId);
		} else {
			retryEntries.push(entry);
		}
	}
	if (previous !== undefined && retryEntries.length === 0) return;
	const listing = await options.source.sessions();
	const excluded = new Set([...options.activeSessionIds, options.currentSessionId]);
	const blocked: ContinuousChatLegacySkip[] = [];
	let candidates = listing.sessions;
	if (previous !== undefined) {
		const byId = new Map(listing.sessions.map((session) => [session.sessionId, session]));
		const byFile = new Map<string, ContinuousChatLegacySession[]>();
		for (const session of listing.sessions) {
			const copies = byFile.get(session.file) ?? [];
			copies.push(session);
			byFile.set(session.file, copies);
		}
		const retryIds = new Set<string>();
		for (const entry of retryEntries) {
			const filenameIdentity = Object.values(CONTINUOUS_CHAT_LEGACY_FILE_FAILURE_REASONS).some((reason) =>
				entry.reason.startsWith(reason),
			);
			const exact = filenameIdentity ? undefined : byId.get(entry.sessionId);
			const aliases = filenameIdentity ? (byFile.get(entry.sessionId) ?? []) : [];
			if (exact === undefined && aliases.length > 1) {
				blocked.push({ sessionId: entry.sessionId, reason: "the failed filename identifies multiple sessions" });
				continue;
			}
			const session = exact ?? aliases[0];
			const sessionId = session?.sessionId ?? (filenameIdentity ? undefined : entry.sessionId);
			if (sessionId !== undefined && excluded.has(sessionId)) {
				// Keep the failure for a later activation; canonical recovery owns any attached session now.
				skipped.push(entry);
				continue;
			}
			// A filename alias must not override an intentional exclusion of the canonical identity.
			if (sessionId !== undefined && intentional.has(sessionId)) continue;
			if (session === undefined) {
				if (sessionId !== undefined && (await options.source.isForgotten(sessionId))) {
					// A known forgotten identity needs no readable source, and must never be resurrected by repair.
					skipped.push({ sessionId, reason: "forgotten" });
					continue;
				}
				const unreadable = listing.blocked.find((source) => source.sessionId === entry.sessionId);
				// Still malformed: a permanent fault, recorded again with its current cause instead of blocking.
				const invalid =
					unreadable === undefined
						? listing.invalid.find((source) => source.sessionId === entry.sessionId)
						: undefined;
				if (invalid !== undefined) {
					skipped.push(invalid);
					malformed.add(skipKey(invalid));
					continue;
				}
				blocked.push(
					unreadable ?? {
						sessionId: entry.sessionId,
						reason: "the previously failed session source is no longer listed",
					},
				);
				continue;
			}
			retryIds.add(session.sessionId);
		}
		candidates = listing.sessions.filter((session) => retryIds.has(session.sessionId));
	} else {
		blocked.push(...listing.blocked.filter((entry) => !excluded.has(entry.sessionId)));
		for (const entry of listing.invalid) {
			if (excluded.has(entry.sessionId)) continue;
			skipped.push(entry);
			malformed.add(skipKey(entry));
		}
	}
	if (blocked.length > 0) {
		const causes = blocked.map((entry) => `${entry.sessionId}: ${entry.reason}`).join("; ");
		throw new Error(`Legacy memory import is incomplete and will retry: ${causes}`);
	}
	const eligible: ContinuousChatLegacySession[] = [];
	for (const session of candidates) {
		if (excluded.has(session.sessionId)) continue;
		if (await options.source.isForgotten(session.sessionId)) {
			skipped.push({ sessionId: session.sessionId, reason: "forgotten" });
			continue;
		}
		const unsupported = unsupportedReason(session);
		if (unsupported !== undefined) {
			skipped.push({ sessionId: session.sessionId, reason: unsupported });
			continue;
		}
		eligible.push(session);
	}
	const importedBefore = previous?.importedSessions ?? 0;
	const allowance = Math.max(0, CONTINUOUS_CHAT_MAX_IMPORTED_LEGACY_SESSIONS - importedBefore);
	// Newest first, every entry is read before any is imported, so a malformed body never fails the import midway.
	const selected: ContinuousChatLegacySession[] = [];
	let cutoff = eligible.length;
	while (cutoff > 0 && selected.length < allowance) {
		cutoff--;
		const session = eligible[cutoff];
		if (!session) continue;
		const fault = await contentFault(session);
		if (fault === undefined) {
			selected.unshift(session);
			continue;
		}
		const skip = { sessionId: session.sessionId, reason: fault };
		skipped.push(skip);
		malformed.add(skipKey(skip));
	}
	for (let index = 0; index < cutoff; index++) {
		const session = eligible[index];
		if (session) skipped.push({ sessionId: session.sessionId, reason: "superseded_by_recent_history" });
	}
	let importedSessions = importedBefore;
	for (const session of selected) {
		await options.ingestor.importLegacySession(session.sessionId, session.entries());
		importedSessions++;
	}
	await options.ingestor.settled();
	await options.marker.write({
		version: 1,
		completedAt: previous?.completedAt ?? options.now(),
		importedSessions,
		skipped,
	});
	const repaired = new Map(
		listing.sessions
			.filter((session) => session.repaired !== undefined)
			.map((session) => [session.sessionId, session]),
	);
	for (const session of selected) {
		if (session.repaired === undefined) continue;
		options.note?.(
			`Legacy memory import repaired ${session.file}: ${session.repaired}; imported as session ${session.sessionId}.`,
		);
	}
	for (const entry of skipped) {
		const key = skipKey(entry);
		if (recorded.has(key)) continue;
		const session = repaired.get(entry.sessionId);
		if (session !== undefined) {
			options.note?.(
				`Legacy memory import repaired ${session.file}: ${session.repaired}; session ${session.sessionId} was not imported: ${entry.reason}.`,
			);
		} else if (malformed.has(key)) {
			options.note?.(`Legacy memory import skipped ${entry.sessionId}: ${entry.reason}.`);
		}
	}
}
