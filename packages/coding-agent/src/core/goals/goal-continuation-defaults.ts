export const DEFAULT_GOAL_CONTINUE_MAX_TURNS = 20;
export const DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS = 20;
export const DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = 0;
export const DEFAULT_GOAL_AUTO_CONTINUE = true;
export const DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS = 0;

export const MAX_GOAL_CONTINUE_MAX_TURNS = 20;
export const MAX_GOAL_CONTINUE_MAX_STALL_TURNS = 100;
export const MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = 24 * 60;
export const MAX_GOAL_AUTO_CONTINUE_DELAY_MS = 60_000;

/**
 * Cumulative, PER-GOAL continuation budget (turns + active wall-clock). Unlike
 * `DEFAULT_GOAL_CONTINUE_MAX_TURNS`/`MAX_WALL_CLOCK_MINUTES` above, which bound a single
 * `continueGoalLoop` invocation, these bound the TOTAL a goal may consume across every
 * invocation for its lifetime (idle-driven auto-continues and manual `/goal continue` calls
 * alike) — the durable counters live on `GoalState` and persist across process restarts.
 *
 * Deliberately generous relative to the single-invocation default (20 turns/invocation, no
 * default wall-clock cap): a legitimately long-running goal spans MANY invocations (one per
 * idle cycle or manual continue), and this ceiling exists only to bound a genuinely runaway
 * goal (one that keeps getting re-triggered without ever completing, blocking, or asking the
 * user) to a finite lifetime cost — not to cut off normal multi-session goal work.
 */
export const DEFAULT_GOAL_CUMULATIVE_MAX_TURNS = 100; // 5x the single-invocation default (20): room for
// ~5 separate continuation-loop invocations before a goal is judged runaway.
export const DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS = 4 * 60 * 60_000; // 4h of ACTIVE pass time (sum
// of each submitted pass's own await duration, NOT wall-clock time between passes/idle gaps) — a
// workday-sized ceiling, far above what one bounded invocation would consume in practice.

/**
 * Cumulative, PER-GOAL worker/subagent spend ceiling — the counterpart to the turns/wall-clock
 * ceilings above, but bounding `GoalState.continuationWorkerSpendUsd` (this goal's own lanes' spend,
 * summed by goalId in `goal-runtime-snapshot.ts`; deliberately excludes the loop's OWN model spend,
 * tracked separately as `continuationSpendUsd`). ACCURATE for in-process worker/research lanes (their
 * lane record carries a real `costUsd` set on completion); ADVISORY-ONLY for out-of-process tmux
 * workers, whose self-reported usage (`reportSpawnedUsage`) currently carries no goalId/lane
 * correlation key — a documented gap, not a hidden one. A conservative but
 * generous dollar figure: this exists to bound a genuinely runaway goal's worker fan-out cost, not to
 * cut off normal delegation.
 */
export const DEFAULT_GOAL_CUMULATIVE_MAX_WORKER_SPEND_USD = 20;

/**
 * Never-hang backstop for a bound-in-flight worker (`evaluateGoalContinuation`'s
 * `worker_wait_timeout` reasonCode): the maximum time a goal waits on a dispatched worker
 * (`Requirement.boundAt` + this) before escalating to the owner instead of waiting forever. A
 * worker that is alive-but-hung past its deadline must not silently stall the goal loop.
 *
 * Deliberately generous relative to the tmux worker runtime's own default session deadline
 * (1200s / 20min, `tmux-agent-manager`'s `DEFAULT_DEADLINE_SECONDS`): 60 minutes gives a
 * legitimately slow worker comfortable headroom above that deadline (plus the reconcile/orphan
 * detection that runs on top of it) before the goal loop gives up on waiting and asks the owner.
 */
export const DEFAULT_GOAL_WORKER_WAIT_MS = 3_600_000; // 60 minutes
