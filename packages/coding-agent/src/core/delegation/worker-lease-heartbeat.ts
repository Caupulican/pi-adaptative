export interface WorkerLeaseHeartbeatOptions {
	leaseTtlMs: number;
	renew(): void;
	onFailure(error: Error): void;
}

const MAX_HOST_TIMER_DELAY_MS = 2_147_483_647;

/** Keeps one live in-process worker fence valid while provider or tool work is suspended. */
export class WorkerLeaseHeartbeat {
	private readonly options: WorkerLeaseHeartbeatOptions;
	private timer: ReturnType<typeof setInterval> | undefined;
	private failure: Error | undefined;

	constructor(options: WorkerLeaseHeartbeatOptions) {
		if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
			throw new Error("Worker lease heartbeat TTL must be a positive safe integer.");
		}
		this.options = options;
	}

	start(): void {
		if (this.timer || this.failure) return;
		const intervalMs = Math.min(MAX_HOST_TIMER_DELAY_MS, Math.max(1, Math.floor(this.options.leaseTtlMs / 3)));
		this.timer = setInterval(() => {
			try {
				this.options.renew();
			} catch (error) {
				this.failure = error instanceof Error ? error : new Error(String(error));
				this.stop();
				this.options.onFailure(this.failure);
			}
		}, intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
	}
}
