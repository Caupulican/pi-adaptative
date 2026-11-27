/** Goal lifecycle status, stop origins and recovery predicates. */
export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usage_limited"
	| "budget_limited"
	| "completed"
	| "cancelled";
/**
 * The reason prefixes of a goal held by a stop of its session's own work: the owner's stop of a bot, and a turn stopped at
 * its dollar or time bound or by its supervision. Each is a system stop that no automatic recovery or usage reset resumes
 * and the owner's next delivered words do; none is a provider failure, so none counts toward `systemFailureStreak`.
 */
export const HELD_GOAL_STOP_PREFIXES = {
	ownerStop: "owner_stop:",
	spendBound: "spend_bound:",
	timeBound: "time_bound:",
	supervisionStop: "supervision_stop:",
} as const;

/** Whether `reason` is the reason of a goal held by a stop of its session's own work (`HELD_GOAL_STOP_PREFIXES`). */
export function isHeldGoalStopReason(reason: string | undefined): boolean {
	return (
		typeof reason === "string" && Object.values(HELD_GOAL_STOP_PREFIXES).some((prefix) => reason.startsWith(prefix))
	);
}

/** A system stop reason produced by a bounded harness guard (runaway/stagnant tool loop). */
export function isRunawayStopReason(reason: string | undefined): boolean {
	return (
		typeof reason === "string" &&
		(reason.startsWith("runaway_tool_loop:") || reason.startsWith("stagnant_tool_cycle:"))
	);
}

/** One shared lifecycle classification for tools, runtime, persistence, and UI. */
export function isGoalExecutionActive(status: GoalStatus): status is "active" {
	return status === "active";
}
/** The unfinished statuses that are not running: the goal waits on the owner, a block or a usage limit. */
export type GoalStoppedStatus = Exclude<GoalStatus, "active" | "completed" | "cancelled" | "budget_limited">;
export function isGoalResumableStatus(status: GoalStatus): boolean {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}
export function isGoalStoppedStatus(status: GoalStatus): boolean {
	return isGoalResumableStatus(status) || status === "budget_limited";
}
export function isGoalTerminalStatus(status: GoalStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "budget_limited";
}
export function isGoalUnfinishedStatus(status: GoalStatus): status is GoalStoppedStatus | "active" {
	return !isGoalTerminalStatus(status);
}

export function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "blocked" ||
		value === "usage_limited" ||
		value === "budget_limited" ||
		value === "completed" ||
		value === "cancelled"
	);
}

/**
 * Upper bound of the durable runaway-signature allowance. A goal that has already consumed this many
 * distinct automatic recoveries since the last owner intervention gets no further automatic resume:
 * the collection refuses, it never evicts an older signature (eviction would reopen that loop).
 */
export const MAX_CONSUMED_RUNAWAY_SIGNATURES = 16;

export function isValidConsumedRunawaySignatures(value: unknown): boolean {
	if (value === undefined) return true;
	if (!Array.isArray(value) || value.length > MAX_CONSUMED_RUNAWAY_SIGNATURES) return false;
	return (
		new Set(value).size === value.length &&
		value.every((item) => typeof item === "string" && isRunawayStopReason(item))
	);
}
