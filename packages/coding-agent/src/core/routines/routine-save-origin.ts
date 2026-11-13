/**
 * Where a session routine was saved in its parent session, and what it carries for it. A routine that runs workers (interval,
 * one-time, calendar, CI and GitHub events) carries the worker authority captured when it was saved, an execution snapshot
 * whose saved intent holds the parent position it was saved at (its receipt origin). A watch runs no worker (its firing wakes
 * whoever armed it), so it carries the receipt origin alone; a watch saved before that keeps the snapshot it was saved with. A
 * bot's or team's routine has no parent session and carries neither. Every read of the receipt origin goes through
 * {@link routineReceiptOrigin}, and the store and the parser hold the same shape through {@link routineSaveOriginRefusal}.
 */
import { parseWorkerSavedIntent, type WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { PersistentRoutineDefinition, RoutineSchedule } from "./routine-contract.ts";
import { boundedRoutineText } from "./routine-field-guards.ts";

export interface RoutineExecutionSnapshot {
	readonly parentSessionId: string;
	/** Opaque, bounded parent-branch anchor captured with the routine; never refreshed from a later branch. */
	readonly parentBranchAnchor: string;
	readonly profileId?: string;
	readonly savedIntent: WorkerSavedIntent;
}

export function parseRoutineExecutionSnapshot(value: unknown): RoutineExecutionSnapshot {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["parentSessionId", "parentBranchAnchor", "profileId", "savedIntent"])
	)
		throw new TypeError("Routine execution snapshot is invalid.");
	const parentSessionId = boundedRoutineText(value.parentSessionId, 200, "parent session id");
	const parentBranchAnchor = boundedRoutineText(value.parentBranchAnchor, 512, "parent branch anchor");
	const profileId = value.profileId === undefined ? undefined : boundedRoutineText(value.profileId, 256, "profile id");
	const savedIntent = parseWorkerSavedIntent(value.savedIntent);
	if (
		savedIntent.receiptOrigin.sessionId !== parentSessionId ||
		savedIntent.receiptOrigin.leafId !== parentBranchAnchor
	)
		throw new TypeError("Routine execution snapshot does not match its parent session.");
	return { parentSessionId, parentBranchAnchor, ...(profileId ? { profileId } : {}), savedIntent };
}

/** The stored origin fields of a routine, parsed strictly; a malformed one makes the whole routine unreadable. */
export function parseRoutineSaveOrigin(value: {
	readonly executionSnapshot?: unknown;
	readonly receiptOrigin?: unknown;
}): Pick<PersistentRoutineDefinition, "executionSnapshot" | "receiptOrigin"> {
	return {
		...(value.executionSnapshot === undefined
			? {}
			: { executionSnapshot: parseRoutineExecutionSnapshot(value.executionSnapshot) }),
		...(value.receiptOrigin === undefined
			? {}
			: { receiptOrigin: workerReceiptOriginFromValue(value.receiptOrigin) }),
	};
}

/** Whether a routine of this schedule starts workers: every schedule but a watch, which wakes its armer instead. */
export function routineRunsWorkers(schedule: RoutineSchedule): boolean {
	return schedule.kind !== "event" || schedule.source !== "watch";
}

/** The parent position a session routine was saved at, wherever it is stored; absent for a bot's or team's routine. */
export function routineReceiptOrigin(
	definition: Pick<PersistentRoutineDefinition, "executionSnapshot" | "receiptOrigin">,
): WorkerReceiptOrigin | undefined {
	return definition.executionSnapshot?.savedIntent.receiptOrigin ?? definition.receiptOrigin;
}

/**
 * Why a routine's origin fields do not fit its target and schedule, or undefined when they do: a session routine carries
 * exactly one origin of that session, a routine that runs workers carries it in its execution snapshot, and a bot's or team's
 * routine carries none.
 */
export function routineSaveOriginRefusal(
	definition: Pick<PersistentRoutineDefinition, "target" | "schedule" | "executionSnapshot" | "receiptOrigin">,
): string | undefined {
	const { target, executionSnapshot, receiptOrigin } = definition;
	if (target.kind !== "session")
		return executionSnapshot || receiptOrigin ? "A bot or team routine has no session to be saved in." : undefined;
	if (executionSnapshot && receiptOrigin) return "A session routine records where it was saved once.";
	if (!executionSnapshot && !receiptOrigin)
		return "A session routine requires the host-admitted position it was saved at.";
	if (!executionSnapshot && routineRunsWorkers(definition.schedule))
		return "Session routines that run workers require a host-admitted execution snapshot.";
	return routineReceiptOrigin(definition)?.sessionId === target.parentSessionId &&
		(executionSnapshot === undefined || executionSnapshot.parentSessionId === target.parentSessionId)
		? undefined
		: "Routine snapshot does not match its session target.";
}
