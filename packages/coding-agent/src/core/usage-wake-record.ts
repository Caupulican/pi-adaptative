/**
 * The record a session keeps of how a usage-limit wait ended, so a stop the wait already answered is not waited out again
 * after a restart or by the host that opens a closed bot's session for it. Each record names the stop it answers by when
 * that stop was made (`stopAt`), and answers it and every stop made before it: `resumed` (the turn or goal continued), `lapsed` (nothing waited on it any more: the goal no longer
 * stopped by the limit and the transcript moved on from the refusal),
 * `declined` (the owner's stop ended the wait; it names the owner's stop's time, so it answers every usage stop made until the owner's) and `failed`
 * (the continuation threw and the transcript still ends on the refusal). A failed one is tried again after a delay that
 * doubles with each failure in a row, up to {@link USAGE_WAKE_RETRY_MAX_MS}, with no limit on the tries: a subscription's
 * continuation waits and continues while its usage has room. A stop made after the one a record names (a continued turn
 * that met the limit again) is a new stop and waits on its own. The record is a custom entry, outside the model's context; a build that does not know it ignores it.
 */

import type { SessionManager } from "../kernel/session/session-manager.ts";

export const USAGE_WAKE_CUSTOM_TYPE = "usage_wake";

export type UsageWakeOutcome = "resumed" | "lapsed" | "failed" | "declined";

export interface UsageWakeRecord {
	readonly version: 1;
	readonly outcome: UsageWakeOutcome;
	/** The stop it answers, by when it was made: every usage stop made at or before it is answered. */
	readonly stopAt: number;
	/** When the wait ended, on the provider admission clock: a failed continuation's next try counts from it. */
	readonly at: number;
	/** The continuations of the answered stop that failed in a row; 0 unless `outcome` is `failed`. */
	readonly failures: number;
	/** Set when the owner's stop declined the wait. */
	readonly by?: "owner";
}

/** Where the records are read from: the session's branch. */
export type UsageWakeLog = Pick<SessionManager, "getLatestCustomEntryOnBranch">;
/** Where a record is written: the session's transcript. */
export type UsageWakeWriter = Pick<SessionManager, "appendCustomEntry">;

/** The first delay after a failed continuation. */
const USAGE_WAKE_RETRY_BASE_MS = 60_000;
/** The longest delay between tries of a continuation that keeps failing. */
export const USAGE_WAKE_RETRY_MAX_MS = 30 * 60_000;

const OUTCOMES: ReadonlySet<string> = new Set<UsageWakeOutcome>(["resumed", "lapsed", "failed", "declined"]);

/** The latest record on the session's branch; undefined when none, or when it is not one this build writes. */
export function latestUsageWake(log: UsageWakeLog): UsageWakeRecord | undefined {
	const data = log.getLatestCustomEntryOnBranch(USAGE_WAKE_CUSTOM_TYPE)?.data;
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Partial<Record<keyof UsageWakeRecord, unknown>>;
	if (record.version !== 1 || typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)) return undefined;
	if (typeof record.stopAt !== "number" || !Number.isFinite(record.stopAt)) return undefined;
	if (typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined;
	if (typeof record.failures !== "number" || !Number.isInteger(record.failures) || record.failures < 0)
		return undefined;
	return {
		version: 1,
		outcome: record.outcome as UsageWakeOutcome,
		stopAt: record.stopAt,
		at: record.at,
		failures: record.failures,
		...(record.by === "owner" ? { by: "owner" as const } : {}),
	};
}

/**
 * Writes how the wait for the stop made at `stopAt` ended at `at`; `failures` counts its failed continuations in a row (0
 * for the other outcomes).
 */
export function recordUsageWake(
	writer: UsageWakeWriter,
	outcome: Exclude<UsageWakeOutcome, "declined">,
	stopAt: number,
	at: number,
	failures: number,
): void {
	const record: UsageWakeRecord = { version: 1, outcome, stopAt, at, failures };
	writer.appendCustomEntry(USAGE_WAKE_CUSTOM_TYPE, record);
}

/**
 * The owner's stop made at `stopAt`, applied at `at`: the usage-limit wait of every usage stop made until the owner's ends,
 * and is not taken up again; a usage stop made after it (a turn the owner started since) waits on its own. Written once
 * per owner's stop: a stop applied again (its first apply failed after this) finds its record and writes none.
 */
export function declineUsageWaitForOwner(transcript: UsageWakeLog & UsageWakeWriter, stopAt: number, at: number): void {
	const latest = latestUsageWake(transcript);
	if (latest?.outcome === "declined" && latest.by === "owner" && latest.stopAt === stopAt) return;
	const record: UsageWakeRecord = { version: 1, outcome: "declined", stopAt, at, failures: 0, by: "owner" };
	transcript.appendCustomEntry(USAGE_WAKE_CUSTOM_TYPE, record);
}

/** The delay before the next try after `failures` failed continuations in a row. */
export function usageWakeRetryDelayMs(failures: number): number {
	return Math.min(USAGE_WAKE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), USAGE_WAKE_RETRY_MAX_MS);
}

/**
 * When a stop made at `stopAt`, whose wait ends at `at`, continues after `wake`: `at` for a stop the record does not
 * answer (none, or a stop after it); after the retry delay for one a failed continuation answered; undefined for one
 * resumed, lapsed or declined.
 */
export function usageStopContinuesAt(
	stopAt: number,
	at: number,
	wake: UsageWakeRecord | undefined,
): number | undefined {
	if (!wake || stopAt > wake.stopAt) return at;
	return wake.outcome === "failed" ? Math.max(at, wake.at + usageWakeRetryDelayMs(wake.failures)) : undefined;
}
