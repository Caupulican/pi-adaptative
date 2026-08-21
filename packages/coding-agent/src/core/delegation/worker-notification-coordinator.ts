import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";

const FAILED_TERMINAL_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["failed", "timeout", "budget_exhausted"]);
/**
 * "partial", "blocked", and "canceled" are neither an outright infra failure nor a clean success —
 * each needs the parent's attention (review a partial/blocked claim, or simply note an explicit
 * stop), but folding them into `failedSinceFlush` would misclassify them as harness failures (the
 * exact bug 78a2158dd fixed in the other direction). Leaving them out of every tally instead made
 * them invisible: a blocked worker previously reported completedSinceFlush:0, failedSinceFlush:0 —
 * counted nowhere. Every LaneTerminalStatus must land in exactly one of the three tallies below.
 */
const ATTENTION_TERMINAL_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["partial", "blocked", "canceled"]);

/**
 * Reuses the former handoff-timeout boundary, now purely as an observation threshold: a re-dispatch
 * on this timer used to create a duplicate consumer of the same handoff, so it was removed. Without
 * any signal in its place, a notify() call that never settles would block deliveryTail (and every
 * subsequent worker terminal) forever with zero visibility. This watchdog only ever warns.
 */
const HANDOFF_WATCHDOG_MS = 1_800_000;
const MAX_OBSERVED_TERMINALS = 512;

export interface WorkerTerminalHandoffRecord {
	laneId: string;
	status: LaneTerminalStatus;
	completedAt?: string;
	reasonCode?: string;
	/** Goal ownership retained until delivery so a stopped goal cannot be resurrected by a late terminal. */
	goalId?: string;
	/** Runtime-only receipt. Observation consumes delivery, never mutation review. */
	observedAt?: string;
}

export interface WorkerNotificationStatus {
	active: number;
	queued: number;
	running: number;
	completedSinceFlush: number;
	failedSinceFlush: number;
	/** partial, blocked, and canceled terminals — needs parent review, not a harness failure. */
	attentionSinceFlush: number;
	terminalSinceFlush: readonly WorkerTerminalHandoffRecord[];
}

interface PendingWorkerNotification {
	key: string;
	record: WorkerTerminalHandoffRecord;
	durableNotificationId?: string;
}

export interface WorkerNotificationCoordinatorOptions {
	getWorkerRecords(): readonly LaneRecord[];
	emitStatus(status: WorkerNotificationStatus): void;
	notify(records: readonly WorkerTerminalHandoffRecord[]): Promise<void>;
	warn(message: string): void;
	markDurableDelivered(notificationIds: readonly string[]): void;
	/** Active event-driven waits consume matching terminals before a second foreground wake is admitted. */
	isObserved?(record: LaneRecord): boolean;
}

function terminalIdentity(record: Pick<LaneRecord, "laneId" | "status" | "completedAt" | "reasonCode">): string {
	return [record.laneId, record.completedAt ?? "", record.status, record.reasonCode ?? ""].join("\0");
}

/** Event-driven, bounded terminal outbox. Durable worker events can be replayed into it on resume. */
export class WorkerNotificationCoordinator {
	private readonly options: WorkerNotificationCoordinatorOptions;
	private readonly pending = new Map<string, PendingWorkerNotification>();
	/**
	 * Notifications currently being attempted by notify() — moved here from `pending` the instant
	 * delivery starts, never cleared until notify() is CONFIRMED to have settled (success or
	 * failure). If notify() never settles, this remains the durable, externally-visible record of
	 * what's stuck: a batch must never be reachable ONLY through the one promise closure that may
	 * never resolve (that closure is what previously starved every worker queued behind it, with
	 * no trace of the lost batch anywhere). getOutstandingRecords() exposes `pending ∪ inFlight` so
	 * an owning caller can durably persist and replay them across a process restart.
	 */
	private readonly inFlight = new Map<string, PendingWorkerNotification>();
	private readonly observedTerminals = new Map<string, string>();
	private scheduled = false;
	private disposed = false;
	private deliveryTail = Promise.resolve();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly handoffWatchdogs = new Set<ReturnType<typeof setTimeout>>();
	private retryCount = 0;

