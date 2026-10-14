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
	/** Opens this session's entries on demand. Only one session is resident/importing at a time. */
	entries(): AsyncIterable<SessionEntry>;
}

export interface ContinuousChatLegacySkip {
	sessionId: string;
	reason: string;
}

export interface ContinuousChatLegacyListing {
	/** Readable sessions in import order. Each one's entries keep their file order. */
	readonly sessions: readonly ContinuousChatLegacySession[];
	/** Sources that cannot currently be read. They block completion and are retried on the next activation. */
	readonly blocked: readonly ContinuousChatLegacySkip[];
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
	ingestor: Pick<ContinuousChatIngestor, "importLegacySession" | "settled">;
	now(): string;
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
 * Imports every eligible session once (up to the most recent bounded window) and then writes the marker. Nothing is
 * written when the marker already exists. The marker is written only after every queued note has settled, so an
 * interrupted import is repeated, and its duplicate keys make the repeat safe.
 */
export async function importContinuousChatLegacyHistory(options: ContinuousChatLegacyImportOptions): Promise<void> {
	if ((await options.marker.read()) !== undefined) return;
	const listing = await options.source.sessions();
	const skipped: ContinuousChatLegacySkip[] = [];
	for (const entry of listing.blocked) {
		if (entry.sessionId === options.currentSessionId) continue;
		skipped.push({ sessionId: entry.sessionId, reason: entry.reason });
	}
	const eligible: ContinuousChatLegacySession[] = [];
	for (const session of listing.sessions) {
		if (session.sessionId === options.currentSessionId) continue;
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
	const cutoff = Math.max(0, eligible.length - CONTINUOUS_CHAT_MAX_IMPORTED_LEGACY_SESSIONS);
	for (let index = 0; index < cutoff; index++) {
		const session = eligible[index];
		if (session) skipped.push({ sessionId: session.sessionId, reason: "superseded_by_recent_history" });
	}
	let importedSessions = 0;
	for (const session of eligible.slice(cutoff)) {
		try {
			await options.ingestor.importLegacySession(session.sessionId, session.entries());
			importedSessions++;
		} catch (error) {
			skipped.push({
				sessionId: session.sessionId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	await options.ingestor.settled();
	await options.marker.write({ version: 1, completedAt: options.now(), importedSessions, skipped });
}
