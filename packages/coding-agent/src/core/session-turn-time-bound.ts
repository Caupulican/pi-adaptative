/**
 * The time bound of one turn of a headless session (a persistent bot), as a worker's run is bounded by the owner's
 * `workerDelegation.maxWallClockMs`: the turn, as `observeSessionTurns` bounds it, is aborted once it runs past the bound.
 * The bound is read when the turn starts, on the session's timers. A turn past its bound is aborted again at the start of
 * a run it continues with (a self-compaction handoff's run): the abort that ended its time stops a run, not the handoff.
 */

import type { TimerPort } from "../kernel/timer-port.ts";
import type { AgentSession } from "./agent-session.ts";
import { observeSessionTurns } from "./session-turn-boundary.ts";

export interface SessionTurnTimeBound {
	/** The bound now, in milliseconds; undefined or 0 when none applies. Read when a turn starts. */
	limitMs(): number | undefined;
	/** A turn ran past `limitMs`: the owner-facing reason its turn is aborted with. */
	onExceeded(limitMs: number): string;
}

/** Bounds each turn of `session` in time; returns the unsubscribe, which also drops a running turn's alarm. */
export function boundSessionTurnTime(
	session: Pick<
		AgentSession,
		"subscribe" | "abort" | "getSessionWorkState" | "getSelfCompactionView" | "nativeActivity"
	>,
	timers: TimerPort,
	bound: SessionTurnTimeBound,
): () => void {
	let alarm: unknown;
	// Why the running turn was aborted for its time; undefined while it is within its bound.
	let overdue: string | undefined;
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
					overdue = bound.onExceeded(limitMs);
					void session.abort(overdue);
				}, limitMs);
		},
		ended: disarm,
	});
	// Subscribed after the boundary, so a run that starts a new turn has already cleared the last one's overdue mark.
	const unsubscribeRuns = session.subscribe((event) => {
		if (event.type === "agent_start" && overdue !== undefined) void session.abort(overdue);
	});
	return () => {
		unsubscribe();
		unsubscribeRuns();
		disarm();
	};
}
