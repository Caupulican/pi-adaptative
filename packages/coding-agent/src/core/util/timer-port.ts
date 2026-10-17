/**
 * The clock and timers of a recovery, retry or watchdog alarm. An alarm an owner arms must never keep the process
 * alive, and a host (the test harness) may inject its own port so the alarm fires on an event instead of the wall
 * clock. An owner that compares a deadline it persisted against the time an alarm fired reads both from the same port:
 * `now()` is the clock its alarms are due on. Every owner of a recovery timer takes a `TimerPort` and defaults to
 * `SYSTEM_TIMER_PORT`.
 */
export interface TimerPort {
	/** Epoch milliseconds on this port's clock. */
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** The default port: the system clock and the global timer pair, each timer unreferenced so a pending alarm never holds the process open. */
export const SYSTEM_TIMER_PORT: TimerPort = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The owners whose alarms run on the session's injected timers. Each is one time domain: the deadlines an owner
 * persists and the alarms it arms for them read the same port, so a host that drives one owner's time never moves
 * another owner's.
 * - `write-reservation`: the retained write-reservation release backoff.
 * - `orchestration`: the durable task runtime's clock and the worker retry ladder's alarms (the ladder persists its
 *   not-before deadline through that runtime, which checks it again when the retry resumes).
 * - `worker-notification`: the worker terminal handoff retry and its observation watchdog.
 * - `background-tool-task`: background tool task watchdogs, the wait bound and the wake-up delivery retry.
 * - `history`: the summary hierarchy's domain time and the timers that wake it.
 * - `foreground`: the overdue watchdog of the waits for the foreground (submission, history claim, idle).
 */
export type TimerOwner =
	| "write-reservation"
	| "orchestration"
	| "worker-notification"
	| "background-tool-task"
	| "history"
	| "foreground";

/** The one timer source a session is built with: the port each owner arms its alarms on. */
export interface TimerSource {
	port(owner: TimerOwner): TimerPort;
}

/** Every owner on the system clock and the global, unreferenced timers. */
export const SYSTEM_TIMER_SOURCE: TimerSource = { port: () => SYSTEM_TIMER_PORT };
