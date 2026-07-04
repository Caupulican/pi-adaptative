/**
 * Silence/idle watchdogs for the reliability kernel.
 *
 * A silence watchdog bounds "running but mute" — it never bounds total runtime,
 * so long tasks that produce output are never killed (autonomy constraint).
 */

export interface SilenceWatchdog {
	/** Report activity (output chunk / stream event); resets the countdown. */
	touch(): void;
	/** Stop permanently (normal completion). Idempotent. */
	disarm(): void;
}

export interface SilenceWatchdogOptions {
	silenceMs: number;
	/** Fired at most once, after silenceMs with no touch(). The watchdog self-disarms. */
	onSilence: () => void;
}

export function createSilenceWatchdog(opts: SilenceWatchdogOptions): SilenceWatchdog {
	let timer: NodeJS.Timeout | undefined;
	let disarmed = false;

	const arm = () => {
		timer = setTimeout(() => {
			disarmed = true;
			timer = undefined;
			opts.onSilence();
		}, opts.silenceMs);
		// Never keep the host process alive just for a watchdog.
		timer.unref?.();
	};

	arm();

	return {
		touch(): void {
			if (disarmed) return;
			if (timer) clearTimeout(timer);
			arm();
		},
		disarm(): void {
			disarmed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
