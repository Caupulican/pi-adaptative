/**
 * The clock and timers of a recovery, retry or watchdog alarm. A host (the test harness) may inject its own port so the
 * alarm fires on an event instead of the wall clock. An owner that compares a deadline it persisted against the time an
 * alarm fired reads both from the same port: `now()` is the clock its alarms are due on. Every owner of a recovery
 * timer takes a `TimerPort` and defaults to `SYSTEM_TIMER_PORT`. The kernel owns the port so its own retry backoff can
 * run on it; the host's owner registry lives in `core/util/timer-port.ts`.
 */
export interface TimerPort {
	/** Epoch milliseconds on this port's clock. */
	now(): number;
	setTimeout(callback: () => void, delayMs: number, options?: TimerOptions): unknown;
	clearTimeout(handle: unknown): void;
}

export interface TimerOptions {
	/**
	 * The pending alarm holds the process open. Only a wait the process's own result is behind asks for it (a retry
	 * backoff, a provider admission pause): a one-shot run must not exit in the middle of it. Every other alarm (a
	 * watchdog, a heartbeat, a recovery wake) never keeps the process alive.
	 */
	readonly keepAlive?: boolean;
}

/** The default port: the system clock and the global timer pair, each timer unreferenced unless it asks to keep the process alive. */
export const SYSTEM_TIMER_PORT: TimerPort = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs, options) => {
		const timer = setTimeout(callback, delayMs);
		if (options?.keepAlive !== true) timer.unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RepeatingAlarm {
	/** Clears the pending tick; a tick that is running finishes, and no tick runs after it. Idempotent. */
	stop(): void;
}

/**
 * `setInterval`/`clearInterval` on a port: each tick is one `setTimeout` of `intervalMs`, re-armed before the tick runs,
 * so a tick that throws or is slow never stops or skews the cadence and a tick that calls `stop` cancels the next one.
 * The alarm never keeps the process alive.
 */
export function repeatEvery(timers: TimerPort, intervalMs: number, tick: () => void): RepeatingAlarm {
	let handle: unknown;
	let stopped = false;
	const arm = (): void => {
		handle = timers.setTimeout(() => {
			if (stopped) return;
			arm();
			tick();
		}, intervalMs);
	};
	arm();
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			timers.clearTimeout(handle);
		},
	};
}
