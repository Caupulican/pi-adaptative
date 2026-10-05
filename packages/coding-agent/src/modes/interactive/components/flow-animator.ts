/**
 * The flow views' one animation timer. A frame that draws a carrier calls `request(until)` with the
 * moment the carrier stops being needed (Infinity while an edge is in flight); the animator starts its
 * single interval on the first request and clears it as soon as that moment passes or a frame reports
 * `settled()`. There is never a second timer and never an idle tick: the existing 1 s activity-lane
 * clock is the only permanent one. Each tick only asks the host for a render; where a carrier is comes
 * from the pure carrier functions, not from the animator.
 */

/** Frame interval of a running animation: at most 20 frames per second. */
export const FLOW_FRAME_MS = 50;

/** `PI_REDUCE_MOTION` set to anything but empty or 0 collapses every carrier to the settled state. */
function reducedMotionFromEnv(): boolean {
	const value = process.env.PI_REDUCE_MOTION;
	return value !== undefined && value !== "" && value !== "0";
}

export interface FlowAnimatorOptions {
	/** Asks the host for a frame. */
	readonly requestRender: () => void;
	readonly now?: () => number;
	readonly reducedMotion?: () => boolean;
}

export class FlowAnimator {
	private readonly requestRender: () => void;
	private readonly now: () => number;
	private readonly reducedMotion: () => boolean;
	private timer: ReturnType<typeof setInterval> | undefined;
	private until = 0;

	constructor(options: FlowAnimatorOptions) {
		this.requestRender = options.requestRender;
		this.now = options.now ?? Date.now;
		this.reducedMotion = options.reducedMotion ?? reducedMotionFromEnv;
	}

	/** False under reduced motion: views draw no carriers, so they never request frames. */
	get enabled(): boolean {
		return !this.reducedMotion();
	}

	/** True while the interval exists. */
	get running(): boolean {
		return this.timer !== undefined;
	}

	/** A frame drew a carrier that is needed until `untilMs`. Starts the interval on first need. */
	request(untilMs: number): void {
		if (!this.enabled) {
			this.settled();
			return;
		}
		this.until = untilMs;
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), FLOW_FRAME_MS);
		this.timer.unref?.();
	}

	/** A frame drew no carrier: nothing moves, so the interval goes away. */
	settled(): void {
		this.until = 0;
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.settled();
	}

	private tick(): void {
		if (this.now() >= this.until) {
			// The last carrier just finished: one more frame redraws the settled state.
			this.settled();
		}
		this.requestRender();
	}
}
