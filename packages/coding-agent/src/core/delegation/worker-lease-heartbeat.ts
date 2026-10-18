import { type RepeatingAlarm, repeatEvery, SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";

export interface WorkerLeaseHeartbeatOptions {
	leaseTtlMs: number;
	renew(): void;
	onFailure(error: Error): void;
	/**
	 * The `worker-lease` port the renewal cadence runs on. The lease deadline itself is persisted and checked on the
	 * orchestration runtime's clock, so a host that drives that clock past the deadline expires the lease. Defaults to
	 * the system timers.
	 */
	timers?: TimerPort;
}

const MAX_HOST_TIMER_DELAY_MS = 2_147_483_647;

/** Keeps one live in-process worker fence valid while provider or tool work is suspended. */
export class WorkerLeaseHeartbeat {
	private readonly options: WorkerLeaseHeartbeatOptions;
	private alarm: RepeatingAlarm | undefined;
	private failure: Error | undefined;

	constructor(options: WorkerLeaseHeartbeatOptions) {
		if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
			throw new Error("Worker lease heartbeat TTL must be a positive safe integer.");
		}
		this.options = options;
	}

	start(): void {
		if (this.alarm || this.failure) return;
		const intervalMs = Math.min(MAX_HOST_TIMER_DELAY_MS, Math.max(1, Math.floor(this.options.leaseTtlMs / 3)));
		this.alarm = repeatEvery(this.options.timers ?? SYSTEM_TIMER_PORT, intervalMs, () => {
			try {
				this.options.renew();
			} catch (error) {
				this.failure = error instanceof Error ? error : new Error(String(error));
				this.stop();
				this.options.onFailure(this.failure);
			}
		});
	}

	stop(): void {
		if (!this.alarm) return;
		this.alarm.stop();
		this.alarm = undefined;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
	}
}
