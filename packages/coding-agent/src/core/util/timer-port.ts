/**
 * The timers of a recovery, retry or watchdog alarm. An alarm an owner arms must never keep the process alive, and a
 * host (the test harness) may inject its own port so the alarm fires on an event instead of the wall clock. Every owner
 * of a recovery timer takes a `TimerPort` and defaults to `SYSTEM_TIMER_PORT`.
 */
export interface TimerPort {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** The default port: the global timer pair, each timer unreferenced so a pending alarm never holds the process open. */
export const SYSTEM_TIMER_PORT: TimerPort = {
	setTimeout: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
