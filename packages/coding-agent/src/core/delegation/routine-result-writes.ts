/**
 * Writes that record a routine occurrence's terminal result inside the write that makes it: the result itself, the routine's
 * last-run state, its progress record, the end the owner stated, the failure streak that pauses it, and the cancellation of its
 * undispatched runs. The functions change the routine state they are given and never save; the store persists.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	ROUTINE_FAILURE_PAUSE_THRESHOLD,
	type RoutineOccurrence,
	type RoutineTerminalOutcome,
	routineResultDigest,
	routineTriggerAt,
} from "../routines/routine-contract.ts";
import { routineTurnOrigin } from "../routines/routine-parent-input.ts";
import { applyRoutineRunProgress, parseRoutineProgress, type RoutineRunFacts } from "../routines/routine-progress.ts";
import type { RoutineStoreState } from "./routine-occurrence-journal.ts";
import { resultSummaryText, withRoutineRunState } from "./routine-run-state.ts";

export function withResult(
	state: RoutineStoreState,
	occurrence: RoutineOccurrence,
	outcome: RoutineTerminalOutcome,
	summaryRaw: string,
	recipient: string,
	ownerUpdate?: "none",
	conditionMet?: true,
	facts?: RoutineRunFacts,
): RoutineOccurrence {
	const summary = resultSummaryText(summaryRaw);
	if (recipient !== occurrence.parentOrigin.sessionId)
		throw new Error("Routine result recipient does not match its admitted parent.");
	if ((ownerUpdate !== undefined || conditionMet !== undefined) && outcome !== "succeeded")
		throw new Error("Only a succeeded routine run can skip the owner update or report its stated end met.");
	const digest = routineResultDigest(outcome, summary, recipient, ownerUpdate === "none", conditionMet === true);
	const finished: RoutineOccurrence = {
		...occurrence,
		result: {
			outcome,
			summary,
			digest,
			delivery: "pending",
			recipient,
			...(ownerUpdate ? { ownerUpdate } : {}),
			...(conditionMet ? { conditionMet } : {}),
		},
	};
	// The routine's last run state follows the result of its most recently claimed occurrence only.
	const routine = state.routines.get(occurrence.routineId);
	if (
		routine?.incarnationId === occurrence.definition.incarnationId &&
		routine.lastRunAt === routineTriggerAt(occurrence.trigger)
	)
		state.routines.set(routine.routineId, withRoutineRunState(routine, finished));
	recordRoutineFailureStreak(state, finished, outcome, summary);
	recordRoutineProgress(state, finished, outcome, summary, facts);
	if (conditionMet) recordRoutineConditionMet(state, finished);
	return finished;
}

/**
 * Updates the routine's progress record in the write that records a result, for the incarnation the run belongs to
 * only (`applyRoutineRunProgress`): snags from code facts, the run's own report, clean runs resolving snags, and the
 * position of a run that sent no report. Only a worker session's run writes: a bot or team run has no brief to read it
 * back, so its results record nothing (its failure streak and pause still apply). A cancelled result counts nothing;
 * it leaves the stopped position only when the occurrence was dispatched. An expiry or condition notice and a watch firing (which ran no
 * worker) record nothing. Keyed by the run, so a replayed result changes nothing; never moves the revision. A record
 * the codec refuses is not kept: the previous record stands, so a progress record can never fail the result write.
 */
export function recordRoutineProgress(
	state: RoutineStoreState,
	occurrence: RoutineOccurrence,
	outcome: RoutineTerminalOutcome,
	summary: string,
	facts: RoutineRunFacts | undefined,
): void {
	if (
		occurrence.target.kind !== "session" ||
		occurrence.trigger.kind === "expiry" ||
		occurrence.trigger.kind === "condition" ||
		occurrence.trigger.kind === "watch"
	)
		return;
	const routine = state.routines.get(occurrence.routineId);
	if (routine?.incarnationId !== occurrence.definition.incarnationId) return;
	const progress = applyRoutineRunProgress(routine.progress, {
		routineId: routine.routineId,
		occurrenceId: occurrence.occurrenceId,
		outcome,
		reasonCode: facts?.reasonCode ?? outcome,
		...(facts?.step === undefined ? {} : { step: facts.step }),
		summary,
		...(facts?.report === undefined ? {} : { report: facts.report }),
		untrusted: routineTurnOrigin(occurrence)?.thirdParty === true,
		latest: routine.lastRunAt === routineTriggerAt(occurrence.trigger),
		dispatched: occurrence.dispatchKey !== undefined,
		nowMs: occurrence.updatedAt,
	});
	if (progress === routine.progress) return;
	if (progress !== undefined) {
		try {
			parseRoutineProgress(progress);
		} catch {
			harnessLog.warn("routines", "a run's progress record was not kept: it failed its own codec", {
				routineId: routine.routineId,
				occurrenceId: occurrence.occurrenceId,
			});
			return;
		}
	}
	const { progress: _previous, ...rest } = routine;
	state.routines.set(routine.routineId, progress ? { ...rest, progress } : rest);
}

