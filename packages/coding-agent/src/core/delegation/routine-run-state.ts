/**
 * Run-state records of a routine occurrence: the run-state cache a claim writes onto its routine, the away settlement a dispatched run
 * records, the progress fields a run freezes at admission, and the bounded summary a result keeps. Pure functions over the
 * routine-contract types; the store decides when they are written.
 */
import {
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_SUMMARY_CHARS,
	type RoutineDefinitionView,
	type RoutineOccurrence,
	type RoutineOccurrenceListFilter,
	routineTriggerAt,
} from "../routines/routine-contract.ts";
import { NO_SUMMARY_TEXT, renderRoutineProgressBrief } from "../routines/routine-progress.ts";
import { cleanRedactBound } from "../security/secret-text.ts";

/**
 * The routine's run-state cache for one claimed occurrence: running until its result, then that result's outcome and
 * summary. Only run state changes; the definition, revision and updatedAt stay the admitted revision's.
 */
export function withRoutineRunState(
	routine: RoutineDefinitionView,
	occurrence: RoutineOccurrence,
): RoutineDefinitionView {
	// A claim admits the routine again, so an earlier away refusal no longer describes it.
	const { lastSummary: _previousSummary, awayRefusal: _refusal, ...rest } = routine;
	const result = occurrence.result;
	return {
		...rest,
		lastRunAt: routineTriggerAt(occurrence.trigger),
		lastStatus: result?.outcome ?? "running",
		...(result ? { lastSummary: result.summary } : {}),
	};
}

/** A dispatched run away's end, recorded in the write that makes it terminal; nothing for any other run. */
export function awaySettlement(
	occurrence: RoutineOccurrence,
	nowMs: number,
	costUsd: number | undefined,
): Pick<RoutineOccurrence, "awaySettlement"> {
	if (occurrence.executor !== "away" || !occurrence.dispatchKey) return {};
	return { awaySettlement: { at: nowMs, ...(costUsd === undefined ? {} : { costUsd }) } };
}

/**
 * What a run reads from its routine's progress record when it is claimed to run: the brief, and whether that brief
 * carries a third party's words (`progressUntrusted`). Both are frozen with the run. Only a session run of a clock,
 * manual or event trigger reads a brief; a watch firing wakes its armer with no run, and an expiry or condition notice runs no worker. The record is the routine's
 * current one, but the run's target and the report instruction come from the occurrence's own frozen definition, the one
 * its worker schema was compiled from.
 */
export function admittedProgressFields(
	routine: RoutineDefinitionView,
	occurrence: Pick<RoutineOccurrence, "definition" | "target" | "trigger">,
): Pick<RoutineOccurrence, "progressBrief" | "progressUntrusted"> {
	if (
		occurrence.target.kind !== "session" ||
		occurrence.trigger.kind === "expiry" ||
		occurrence.trigger.kind === "condition" ||
		occurrence.trigger.kind === "watch"
	)
		return {};
	const reportsProgress =
		occurrence.definition.executionSnapshot?.savedIntent.executionContract.worker.profile.reportsProgress === true;
	const progressBrief = renderRoutineProgressBrief(routine.routineId, routine.progress, reportsProgress);
	if (progressBrief === undefined) return {};
	return {
		progressBrief,
		...(routine.progress?.untrusted === true ? { progressUntrusted: true as const } : {}),
	};
}

/** A result's summary as the store keeps it: cleaned, redacted and bounded before it is cut, or the no-summary text. */
export function resultSummaryText(raw: string): string {
	return cleanRedactBound(raw, MAX_ROUTINE_SUMMARY_CHARS, { lines: true }) || NO_SUMMARY_TEXT;
}

export function listedRoutineOccurrences(
	occurrences: Iterable<RoutineOccurrence>,
	filter: RoutineOccurrenceListFilter,
): RoutineOccurrence[] {
	return Array.from(occurrences)
		.filter(
			(item) =>
				(!filter.routineId || item.routineId === filter.routineId) &&
				(!filter.parentSessionId || item.parentOrigin.sessionId === filter.parentSessionId) &&
				(!filter.phases || filter.phases.includes(item.phase)),
		)
		.sort((a, b) => a.createdAt - b.createdAt)
		.slice(-Math.max(1, Math.min(filter.limit ?? MAX_ROUTINE_OCCURRENCES, MAX_ROUTINE_OCCURRENCES)))
		.map((item) => structuredClone(item));
}

/** Index only the identity of each bot's latest claimed occurrence. Ignore queued or replaced incarnations. */
export function latestBotOccurrenceIds(
	occurrences: Iterable<RoutineOccurrence>,
	routines: ReadonlyMap<string, RoutineDefinitionView>,
): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const item of occurrences) {
		const routine = routines.get(item.routineId);
		if (
			item.target.kind === "bot" &&
			routine?.target.kind === "bot" &&
			item.target.agentId === routine.target.agentId &&
			item.definition.incarnationId === routine.incarnationId &&
			routineTriggerAt(item.trigger) === routine.lastRunAt
		)
			result.set(routine.incarnationId, item.occurrenceId);
	}
	return result;
}
