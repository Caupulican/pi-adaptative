/**
 * The bounds on a watch the model arms for its own work, and the count of a session's live watches. Such a watch is
 * one-shot, with an end time at most a day ahead, while the session holds fewer than {@link MAX_AGENT_ARMED_WATCHES} of
 * them; a worker runtime arms within the session's count and at most {@link MAX_WORKER_ARMED_WATCHES} of its own, and what
 * its condition may run or read is its own scope's (`worker-watch-scope.ts`). The session's watch service holds these
 * numbers (`core/watches/`); routine watches an earlier build armed without the owner's words still count in them, by the
 * counts below, which the operator bar reads too.
 */

import {
	type RoutineDefinitionView,
	type RoutineSchedule,
	type RoutineScheduleInput,
	routineEnded,
} from "./routine-contract.ts";

/** Watches a session holds that a run armed without the owner's words; a chain of waits stays bounded by this and the deadline. */
export const MAX_AGENT_ARMED_WATCHES = 8;
/** Watches one worker runtime may hold at once, inside the session's bound, so one runtime cannot take every slot from the others. */
export const MAX_WORKER_ARMED_WATCHES = 2;
/** How far ahead an agent-armed watch's end time may be: a day is longer than any CI or deploy wait worth holding a slot for. */
export const MAX_AGENT_WATCH_HORIZON_MS = 24 * 3_600_000;

/** A watch as the routine tool authors it. */
export type WatchScheduleInput = Extract<RoutineScheduleInput, { readonly source: "watch" }>;

/** Whether a schedule is a watch condition (an event on a path, process, port, command or page). */
export function isWatchSchedule(schedule: RoutineScheduleInput): schedule is WatchScheduleInput;
export function isWatchSchedule(schedule: RoutineSchedule): boolean;
export function isWatchSchedule(schedule: RoutineSchedule | RoutineScheduleInput): boolean {
	return schedule.kind === "event" && schedule.source === "watch";
}

/** Whether `routine` is a watch of this session that has not ended: it holds one of the session's watch slots. */
function holdsWatchSlot(routine: RoutineDefinitionView, parentSessionId: string, nowMs: number): boolean {
	return (
		routine.target.kind === "session" &&
		routine.target.parentSessionId === parentSessionId &&
		isWatchSchedule(routine.schedule) &&
		routineEnded(routine, nowMs) === undefined
	);
}

/** How many watch slots of the session its watches hold, whatever armed them. */
export function heldWatchCount(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): number {
	return routines.filter((routine) => holdsWatchSlot(routine, parentSessionId, nowMs)).length;
}

/** The live watches of the session as the operator bar counts them: held and enabled, so a paused watch is not watching. */
export function liveWatches(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): RoutineDefinitionView[] {
	return routines.filter((routine) => routine.enabled && holdsWatchSlot(routine, parentSessionId, nowMs));
}

/** How many {@link liveWatches} the session holds. */
export function liveWatchCount(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): number {
	return liveWatches(routines, parentSessionId, nowMs).length;
}

/** How many watch slots of the session the watches a run armed without the owner's words hold. */
export function agentArmedWatchCount(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): number {
	return routines.filter(
		(routine) =>
			routine.armedBy !== undefined &&
			routine.armedBy.kind !== "owner" &&
			holdsWatchSlot(routine, parentSessionId, nowMs),
	).length;
}

/** How many watch slots of the session one worker runtime's watches hold. */
export function workerArmedWatchCount(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	runtimeId: string,
	nowMs: number,
): number {
	return routines.filter(
		(routine) =>
			routine.wake?.kind === "worker" &&
			routine.wake.runtimeId === runtimeId &&
			holdsWatchSlot(routine, parentSessionId, nowMs),
	).length;
}

/**
 * What {@link SessionWatchCount} reads: the saved routines, the session's own watches (`core/watches/`), their change
 * signal, the session and the clock.
 */
export interface SessionWatchCountSource {
	routines(): readonly RoutineDefinitionView[];
	ownWatches(nowMs: number): number;
	subscribe(listener: () => void): () => void;
	parentSessionId(): string;
	now(): number;
}

/**
 * The live watch count of one session, kept between changes of the saved routines so a render reads a number and never the
 * store: it is recounted on the first read after a change, and `onChange` tells the display to read again. An end time
 * that passes retires the routine through a store write, which is that change.
 */
export class SessionWatchCount {
	private readonly source: SessionWatchCountSource;
	private readonly unsubscribe: () => void;
	private counted: number | undefined;

	constructor(source: SessionWatchCountSource, onChange: () => void) {
		this.source = source;
		this.unsubscribe = source.subscribe(() => {
			this.counted = undefined;
			onChange();
		});
	}

	read(): number {
		const nowMs = this.source.now();
		this.counted ??=
			liveWatchCount(this.source.routines(), this.source.parentSessionId(), nowMs) + this.source.ownWatches(nowMs);
		return this.counted;
	}

	dispose(): void {
		this.unsubscribe();
	}
}
