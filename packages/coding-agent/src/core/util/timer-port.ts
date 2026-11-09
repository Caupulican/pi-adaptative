import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";
import { blockingSleepMs } from "./atomic-file.ts";

/** The port is the kernel's (its retry backoff runs on it); every session owner below takes one. */
export {
	alarmAt,
	type RepeatingAlarm,
	repeatEvery,
	SYSTEM_TIMER_PORT,
	type TimerOptions,
	type TimerPort,
	type WallAlarm,
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
 * - `worker-accounting`: retry of a received worker usage receipt whose persistence or publication failed.
 * - `worker-settlement`: the bounded join of a worker's physically executing inner calls after logical completion.
 * - `branch-summary-retry`: the backoff between attempts of a tree navigation's branch summary request.
 * - `worktree-sync`: the backoff between rename attempts of a worktree store record replacement (epoch, landing
 *   transaction, lane registration) whose rename failed transiently.
 * - `tool-recovery-log`: the bound of a flush of the tool recovery log, which a closing session waits on for the log
 *   worker's acknowledgement.
 * - `proactivity`: the idle delay before a proactive review may start. The review is armed only for an idle foreground and
 *   every gate is checked again when the alarm fires.
 * - `knowledge-collection`: the original-owner collector's idle delay and bounded pass deadline.
 * - `routines`: the clock routine edits, claims and results are stamped with, and the scheduler's slot, lease and retry
 *   alarms (`alarmAt`, which re-reads this clock at least every `WALL_ALARM_RECHECK_MS`).
 * - `routine-intake`: the idle delay after an owner turn before routine intake reads it, the intake pass deadline and
 *   its retry delay.
 * - `continuous-chat`: bounded summary-request transport backoff and the chat's retained work-claim releases. After
 *   request recovery is exhausted, failed summary work retries on a later arrival, never on an alarm. One wall alarm
 *   wakes dispatch when a daily-spend or provider-limit hold may have lifted (next UTC day, provider reset).
 * - `system-prompt`: the clock the date a system prompt states is read from, pinned at the first build and advanced
 *   only at a cold moment. It arms no alarm.
 * - `channel-poll`: the schedule of a shipped channel transport that polls (Gmail): the wait between quiet polls, its
 *   error backoffs, its access-token expiry clock and its send pacing. Its request timeouts stay on the system clock.
 * - `channel-expiry`: the one alarm of a channel runtime for the earliest time a held item expires or a bound lifts,
 *   kept apart from `channel-poll` so a day-long expiry never reads as the transport's next scheduled wait.
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
	| "worker-accounting"
	| "worker-settlement"
	| "branch-summary-retry"
	| "worktree-sync"
	| "continuous-chat"
	| "proactivity"
	| "knowledge-collection"
	| "routines"
	| "routine-intake"
	| "tool-recovery-log"
	| "system-prompt"
	| "channel-poll"
	| "channel-expiry"
	| "fleet"
	| "leaders";

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
