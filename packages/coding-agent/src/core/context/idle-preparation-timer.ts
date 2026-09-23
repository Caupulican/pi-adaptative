/**
 * One timer per session lane for work prepared while the lane idles: armed when a response stream
 * closes, disarmed when the lane's next request opens or anything else makes the preparation moot.
 * The timer is unreferenced, so an idle process can still exit; nothing polls.
 */
export class IdlePreparationTimer {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly schedule: (fire: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

	constructor(schedule?: (fire: () => void, delayMs: number) => ReturnType<typeof setTimeout>) {
		this.schedule =
			schedule ??
			((fire, delayMs) => {
				const timer = setTimeout(fire, delayMs);
				timer.unref?.();
				return timer;
			});
	}

	/** Run `fire` after `delayMs`, replacing whatever was armed. */
	arm(delayMs: number, fire: () => void): void {
		this.disarm();
		const timer = this.schedule(() => {
			if (this.timer === timer) this.timer = undefined;
			fire();
		}, delayMs);
		this.timer = timer;
	}

	disarm(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	get armed(): boolean {
		return this.timer !== undefined;
	}
}
