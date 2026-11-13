/**
 * The edge rule of a watch and the shapes its observations travel in: what the monitor reports to the routine store, how
 * the store answers, and the decision that turns one observation into a firing or a moved cursor. Pure over the routine
 * cursor; the store applies it under its lock.
 */
import type { RoutineCursor } from "./routine-contract.ts";
import type { WatchFiredEvent } from "./watch-contract.ts";

/** One observation of a watch condition, as the monitor reports it. Unknown observations are never reported. */
export interface RoutineWatchObservation {
	/** Whether a level condition holds now; ignored for a change-style condition (a file's content). */
	readonly truth: boolean;
	/** The digest a change-style condition is in now. */
	readonly state?: string;
}

export interface RoutineWatchObservationInput {
	readonly routineId: string;
	readonly incarnationId: string;
	readonly parentSessionId: string;
	readonly nowMs: number;
	readonly observation: RoutineWatchObservation;
	/** The firing's bounded fact record, used only when the observation is an edge. */
	readonly event: WatchFiredEvent;
}

/**
 * How the store answered an observation: `fired` recorded the firing for delivery to whoever armed the watch; `recorded`
 * moved the baseline or re-armed the edge; `unchanged` changed nothing; `held` is an edge the store could not take yet
 * (an earlier firing is not delivered, the journal is full or the routine's share is held), so the monitor offers it again
 * on the next store change; `stale` means the routine is gone, paused, ended or another incarnation.
 */
export type RoutineWatchOutcome = "fired" | "recorded" | "unchanged" | "held" | "stale";

/**
 * The edge rule of a watch. A change-style observation (it carries `state`) fires when the state differs from the
 * recorded one; the first observation only records the baseline. A level observation fires on the rising edge
 * (false to true), re-arms when it falls, and the first observation only records the baseline: a condition that
 * already holds when the watch is armed is its starting state. The firing count advances in the same write.
 */
export function decideWatchObservation(
	cursor: Extract<RoutineCursor, { kind: "watch" }>,
	observation: RoutineWatchObservation,
): { readonly fire: boolean; readonly cursor: Extract<RoutineCursor, { kind: "watch" }> } {
	if (observation.state !== undefined) {
		const next = { ...cursor, truth: true, state: observation.state };
		return { fire: cursor.state !== undefined && cursor.state !== observation.state, cursor: next };
	}
	const { state: _state, ...rest } = cursor;
	return { fire: cursor.truth === false && observation.truth, cursor: { ...rest, truth: observation.truth } };
}

/**
 * What the last recorded observation of a watch said when the watch reached its end time without firing, as a code fact of
 * its cursor: `unobserved` (no observation could be made), `not-met` (the condition did not hold, or the watched state did
 * not change) or `already-true` (it held when the watch was armed and never fell, so no rising edge came).
 */
export const WATCH_LAST_SEEN = ["unobserved", "not-met", "already-true"] as const;
export type WatchLastSeen = (typeof WATCH_LAST_SEEN)[number];

export function watchLastSeen(cursor: Extract<RoutineCursor, { kind: "watch" }>): WatchLastSeen {
	if (cursor.truth === null) return "unobserved";
	return cursor.state === undefined && cursor.truth ? "already-true" : "not-met";
}
