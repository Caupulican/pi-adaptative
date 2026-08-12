import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";

const HANDOFF_TIMEOUT_MS = 1_800_000;
const FAILED_TERMINAL_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["failed", "timeout", "budget_exhausted"]);

export interface WorkerTerminalHandoffRecord {
	laneId: string;
	status: LaneTerminalStatus;
	reasonCode?: string;
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
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.options.notify(terminalSinceFlush),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new Error(`worker terminal handoff timed out after ${HANDOFF_TIMEOUT_MS}ms`)),
							HANDOFF_TIMEOUT_MS,
						);
						if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
					}),
				]);
				this.retryCount = 0;
				const durableIds = batch.flatMap((notification) =>
					notification.durableNotificationId ? [notification.durableNotificationId] : [],
				);
				if (durableIds.length > 0) this.options.markDurableDelivered(durableIds);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
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
