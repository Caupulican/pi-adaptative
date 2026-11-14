/**
 * A routine save's writes besides validation: the stored view a save produces from its definition and the run state it
 * keeps, and the undo of a save whose arming could not be completed. The functions change the routine state they are
 * given; `persist` is the store's save.
 */
import type {
	PersistentRoutineDefinition,
	RoutineCursor,
	RoutineDefinitionView,
} from "../routines/routine-contract.ts";
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