	constructor(options: WorkerNotificationCoordinatorOptions) {
		this.options = options;
	}

	/** Every notification recorded but not yet confirmed delivered, for durable cross-restart replay. */
	getOutstandingRecords(): readonly WorkerTerminalHandoffRecord[] {
		return [...this.pending.values(), ...this.inFlight.values()].map((notification) => notification.record);
	}

	recordTerminal(record: LaneRecord, durableNotificationId?: string): void {
		if (record.status === "queued" || record.status === "running") return;
		const key = durableNotificationId ?? `transient:${record.laneId}:${record.completedAt ?? record.status}`;
		const inFlight = this.inFlight.get(key);
		if (inFlight) {
			// A terminal can be observed again while its handoff is still awaiting the parent. Keep
			// the existing receipt and consumer: replacing it in `pending` would enqueue a second
			// wake as soon as the first delivery settles.
			if (this.options.isObserved?.(record)) {
				const observedAt = new Date().toISOString();
				this.rememberObserved(terminalIdentity(record), observedAt);
				inFlight.record.observedAt = observedAt;
			}
			return;
		}
		const identity = terminalIdentity(record);
		const observedAt = this.options.isObserved?.(record)
			? new Date().toISOString()
			: this.observedTerminals.get(identity);
		if (observedAt) this.rememberObserved(identity, observedAt);
		this.pending.set(key, {
			key,
			record: {
				laneId: record.laneId,
				status: record.status,
				...(record.completedAt ? { completedAt: record.completedAt } : {}),
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(record.goalId ? { goalId: record.goalId } : {}),
				...(observedAt ? { observedAt } : {}),
			},
			...(durableNotificationId ? { durableNotificationId } : {}),
		});
		this.schedule();
	}

	/** Mark exact terminal generations as already exposed to the parent model. */
	observeTerminals(
		records: readonly Pick<LaneRecord, "laneId" | "status" | "completedAt" | "reasonCode">[],
		observedAt = new Date().toISOString(),
	): void {
		const identities = new Set(records.map(terminalIdentity));
		for (const identity of identities) this.rememberObserved(identity, observedAt);
		for (const notification of [...this.pending.values(), ...this.inFlight.values()]) {
			if (identities.has(terminalIdentity(notification.record))) notification.record.observedAt = observedAt;
		}
	}

	private rememberObserved(identity: string, observedAt: string): void {
		this.observedTerminals.delete(identity);
		this.observedTerminals.set(identity, observedAt);
		while (this.observedTerminals.size > MAX_OBSERVED_TERMINALS) {
			const oldest = this.observedTerminals.keys().next().value;
			if (oldest === undefined) break;
			this.observedTerminals.delete(oldest);
		}
	}

	statusChanged(): void {
		this.schedule();
	}

	/** Callers that want to durably persist outstanding work must read getOutstandingRecords() first. */
	dispose(): void {
		this.disposed = true;
		this.scheduled = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		for (const watchdog of this.handoffWatchdogs) clearTimeout(watchdog);
		this.handoffWatchdogs.clear();
		this.pending.clear();
		this.inFlight.clear();
		this.observedTerminals.clear();
	}

	private schedule(): void {
		if (this.disposed || this.scheduled) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.scheduled = true;
		queueMicrotask(() => this.flush());
	}

