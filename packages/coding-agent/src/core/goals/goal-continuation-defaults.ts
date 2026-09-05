/** 0 means unbounded. Codex-style goals continue until a real terminal condition by default. */
export const DEFAULT_GOAL_CONTINUE_MAX_TURNS = 0;
export const DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS = 20;
export const DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = 0;
export const DEFAULT_GOAL_AUTO_CONTINUE = true;
export const DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS = 0;

/** User-supplied turn limits are validated as safe integers, not silently clamped by the harness. */
export const MAX_GOAL_CONTINUE_MAX_TURNS = Number.MAX_SAFE_INTEGER;
export const MAX_GOAL_CONTINUE_MAX_STALL_TURNS = 100;
export const MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = 24 * 60;
export const MAX_GOAL_AUTO_CONTINUE_DELAY_MS = 60_000;

/**
 * Never-hang backstop for a bound-in-flight worker (`evaluateGoalContinuation`'s
 * `worker_wait_timeout` reasonCode): the maximum time a goal waits on a dispatched worker
 * (`Requirement.boundAt` + this) before returning control to autonomous parent recovery instead of
 * waiting forever. A worker that is alive-but-hung past its deadline must not silently stall the goal loop.
 *
 * Deliberately generous relative to collaboration's default turn deadline
 * (1200s / 20min): 60 minutes gives a
 * legitimately slow worker comfortable headroom above that deadline (plus the reconcile/orphan
 * detection that runs on top of it) before the goal loop requires inspection and a different approach.
 */
export const DEFAULT_GOAL_WORKER_WAIT_MS = 3_600_000; // 60 minutes