/**
 * Marks the routine ended in the write that records a result reporting its stated end met, for the incarnation the
 * run belongs to only, and cancels its undispatched runs. The first report stands; the revision does not move. The
 * routine is removed, with its one notice, once its runs are settled (`retireEndedRoutines`).
 */
export function recordRoutineConditionMet(state: RoutineStoreState, occurrence: RoutineOccurrence): void {
	const routine = state.routines.get(occurrence.routineId);
	if (
		routine?.incarnationId !== occurrence.definition.incarnationId ||
		routine.origin?.endCondition === undefined ||
		routine.conditionMet
	)
		return;
	state.routines.set(routine.routineId, {
		...routine,
		conditionMet: { at: occurrence.updatedAt, occurrenceId: occurrence.occurrenceId },
	});
	cancelUndispatchedRoutineOccurrences(
		state,
		routine.routineId,
		occurrence.updatedAt,
		"Another run of this routine reported its stated end met before this one was dispatched.",
	);
}

/**
 * Counts failed results in a row on the routine, inside the write that records the result: a succeeded result clears
 * the count, a cancelled or uncertain one leaves it. The failed result that reaches the threshold pauses an enabled
 * routine in that same write, with the reason recorded and its undispatched runs cancelled, without moving the
 * revision the owner resumes against. A result is recorded exactly once, so the pause is written exactly once.
 */
export function recordRoutineFailureStreak(
	state: RoutineStoreState,
	occurrence: RoutineOccurrence,
	outcome: RoutineTerminalOutcome,
	summary: string,
): void {
	if (outcome !== "failed" && outcome !== "succeeded") return;
	const routine = state.routines.get(occurrence.routineId);
	if (routine?.incarnationId !== occurrence.definition.incarnationId) return;
	const { failureStreak: previous, ...rest } = routine;
	const streak = outcome === "failed" ? (previous ?? 0) + 1 : 0;
	if (streak < ROUTINE_FAILURE_PAUSE_THRESHOLD || !routine.enabled) {
		// An owner-paused routine keeps counting below the threshold; its resume starts the count again.
		const kept = Math.min(streak, ROUTINE_FAILURE_PAUSE_THRESHOLD - 1);
		state.routines.set(routine.routineId, kept > 0 ? { ...rest, failureStreak: kept } : rest);
		return;
	}
	state.routines.set(routine.routineId, {
		...rest,
		enabled: false,
		failurePause: {
			after: streak,
			at: occurrence.updatedAt,
			occurrenceId: occurrence.occurrenceId,
			// The summary was cleaned, redacted and bounded when the result was written (`resultSummaryText`).
			lastError: summary,
		},
	});
	cancelUndispatchedRoutineOccurrences(
		state,
		routine.routineId,
		occurrence.updatedAt,
		"The routine was paused after repeated failures before this run was dispatched.",
	);
}

/**
 * Cancels the routine's runs not yet dispatched (pending or claimed). With `settledAs`, a delivery marker, each cancelled
 * result is recorded already settled with it: a run whose parent can never receive it waits for no delivery. Returns
 * whether any run was cancelled.
 */
export function cancelUndispatchedRoutineOccurrences(
	state: RoutineStoreState,
	routineId: string,
	nowMs: number,
	summary = "Routine was paused or deleted before dispatch.",
	settledAs?: string,
): boolean {
	let cancelledAny = false;
	for (const item of state.occurrences.values()) {
		if (item.routineId !== routineId || (item.phase !== "pending" && item.phase !== "claimed")) continue;
		const cancelled = withResult(
			state,
			{ ...item, phase: "terminal", updatedAt: nowMs },
			"cancelled",
			summary,
			item.parentOrigin.sessionId,
		);
		const result = cancelled.result;
		state.occurrences.set(
			item.occurrenceId,
			settledAs === undefined || result === undefined
				? cancelled
				: { ...cancelled, result: { ...result, delivery: "acknowledged", deliveryMarker: settledAs } },
		);
		cancelledAny = true;
	}
	return cancelledAny;
}