	private scheduleRetry(): void {
		if (this.disposed || this.scheduled || this.retryTimer) return;
		const delayMs = Math.min(100 * 2 ** Math.min(this.retryCount, 5), 5_000);
		this.retryCount++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.schedule();
		}, delayMs);
		if (typeof this.retryTimer === "object" && "unref" in this.retryTimer) this.retryTimer.unref();
	}

	private warnBestEffort(message: string): void {
		try {
			this.options.warn(message);
		} catch {
			// Diagnostics cannot consume or stop durable notification delivery.
		}
	}

	/**
	 * Observe-only: warns once if the in-flight notify() call has not settled after
	 * HANDOFF_WATCHDOG_MS. Never re-dispatches and never creates a second notify() consumer —
	 * callers must clear() it once the awaited notify() settles, success or failure.
	 */
	private startHandoffWatchdog(laneIds: readonly string[]): { clear(): void } {
		const timer = setTimeout(() => {
			this.handoffWatchdogs.delete(timer);
			this.warnBestEffort(
				`Background worker handoff has not settled after ${HANDOFF_WATCHDOG_MS}ms for lane(s): ${laneIds.join(", ")}. Observation only; no redispatch will occur.`,
			);
		}, HANDOFF_WATCHDOG_MS);
		this.handoffWatchdogs.add(timer);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		return {
			clear: () => {
				clearTimeout(timer);
				this.handoffWatchdogs.delete(timer);
			},
		};
	}

	private flush(): void {
		this.scheduled = false;
		if (this.disposed) return;
		const batch = [...this.pending.values()];
		this.pending.clear();
		let workerRecords: readonly LaneRecord[] = [];
		try {
			workerRecords = this.options.getWorkerRecords();
		} catch (error) {
			this.warnBestEffort(
				`Background worker status projection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const queued = workerRecords.filter((record) => record.status === "queued").length;
		const running = workerRecords.filter((record) => record.status === "running").length;
		const terminalSinceFlush = batch.map((notification) => notification.record);
		const status = {
			active: queued + running,
			queued,
			running,
			completedSinceFlush: terminalSinceFlush.filter((record) => record.status === "succeeded").length,
			failedSinceFlush: terminalSinceFlush.filter((record) => FAILED_TERMINAL_STATUSES.has(record.status)).length,
			attentionSinceFlush: terminalSinceFlush.filter((record) => ATTENTION_TERMINAL_STATUSES.has(record.status))
				.length,
			terminalSinceFlush,
		};
		try {
			this.options.emitStatus(status);
		} catch (error) {
			this.warnBestEffort(
				`Background worker status observer failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (batch.length === 0) return;
		// Moved into `inFlight`, not merely captured by the closure below: if notify() never
		// settles, this batch stays durably visible via getOutstandingRecords() instead of being
		// reachable ONLY through this one promise, which is exactly what previously starved every
		// worker queued behind it with no trace of the lost batch anywhere.
		for (const notification of batch) this.inFlight.set(notification.key, notification);
		const delivery = this.deliveryTail.then(async () => {
			if (this.disposed) return;
			// A foreground lease wait is an in-flight side effect, not a failed attempt. Re-dispatching it
			// on a wall-clock timer creates concurrent consumers that later persist the same handoff.
			// Explicit rejection remains retryable; process restart replays the durable pending record.
			const watchdog = this.startHandoffWatchdog(terminalSinceFlush.map((record) => record.laneId));
			try {
				await this.options.notify(terminalSinceFlush);
			} finally {
				watchdog.clear();
			}
			for (const notification of batch) this.inFlight.delete(notification.key);
			this.retryCount = 0;
			const durableIds = batch.flatMap((notification) =>
				notification.durableNotificationId ? [notification.durableNotificationId] : [],
			);
			if (durableIds.length > 0) {
				try {
					this.options.markDurableDelivered(durableIds);
				} catch (error) {
					// Delivery is already confirmed. Retrying notify() would wake the parent twice just
					// to repair a separate durable acknowledgment; keep the ledger pending for a future
					// replay and make the acknowledgment failure observable instead.
					this.warnBestEffort(
						`Background worker durable handoff acknowledgment failed after delivery: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		});
		this.deliveryTail = delivery.catch((error: unknown) => {
			for (const notification of batch) {
				this.inFlight.delete(notification.key);
				this.pending.set(notification.key, notification);
			}
			this.warnBestEffort(
				`Background worker handoff failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.scheduleRetry();
		});
	}
}
