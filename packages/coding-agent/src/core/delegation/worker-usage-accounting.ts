import { attemptUsageIncrease, validateAttemptUsageSnapshot } from "../orchestration/attempt-usage.ts";
import type { GatewayUsageAccountingPort } from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot } from "../orchestration/contracts.ts";

const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Persistence lifetime for an already registered execution generation. This adapter owns only
 * retrying its cumulative receipt: it cannot rerun tools, renew leases or append conversation.
 * The durable runtime remains authoritative. A timer retains one pending snapshot after worker
 * disposal, but cannot make an unwritten receipt survive termination of the entire process.
 */
export class WorkerUsageAccounting implements GatewayUsageAccountingPort {
	readonly identity: GatewayUsageAccountingPort["identity"];
	readonly baseline: AttemptUsageSnapshot;
	private readonly port: GatewayUsageAccountingPort;
	private readonly warn: (message: string) => void;
	private readonly label: string;
	private readonly afterRecord: () => void;
	private latest: AttemptUsageSnapshot;
	private pending: AttemptUsageSnapshot | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelayMs = INITIAL_RETRY_DELAY_MS;
	private writing = false;

	constructor(options: {
		port: GatewayUsageAccountingPort;
		warn(message: string): void;
		label: string;
		afterRecord(): void;
	}) {
		this.port = options.port;
		this.identity = Object.freeze({ ...options.port.identity });
		this.warn = options.warn;
		this.label = options.label;
		this.afterRecord = options.afterRecord;
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

	private flush(): void {
		if (!this.pending) return;
		this.writing = true;
		try {
			this.port.record(this.pending);
			// Keep publication in the retained obligation, including when the first storage write
			// succeeds but publication fails. Both direct calls and retries use the gateway owner.
			this.afterRecord();
			this.pending = undefined;
			if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
			this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
		} catch (error) {
			if (this.retryTimer === undefined) {
				const delayMs = this.retryDelayMs;
				this.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, delayMs * 2);
				this.retryTimer = setTimeout(() => {
					this.retryTimer = undefined;
					try {
						this.flush();
					} catch {
						// flush retains the receipt, reports the failure and schedules its next write.
					}
				}, delayMs);
				// Failed storage must not keep a closing CLI process alive indefinitely.
				this.retryTimer.unref();
				try {
					this.warn(
						`${this.label} usage persistence or publication failed; receipt retained for retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
					);
				} catch {
					// Diagnostic failure must not replace the storage error or abandon its retry.
				}
			}
			throw error;
		} finally {
			this.writing = false;
		}
	}
}
