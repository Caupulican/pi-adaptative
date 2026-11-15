/**
 * A session file a session replacement created (a fork, a clone, an imported copy, a new session) and what its discard
 * must keep: the paid usage rows only the candidate appended after its copied rows, counted within bounds.
 */
import { existsSync, statSync } from "node:fs";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE } from "./cost/usage-records.ts";

/**
 * A session file a replacement created. When the replacement is discarded its file goes, unless it holds paid usage rows that
 * appended after its copy (those stay as evidence). `copyBaseline` marks where the copied rows end in the file: only rows appended
 * after it are the candidate's. Undefined for a new session, which copied no rows.
 */
export interface CreatedSession {
	readonly sessionManager: SessionManager;
	readonly copyBaseline: CopyBaseline | undefined;
}

/**
 * The byte size of a replacement's file once its copied rows are on disk: a row located at or past it was appended by the
 * candidate. `unreadable` when the size cannot be read, so the caller keeps the file.
 */
export type CopyBaseline = { readonly bytes: number } | { readonly unreadable: unknown };

const PAID_ROW_TYPES: ReadonlySet<string> = new Set([SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE]);

/**
 * The copy baseline of a replacement's file as it stands once its copied rows are written. A file not yet written holds no copied
 * bytes yet, so its baseline is 0; a reply written to it later carries the copied rows too, and they then count as kept.
 */
export function copyBaselineOf(path: string | undefined): CopyBaseline {
	if (path === undefined || !existsSync(path)) return { bytes: 0 };
	try {
		return { bytes: statSync(path).size };
	} catch (error: unknown) {
		return { unreadable: error };
	}
}

/** The bounds a discard's paid-row count runs within. Past any one of them the rows are unknown and the file is kept. */
export interface DiscardScanLimits {
	/** Most paid usage rows a discard counts. */
	readonly paidRows: number;
	/** Most session entries a discard walks. */
	readonly entries: number;
	/** Most bytes a discard scans past the copy baseline. */
	readonly scanBytes: number;
}

export const DEFAULT_DISCARD_SCAN_LIMITS: DiscardScanLimits = {
	paidRows: 10_000,
	entries: 1_000_000,
	scanBytes: 64 * 1024 * 1024,
};

function causeText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Paid usage rows the created session's file holds that no other session records: the paid rows located at or past the copy
 * baseline, which only the candidate appended. A copied row is located before the baseline, and a buffered row is not in the
 * file (its retained journal copy, if any, is the disclosure). Unknown when the baseline or the file cannot be read, or when the
 * session holds more than `limits.entries` entries, more than `limits.paidRows` paid rows, or more than `limits.scanBytes` bytes
 * lie past the baseline: the caller keeps the file.
 */
export function countUniquePaidRows(
	created: CreatedSession,
	limits: DiscardScanLimits = DEFAULT_DISCARD_SCAN_LIMITS,
): { readonly rows: number } | { readonly unknown: string } {
	const { copyBaseline, sessionManager } = created;
	try {
		if (copyBaseline !== undefined && "unreadable" in copyBaseline)
			return { unknown: causeText(copyBaseline.unreadable) };
		const paidIds = new Set<string>();
		// The count is read BEFORE the entries are copied: a session larger than the bound is not copied or walked at all, and its
		// file is kept. The walk is over the entry index the manager already holds (one pointer array, no file content).
		if (sessionManager.getEntryCount() > limits.entries) return { unknown: `more than ${limits.entries} entries` };
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || !PAID_ROW_TYPES.has(entry.customType)) continue;
			if (paidIds.size === limits.paidRows) return { unknown: `more than ${limits.paidRows} paid usage rows` };
			paidIds.add(entry.id);
		}
		const located = sessionManager.entryFileOffsetsFrom(paidIds, copyBaseline?.bytes ?? 0, limits.scanBytes);
		if (located === undefined) return { unknown: `more than ${limits.scanBytes} bytes appended after the copy` };
		return { rows: located.size };
	} catch (error: unknown) {
		return { unknown: causeText(error) };
	}
}
