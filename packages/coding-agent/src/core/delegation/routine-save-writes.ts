/**
 * A routine save's writes besides validation: the stored view a save produces from its definition and the run state it
 * keeps, and the undo of a save whose arming could not be completed. The functions change the routine state they are
 * given; `persist` is the store's save.
 */
import { isDeepStrictEqual } from "node:util";
import { HOST_EVENT_LISTENER_LIMITS } from "../events/host-event-kinds.ts";
import {
	type PersistentRoutineDefinition,
	parseRoutineScheduleInput,
	type RoutineCursor,
	type RoutineDefinitionView,
	type RoutineSchedule,
	routineScheduleInputOf,
	routineSlotRule,
	routineZoneUnsupported,
	type UpsertPersistentRoutineInput,
} from "../routines/routine-contract.ts";
import { parseWatchCondition } from "../routines/watch-contract.ts";
import type { RoutineStoreState } from "./routine-occurrence-journal.ts";

/** The undo of one save: the routine it wrote, the revision it wrote, and the routine as it stood before. */
export interface RoutineSaveRevertInput {
	readonly routineId: string;
	/** The revision the save wrote: the undo applies only while that revision is the stored one. */
	readonly savedRevision: number;
	/** The routine as it stood just before the save (read with no wait before it); absent when the save created it. */
	readonly prior?: RoutineDefinitionView;
}

/**
 * The stored view of a saved definition: its cursor and next run, and the run state of the routine it replaces that a
 * save keeps (last run, a pause's cause while it stays paused, a stated end met, measured durations, progress).
 */
export function routineViewAfterSave(
	definition: PersistentRoutineDefinition,
	cursor: RoutineCursor,
	nextRunAt: number,
	existing: RoutineDefinitionView | undefined,
): RoutineDefinitionView {
	const schedule = definition.schedule;
	return {
		...definition,
		cursor,
		nextRunAt,
		...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
		...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
		...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {}),
		// A write that leaves the routine paused keeps why; the owner's write that enables it starts the count again.
		...(definition.enabled || existing?.failureStreak === undefined ? {} : { failureStreak: existing.failureStreak }),
		...(definition.enabled || !existing?.failurePause ? {} : { failurePause: existing.failurePause }),
		// A reported end stands while the end the owner stated stands; a write that changes or drops it clears it.
		...(existing?.conditionMet &&
		existing.incarnationId === definition.incarnationId &&
		existing.origin?.endCondition !== undefined &&
		definition.origin?.endCondition === existing.origin.endCondition
			? { conditionMet: existing.conditionMet }
			: {}),
		// Measured runs derive the lead only while the schedule takes a derived one.
		...(existing?.runDurations && schedule.kind !== "event" && schedule.readyBy && !schedule.readyLeadMs
			? { runDurations: existing.runDurations }
			: {}),
		// Where the task stood is run state of this incarnation: an owner write keeps it; only a reset drops it.
		...(existing?.progress && existing.incarnationId === definition.incarnationId
			? { progress: existing.progress }
			: {}),
	};
}

/**
 * Undoes a save while the revision it wrote is still the stored one: a created routine is removed, an updated one is
 * restored to the routine it replaced, revision and run state included. Nothing ran between the save and its undo, so
 * no occurrence of the saved revision exists, and the removed routine was never armed, so no retired record is left for
 * it. The owner sources the save recorded as answered stay answered: the call answered them, with its refusal. Throws
 * when the routine changed since the save.
 */
export function revertRoutineSave(state: RoutineStoreState, input: RoutineSaveRevertInput, persist: () => void): void {
	const current = state.routines.get(input.routineId);
	if (current?.revision !== input.savedRevision) throw new Error("Routine changed before its save could be undone.");
	if (input.prior && input.prior.routineId !== input.routineId)
		throw new Error("The routine to restore is not the one the save wrote.");
	if (input.prior) state.routines.set(input.routineId, structuredClone(input.prior));
	else state.routines.delete(input.routineId);
	persist();
}

