import { attemptUsageIncrease, validateAttemptUsageSnapshot } from "../orchestration/attempt-usage.ts";
import type { GatewayUsageAccountingPort } from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot } from "../orchestration/contracts.ts";
import type { AtomicFileLockOptions } from "../util/atomic-file.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";

const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
/**
 * The timer retry owns its own backoff, so it takes the store lock in a single attempt: contention
 * fails fast into the next scheduled retry instead of blocking the event loop on the lock wait.
 */
const RETRY_LOCK_OPTIONS: Readonly<AtomicFileLockOptions> = Object.freeze({ retries: 0 });

/** The durable receipt port this adapter retries through; `lockOptions` bounds its store-lock waits. */
export interface WorkerUsageAccountingStoragePort extends GatewayUsageAccountingPort {
	record(usage: AttemptUsageSnapshot, lockOptions?: Readonly<AtomicFileLockOptions>): void;
}

/**
 * Persistence lifetime for an already registered execution generation. This adapter owns only
 * retrying its cumulative receipt: it cannot rerun tools, renew leases or append conversation.
 * The durable runtime remains authoritative. A timer retains one pending snapshot after worker
 * disposal, but cannot make an unwritten receipt survive termination of the entire process.
 */
export class WorkerUsageAccounting implements GatewayUsageAccountingPort {
	readonly identity: GatewayUsageAccountingPort["identity"];
	readonly baseline: AttemptUsageSnapshot;
	private readonly port: WorkerUsageAccountingStoragePort;
	private readonly warn: (message: string) => void;
	private readonly label: string;
	private readonly afterRecord: () => void;
	private readonly timers: TimerPort;
	private latest: AttemptUsageSnapshot;
	private pending: AttemptUsageSnapshot | undefined;
	private retryTimer: unknown;
	private retryDelayMs = INITIAL_RETRY_DELAY_MS;
	private writing = false;

	constructor(options: {
		port: WorkerUsageAccountingStoragePort;
		warn(message: string): void;
		label: string;
		afterRecord(): void;
		timers?: TimerPort;
	}) {
		this.port = options.port;
		this.identity = Object.freeze({ ...options.port.identity });
		this.warn = options.warn;
		this.label = options.label;
		this.afterRecord = options.afterRecord;
		this.timers = options.timers ?? SYSTEM_TIMER_PORT;
		this.baseline = Object.freeze(validateAttemptUsageSnapshot(options.port.baseline));
		this.latest = this.baseline;
	}

	read(): ReturnType<GatewayUsageAccountingPort["read"]> {
		return this.port.read();
	}

	record(usage: AttemptUsageSnapshot): void {
		if (this.writing) throw new Error("Worker usage persistence cannot reenter its accounting port.");
		const next = Object.freeze(validateAttemptUsageSnapshot(usage));
		// Invalid or stale input cannot replace the valid receipt retained after a failed write.
		attemptUsageIncrease(next, this.latest);
		this.latest = next;
		this.pending = next;
		this.flush();
	}

	private flush(lockOptions?: Readonly<AtomicFileLockOptions>): void {
		if (!this.pending) return;
		this.writing = true;
		try {
			this.port.record(this.pending, lockOptions);
			// Keep publication in the retained obligation, including when the first storage write
			// succeeds but publication fails. Both direct calls and retries use the gateway owner.
			this.afterRecord();
			this.pending = undefined;
			if (this.retryTimer !== undefined) this.timers.clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
			this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
		} catch (error) {
			if (this.retryTimer === undefined) {
				const delayMs = this.retryDelayMs;
				this.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, delayMs * 2);
				try {
					// Accounting survives worker cancellation; this recovery alarm does not keep the CLI alive.
					this.retryTimer = this.timers.setTimeout(() => {
						this.retryTimer = undefined;
						try {
							this.flush(RETRY_LOCK_OPTIONS);
						} catch {
							// flush retains the receipt and reports whether another alarm was armed.
						}
					}, delayMs);
				} catch (scheduleError) {
					this.reportFailure(
						`${this.label} usage receipt remains pending without a retry alarm; persistence/publication failed (${String(error)}), then retry scheduling failed (${String(scheduleError)}).`,
					);
					throw new AggregateError(
						[error, scheduleError],
						"Worker usage persistence and retry scheduling failed.",
					);
				}
				this.reportFailure(
					`${this.label} usage persistence or publication failed; receipt retained for retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw error;
		} finally {
			this.writing = false;
		}
	}

	private reportFailure(message: string): void {
		try {
			this.warn(message);
		} catch {
			// Diagnostic failure cannot discard the retained receipt or replace its error.
		}
	}
}
