/**
 * The time bound of one turn of a headless session (a persistent bot), as a worker's run is bounded by the owner's
 * `workerDelegation.maxWallClockMs`: the turn, as `observeSessionTurns` bounds it, is aborted once it runs past the bound.
 * The bound is read when the turn starts, on the session's timers. The stop ends the turn's self-compaction handoff with
 * its run (`stopSessionTurn`), so no later run continues the stopped work; a handoff run that was already starting when
 * the bound passed is aborted at its start.
 */

import type { TimerPort } from "../kernel/timer-port.ts";
import type { AgentSession } from "./agent-session.ts";
import { HELD_GOAL_STOP_PREFIXES } from "./goals/goal-state.ts";
import { observeSessionTurns, type SessionTurnStop, stopSessionTurn } from "./session-turn-boundary.ts";

export interface SessionTurnTimeBound {
	/** The bound now, in milliseconds; undefined or 0 when none applies. Read when a turn starts. */
	limitMs(): number | undefined;
	/** A turn ran past `limitMs`: the owner-facing reason its turn is aborted with. */
	onExceeded(limitMs: number): string;
	/** The hold of the goal the stopped turn served did not save (`stopSessionTurn`). */
	holdFailed(error: unknown): void;
}

/** Bounds each turn of `session` in time; returns the unsubscribe, which also drops a running turn's alarm. */
export function boundSessionTurnTime(
	session: Pick<
		AgentSession,
		| "subscribe"
		| "abort"
		| "getSessionWorkState"
		| "selfCompactionHandoff"
		| "nativeActivity"
		| "getGoalStateSnapshot"
		| "saveGoalStateSnapshot"
	>,
	timers: TimerPort,
	bound: SessionTurnTimeBound,
): () => void {
	let alarm: unknown;
	// Why the running turn was aborted for its time; undefined while it is within its bound.
	let overdue: SessionTurnStop | undefined;
	const disarm = () => {
		if (alarm !== undefined) timers.clearTimeout(alarm);
		alarm = undefined;
		overdue = undefined;
	};
	const unsubscribe = observeSessionTurns(session, {
		started: () => {
			const limitMs = bound.limitMs() ?? 0;
			if (limitMs > 0)
				alarm = timers.setTimeout(() => {
					alarm = undefined;
					// A run end that announced a retry no run followed (its backoff cut, its attempt refused) left no turn running.
					if (!session.getSessionWorkState().busy) return;
					overdue = {
						reason: bound.onExceeded(limitMs),
						goalHold: `${HELD_GOAL_STOP_PREFIXES.timeBound} the turn ran past its ${Math.ceil(limitMs / 1000)} s bound`,
					};
					void stopSessionTurn(session, overdue, bound.holdFailed);
				}, limitMs);
		},
		ended: disarm,
	});
	// Subscribed after the boundary, so a run that starts a new turn has already cleared the last one's overdue mark.
	const unsubscribeRuns = session.subscribe((event) => {
		if (event.type === "agent_start" && overdue !== undefined)
			void stopSessionTurn(session, overdue, bound.holdFailed);
	});
	return () => {
		unsubscribe();
		unsubscribeRuns();
		disarm();
	};
}
