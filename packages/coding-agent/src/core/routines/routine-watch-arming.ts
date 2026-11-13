/**
 * The bounds on a watch the model arms for its own work, and the count of a session's live watches. A run the owner did
 * not speak in may arm only a finite watch: one-shot, with an end time at most a day ahead, while the session holds fewer
 * than {@link MAX_AGENT_ARMED_WATCHES} such watches. A worker runtime arms under the same bounds, within the session's
 * count and at most {@link MAX_WORKER_ARMED_WATCHES} of its own, and only a condition its own tools could check. These are
 * code facts the routine controller checks; the same predicate counts what the operator bar shows.
 */

import {
	type RoutineDefinitionView,
	type RoutineSchedule,
	type RoutineScheduleInput,
	routineEnded,
} from "./routine-contract.ts";
import type { WatchCondition } from "./watch-contract.ts";

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

/**
 * Why a watch may not be armed without the owner's words, in the fields to send; undefined when it is one-shot and ends
 * within {@link MAX_AGENT_WATCH_HORIZON_MS}.
 */
export function agentWatchBoundsRefusal(schedule: WatchScheduleInput, nowMs: number): string | undefined {
	if (schedule.stopAfterFirstRun !== true)
		return "An agent-armed watch must be one-shot: send stopAfterFirstRun: true in the schedule.";
	const hours = MAX_AGENT_WATCH_HORIZON_MS / 3_600_000;
	const { expiresAt } = schedule;
	if (expiresAt === undefined || expiresAt <= nowMs || expiresAt > nowMs + MAX_AGENT_WATCH_HORIZON_MS)
		return `An agent-armed watch needs an end time: send expiresAt (UTC epoch ms) after now and at most ${hours} hours ahead.`;
	return undefined;
}

/**
 * Why a worker runtime may not arm this condition: its own tools could not check it. A watch is re-checked at every tick under
 * the session's one admission, which is wider than a worker's (a read-only worker holds a shell its policy restricts, and one
 * without network tools has no fetch). The worker's own gate is built per attempt and lives in memory, while a watch outlives
 * the attempt and a restart, so admitting a worker's command or page check needs a per-routine admission stored with the
 * watch and read by the sampler; until then a worker arms only what needs no command and no page: a path, a managed
 * process, a process id or a port. Undefined when the condition is one of those.
 */
export function workerWatchConditionRefusal(condition: WatchCondition): string | undefined {
	return condition.type === "command" || condition.type === "http"
		? `A worker cannot arm a ${condition.type} check: the host would run it under the session's authority at every tick, wider than the worker's own tools. Arm a file, process, pid or port condition, or report the wait to the session that started you.`
		: undefined;
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

/** The live watches of the session as the operator bar counts them: held and enabled, so a paused watch is not watching. */
export function liveWatchCount(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): number {
	return routines.filter((routine) => routine.enabled && holdsWatchSlot(routine, parentSessionId, nowMs)).length;
}

/**
 * Why one more agent-armed watch may not be armed: the session already holds the most. A paused watch still holds its slot,
 * so pausing cannot free room for another; a spent watch (its one run taken) does not, so its own wake may arm the next.
 */
export function agentWatchSlotsRefusal(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): string | undefined {
	const held = routines.filter(
		(routine) =>
			routine.armedBy !== undefined &&
			routine.armedBy.kind !== "owner" &&
			holdsWatchSlot(routine, parentSessionId, nowMs),
	).length;
	return held >= MAX_AGENT_ARMED_WATCHES
		? `This session already holds ${MAX_AGENT_ARMED_WATCHES} watches armed without the owner's words, the most it may; delete one or wait for one to fire or end.`
		: undefined;
}

/** Why one more watch may not be armed for this worker runtime: it already holds its share of the session's slots. */
export function workerWatchSlotsRefusal(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	runtimeId: string,
	nowMs: number,
): string | undefined {
	const held = routines.filter(
		(routine) =>
			routine.wake?.kind === "worker" &&
			routine.wake.runtimeId === runtimeId &&
			holdsWatchSlot(routine, parentSessionId, nowMs),
	).length;
	return held >= MAX_WORKER_ARMED_WATCHES
		? `This worker already holds ${MAX_WORKER_ARMED_WATCHES} watches, the most one may; wait for one to fire or end.`
		: undefined;
}

/** What {@link SessionWatchCount} reads: the saved routines, their change signal, the session and the clock. */
export interface SessionWatchCountSource {
	routines(): readonly RoutineDefinitionView[];
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
		this.counted ??= liveWatchCount(this.source.routines(), this.source.parentSessionId(), this.source.now());
		return this.counted;
	}

	dispose(): void {
		this.unsubscribe();
	}
}
