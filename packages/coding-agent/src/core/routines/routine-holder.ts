/**
 * Which saved routines a session's routine runtime holds: what its scheduler claims, retires and delivers, what its watch
 * monitor samples, and what its watch slots count. The store reads routines by holder, so a runtime never sees another
 * session's routines and ownership is a property of the read, not of each caller's filter.
 *
 * A root session ("session") holds the routines that target it and the bot and team routines, which any root session
 * dispatches. A bot's own session ("own-watches") holds only the watches it armed, which target its own session id: its
 * runtime samples them and wakes it, and no root runtime ever does. Interval, calendar and event routines of a bot
 * session are not held by anyone.
 */
import type { RoutineDefinitionView } from "./routine-contract.ts";
import { isWatchSchedule, liveWatches } from "./routine-watch-arming.ts";

export type RoutineScope = "session" | "own-watches";

export interface RoutineHolder {
	readonly sessionId: string;
	readonly scope: RoutineScope;
}

/** Whether `holder`'s runtime holds `routine` (see the module comment). */
export function holdsRoutine(
	routine: Pick<RoutineDefinitionView, "target" | "schedule">,
	holder: RoutineHolder,
): boolean {
	if (routine.target.kind !== "session") return holder.scope === "session";
	return (
		routine.target.parentSessionId === holder.sessionId &&
		(holder.scope === "session" || isWatchSchedule(routine.schedule))
	);
}

/**
 * The live watches a bot's own session holds now, read from the store (what keeps it loaded and what the roster shows):
 * how many, and when the first of them expires (undefined when none has an end), since an expiry writes nothing.
 */
export function liveOwnWatches(
	store: { listRoutines(holder?: RoutineHolder): readonly RoutineDefinitionView[] },
	sessionId: string,
	nowMs: number,
): { readonly count: number; readonly firstExpiresAt?: number } {
	const live = liveWatches(store.listRoutines({ sessionId, scope: "own-watches" }), sessionId, nowMs);
	const ends = live.flatMap(({ schedule }) =>
		schedule.kind !== "once" && schedule.expiresAt !== undefined ? [schedule.expiresAt] : [],
	);
	return ends.length === 0 ? { count: live.length } : { count: live.length, firstExpiresAt: Math.min(...ends) };
}
