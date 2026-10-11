import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { classifyCustomEntryPersisted } from "./spawned-usage-receipt.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, type SemanticUsageReport } from "./usage-records.ts";

export interface SemanticUsageLedgerIdentity {
	readonly sessionId: string;
	readonly sessionFile?: string;
	/** Always present: the header's timestamp when it is a usable string, otherwise {@link UNKNOWN_HEADER_TIMESTAMP}. */
	readonly headerTimestamp: string;
	/** Whether the session writes a file. An in-memory session has no sidecar and no physical row. */
	readonly persisted: boolean;
}

export interface SemanticUsageCanonicalRow {
	readonly entryId: string;
	readonly data: unknown;
}

/** The session ledger the usage owner writes through: identity, the canonical append and its physical evidence. */
export interface SemanticUsageLedgerPort {
	identity(): SemanticUsageLedgerIdentity;
	/** The first canonical row (in memory, buffered rows included) that carries this report identity. */
	findCanonical(reportId: string): SemanticUsageCanonicalRow | undefined;
	/** Appends one report row. Throws when the ledger cannot be written; nothing is published then. */
	append(report: SemanticUsageReport): string;
	/** Whether the row is in the session file. A row buffered before the first reply is `pending`, never `persisted`. */
	physicalState(entryId: string, report: SemanticUsageReport): "persisted" | "pending" | "conflict";
	/** Fires after committed entries reach the file. Synchronous with the write: a listener must only schedule work. */
	onPersisted(listener: () => void): () => void;
	/** Whether a failed session write left the file's state unknown: the manager refuses appends until the file is reopened. */
	persistenceUncertain(): boolean;
}

/** The JSON form of a report or of a stored row: the one comparison every identity check goes through. */
export function normalizedReport(report: unknown): unknown {
	return JSON.parse(JSON.stringify(report));
}

/**
 * The header timestamp the journal binds to. The kernel does not validate it, so a missing, empty, non-string or oversized
 * value binds this fixed marker instead: the journal's own record format accepts any value bound this way, and the same
 * value is written and compared on every read.
 */
export const UNKNOWN_HEADER_TIMESTAMP = "unknown";
const MAX_HEADER_TIMESTAMP_CHARS = 200;

export function normalizedHeaderTimestamp(value: unknown): string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_HEADER_TIMESTAMP_CHARS
		? value
		: UNKNOWN_HEADER_TIMESTAMP;
}

export function createSessionManagerLedgerPort(manager: SessionManager): SemanticUsageLedgerPort {
	const canonical = new Map<string, SemanticUsageCanonicalRow>();
	let indexedCount = 0;
	// Entries are append-only, so only the suffix appended since the last lookup is scanned.
	const indexAppended = (): void => {
		const count = manager.getEntryCount();
		if (count < indexedCount) {
			canonical.clear();
			indexedCount = 0;
		}
		for (const entry of manager.getEntriesSince(indexedCount)) {
			if (entry.type !== "custom" || entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) continue;
			const reportId = isPlainRecord(entry.data) ? entry.data.reportId : undefined;
			if (typeof reportId === "string" && !canonical.has(reportId)) {
				canonical.set(reportId, { entryId: entry.id, data: entry.data });
			}
		}
		indexedCount = count;
	};
	return {
		identity: () => {
			const sessionFile = manager.getSessionFile();
			return {
				sessionId: manager.getSessionId(),
				...(sessionFile !== undefined ? { sessionFile } : {}),
				headerTimestamp: normalizedHeaderTimestamp(manager.getHeader()?.timestamp),
				persisted: manager.isPersisted() && sessionFile !== undefined,
			};
		},
		findCanonical: (reportId) => {
			indexAppended();
			return canonical.get(reportId);
		},
		append: (report) => manager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, report),
		physicalState: (entryId, report) => {
			const expected = normalizedReport(report);
			return classifyCustomEntryPersisted(manager, entryId, SEMANTIC_USAGE_CUSTOM_TYPE, (data) =>
				isDeepStrictEqual(data, expected),
			);
		},
		onPersisted: (listener) => manager.onEntriesPersisted(() => listener()),
		persistenceUncertain: () => manager.isPersistenceStateUncertain(),
	};
}
