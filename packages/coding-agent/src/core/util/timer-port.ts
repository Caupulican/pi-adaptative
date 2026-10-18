import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";

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
 * - `goal-continuation`: the goal auto-continue wake (the continuation delay, a persisted worker-deadline resume and the
 *   scheduled-failure retry).
 * - `worker-wait`: the bound of a delegate wait and the watchdog of its blocked write-reservation restore.
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
	| "worker-wait";

/** The one timer source a session is built with: the port each owner arms its alarms on. */
export interface TimerSource {
	port(owner: TimerOwner): TimerPort;
}

/** Every owner on the system clock and the global timers. */
export const SYSTEM_TIMER_SOURCE: TimerSource = { port: () => SYSTEM_TIMER_PORT };
