import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";

const FAILED_TERMINAL_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["failed", "timeout", "budget_exhausted"]);

export interface WorkerTerminalHandoffRecord {
	laneId: string;
	status: LaneTerminalStatus;
	reasonCode?: string;
	/** Goal ownership retained until delivery so a stopped goal cannot be resurrected by a late terminal. */
	goalId?: string;
}

export interface WorkerNotificationStatus {
	active: number;
	queued: number;
	running: number;
	completedSinceFlush: number;
	failedSinceFlush: number;
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
}

/** Event-driven, bounded terminal outbox. Durable worker events can be replayed into it on resume. */
export class WorkerNotificationCoordinator {
	private readonly options: WorkerNotificationCoordinatorOptions;
	private readonly pending = new Map<string, PendingWorkerNotification>();
	private scheduled = false;
	private disposed = false;
	private deliveryTail = Promise.resolve();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryCount = 0;

	constructor(options: WorkerNotificationCoordinatorOptions) {
		this.options = options;
	}

	recordTerminal(record: LaneRecord, durableNotificationId?: string): void {
		if (record.status === "queued" || record.status === "running") return;
		const key = durableNotificationId ?? `transient:${record.laneId}:${record.completedAt ?? record.status}`;
		this.pending.set(key, {
			key,
			record: {
				laneId: record.laneId,
				status: record.status,
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(record.goalId ? { goalId: record.goalId } : {}),
			},
			...(durableNotificationId ? { durableNotificationId } : {}),
		});
		this.schedule();
	}

	statusChanged(): void {
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.scheduled = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.pending.clear();
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
		const delivery = this.deliveryTail.then(async () => {
			if (this.disposed) return;
			// A foreground lease wait is an in-flight side effect, not a failed attempt. Re-dispatching it
			// on a wall-clock timer creates concurrent consumers that later persist the same handoff.
			// Explicit rejection remains retryable; process restart replays the durable pending record.
			await this.options.notify(terminalSinceFlush);
			this.retryCount = 0;
			const durableIds = batch.flatMap((notification) =>
				notification.durableNotificationId ? [notification.durableNotificationId] : [],
			);
			if (durableIds.length > 0) this.options.markDurableDelivered(durableIds);
		});
		this.deliveryTail = delivery.catch((error: unknown) => {
			for (const notification of batch) this.pending.set(notification.key, notification);
			this.warnBestEffort(
				`Background worker handoff failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.scheduleRetry();
		});
	}
}
