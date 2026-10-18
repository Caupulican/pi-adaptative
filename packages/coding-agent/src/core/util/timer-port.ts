import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";
import { blockingSleepMs } from "./atomic-file.ts";

/** The port is the kernel's (its retry backoff runs on it); every session owner below takes one. */
export {
	type RepeatingAlarm,
	repeatEvery,
	SYSTEM_TIMER_PORT,
	type TimerOptions,
	type TimerPort,
} from "../../kernel/timer-port.ts";

/**
 * The owners whose alarms run on the session's injected timers. Each is one time domain: the deadlines an owner
 * persists and the alarms it arms for them read the same port, so a host that drives one owner's time never moves
 * another owner's.
 * - `write-reservation`: the retained write-reservation release backoff.
 * - `orchestration`: the durable task runtime's clock and the worker retry ladder's alarms (the ladder persists its
 *   not-before deadline through that runtime, which checks it again when the retry resumes). A worker attempt's lease
 *   deadline is persisted and checked on this clock too.
 * - `worker-notification`: the worker terminal handoff retry and its observation watchdog.
 * - `background-tool-task`: background tool task watchdogs, the wait bound and the wake-up delivery retry.
 * - `history`: the summary hierarchy's domain time and the timers that wake it.
 * - `foreground`: the overdue watchdog of the waits for the foreground (submission, history claim, idle).
 * - `foreground-retry`: the foreground auto-retry backoff and its overdue watchdog.
 * - `provider-admission`: the provider admission gate's pauses (model quota, provider limit, capacity, emergency stop)
 *   and the admission ledger's hold heartbeat and staleness clock, and the clock of the model exhaustions whose resets
 *   the gate waits out.
 * - `worker-lease`: the heartbeat that renews a running worker attempt's lease. It is its own owner so a host that
 *   drives `orchestration` past a lease deadline expires the lease instead of firing the renewal first.
 * - `goal-continuation`: the goal auto-continue wake and the clock of a bound worker's never-hang deadline. The goal
 *   tool stamps its events (a dispatched worker's `boundAt` among them), the runtime snapshot decides the deadline, and
 *   the wake (the continuation delay, a persisted worker-deadline resume and the scheduled-failure retry) is armed for
 *   what is left of it, all on this port. The goal session's own stamps (pause, resume, system stops, accounting) and
 *   the goal's wall-clock budget stay on the system clock.
 * - `worker-wait`: the bound of a delegate wait and the watchdog of its blocked write-reservation restore.
 * - `compaction-retry`: the backoff between attempts of a compaction whose summarizer request failed transiently.
 * - `worker-provider-retry`: the backoff between a worker's transiently failed provider request and its retry.
 * - `branch-summary-retry`: the backoff between attempts of a tree navigation's branch summary request.
 * - `worktree-sync`: the backoff between rename attempts of a worktree store record replacement (epoch, landing
 *   transaction, lane registration) whose rename failed transiently.
 * - `continuous-chat`: the alarm a turn waiting on failed chat leaves arms before each retry, and the backoff of the
 *   chat's retained work-claim releases.
 */
export type TimerOwner =
	| "write-reservation"
	| "orchestration"
	| "worker-notification"
	| "background-tool-task"
	| "history"
	| "foreground"
	| "foreground-retry"
	| "provider-admission"
	| "worker-lease"
	| "goal-continuation"
	| "worker-wait"
	| "compaction-retry"
	| "worker-provider-retry"
	| "branch-summary-retry"
	| "worktree-sync"
	| "continuous-chat";

/** The one timer source a session is built with: the port each owner arms its alarms on. */
export interface TimerSource {
	port(owner: TimerOwner): TimerPort;
	/**
	 * The wait between a sync file lock's acquisition attempts (`AtomicFileLockOptions.sleepSync`) of the session stores
	 * that take it: the orchestration event store. Called once per gap with that gap's delay; it returns only when the gap
	 * is over and cannot take an abort, as the lock's caller is fully synchronous.
	 */
	sleepSync(delayMs: number): void;
}

/** Every owner on the system clock and the global timers; the sync lock gaps block the calling thread. */
export const SYSTEM_TIMER_SOURCE: TimerSource = { port: () => SYSTEM_TIMER_PORT, sleepSync: blockingSleepMs };