/** Save the authored clock or event schedule with its original anchor when its slot rule is unchanged. */
export function savedRoutineSchedule(
	input: UpsertPersistentRoutineInput,
	existing: RoutineDefinitionView | undefined,
	normalizedId: string,
	routines: ReadonlyMap<string, RoutineDefinitionView>,
) {
	const stored = existing ? routineScheduleInputOf(existing.schedule) : undefined;
	// The stored schedule resubmitted unchanged (a pause, resume or prompt edit) is kept as saved, so a routine whose
	// zone this runtime does not support stays editable here; any other schedule is validated as authored.
	const keepsSchedule = stored !== undefined && isDeepStrictEqual(input.schedule, stored);
	const scheduleInput = keepsSchedule ? stored : parseRoutineScheduleInput(input.schedule);
	const session = input.target.kind === "session";
	// The stored side is re-canonicalized: a runtime may spell a stored zone differently than when it was saved.
	// A zone it cannot read at all is compared as saved; a valid new schedule never equals it.
	const scheduleChanged =
		!existing ||
		(!keepsSchedule &&
			!isDeepStrictEqual(
				routineSlotRule(routineZoneUnsupported(existing.schedule) ? stored! : parseRoutineScheduleInput(stored)),
				routineSlotRule(scheduleInput),
			));
	const anchorAt =
		!scheduleChanged && existing && "anchorAt" in existing.schedule
			? existing.schedule.anchorAt
			: (input.nowMs ?? Date.now());
	let schedule: RoutineSchedule;
	if (scheduleInput.kind === "interval")
		schedule = {
			kind: "interval",
			intervalMs: scheduleInput.intervalMs,
			anchorAt,
			...(scheduleInput.expiresAt === undefined ? {} : { expiresAt: scheduleInput.expiresAt }),
			...(scheduleInput.readyBy ? { readyBy: true as const } : {}),
			...(scheduleInput.readyLeadMs === undefined ? {} : { readyLeadMs: scheduleInput.readyLeadMs }),
		};
	else if (scheduleInput.kind === "once") schedule = scheduleInput;
	else if (scheduleInput.kind === "event" && scheduleInput.source === "watch") {
		// A watch is evaluated by the session that holds it, while it is open; a bot or team has no session to watch for.
		if (!session) throw new Error("Watch routines run in their owning session only.");
		schedule = {
			kind: "event",
			source: "watch",
			condition: parseWatchCondition(scheduleInput.condition),
			...(scheduleInput.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
			...(scheduleInput.expiresAt === undefined ? {} : { expiresAt: scheduleInput.expiresAt }),
		};
	} else if (scheduleInput.kind === "event") {
		// Host events are decided by the session that owns their ledger; a bot or team has none.
		if (!session) throw new Error("Event routines run in their owning session only.");
		const kept =
			!scheduleChanged && existing?.schedule.kind === "event" && existing.schedule.source !== "watch"
				? existing.schedule
				: undefined;
		const anchor = kept ? { ordinal: kept.anchorOrdinal, replayGaps: kept.anchorReplayGaps } : input.eventAnchor;
		if (!anchor) throw new Error("Event routines require the session's host-event ledger position.");
		if (scheduleInput.source === "github") {
			const sessionId = input.target.kind === "session" ? input.target.parentSessionId : undefined;
			const listeners = Array.from(routines.values()).filter(
				(routine) =>
					routine.routineId !== normalizedId &&
					routine.target.kind === "session" &&
					routine.target.parentSessionId === sessionId &&
					routine.schedule.kind === "event" &&
					routine.schedule.source === "github",
			).length;
			if (listeners >= HOST_EVENT_LISTENER_LIMITS.maxListenersPerSource)
				throw new Error(
					`This session already holds ${HOST_EVENT_LISTENER_LIMITS.maxListenersPerSource} GitHub event routines, the most one session may hold; delete one first.`,
				);
			schedule = {
				...scheduleInput,
				anchorOrdinal: anchor.ordinal,
				anchorReplayGaps: anchor.replayGaps,
				anchorAt,
			};
		} else
			schedule = {
				kind: "event",
				source: scheduleInput.source,
				conclusions: scheduleInput.conclusions ?? ["failure"],
				...(scheduleInput.workflowPath === undefined ? {} : { workflowPath: scheduleInput.workflowPath }),
				...(scheduleInput.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
				...(scheduleInput.expiresAt === undefined ? {} : { expiresAt: scheduleInput.expiresAt }),
				anchorOrdinal: anchor.ordinal,
				anchorReplayGaps: anchor.replayGaps,
			};
	} else if (scheduleInput.timeZone === undefined) throw new Error("Calendar routines require a time zone.");
	else schedule = { ...scheduleInput, timeZone: scheduleInput.timeZone, anchorAt };
	return { schedule, scheduleChanged };
}
