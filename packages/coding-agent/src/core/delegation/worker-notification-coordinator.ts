import { harnessLog } from "../../kernel/harness-log.ts";
import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import type { TimerPort } from "../util/timer-port.ts";

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
 * The most one handoff may hold the serialized delivery tail. A re-dispatch on this timer used to create a duplicate
 * consumer of the same handoff, so expiry never re-dispatches: the batch stays in `inFlight` (still the one consumer
 * of its key, still outstanding and durably pending), the tail moves on to the next handoff, and the late settlement of
 * the original notify() still completes or retries that batch.
 */
const HANDOFF_DEADLINE_MS = 1_800_000;
const HANDOFF_RETAINED = Symbol("handoff retained");
const MAX_OBSERVED_TERMINALS = 512;

export interface WorkerTerminalHandoffRecord {
	laneId: string;
	/** The exact generation (attempt) that ended; absent only on records that predate it. */
	attemptId?: string;
	status: LaneTerminalStatus;
	completedAt?: string;
	reasonCode?: string;
	reasonDetail?: string;
	/** Goal ownership retained until delivery so a stopped goal cannot be resurrected by a late terminal. */
	goalId?: string;
	/** Runtime-only receipt. Observation consumes delivery, never mutation review. */
	observedAt?: string;
	/**
	 * Foreground submission epoch that owned the worker lane at start, mirroring
	 * `BackgroundToolTaskRecord.ownerEpoch` (background-tool-task-controller.ts) so
	 * `ForegroundTerminalHandoffController.resolveWake` can gate both delivery kinds uniformly.
	 * Populated via `noteAttemptOwnerEpoch` at the three lane/attempt-creation surfaces that mint
	 * genuinely new work: `WorkerDelegationController.prepareWorkerAttempt`'s fresh-creation branch
	 * (ordinary in-process worker dispatch), `ManagedLaneController.record`'s dispatch phase (managed /
	 * external-process workers, e.g. managed-workers), and `WorkerAgentControlCoordinator`'s mailbox-turn
	 * call site (a persistent worker agent's follow-up turn), gated there on
	 * `WorkerLifecycle.prepareAgentTurn`'s own `created` signal -- a replayed control message returns
	 * an attempt that may predate the current process, shape-identical to a fresh mint otherwise, and
	 * must never be re-stamped with the current epoch. Deliberately NOT threaded into
	 * `DelegationOrchestrationLedger`/`PrepareDelegationInput` -- that path is durably persisted
	 * (`objectiveId`, `OrchestrationEventStore`, restart-fenced), and a submission epoch is
	 * process-local and meaningless after a restart, so it is carried on this coordinator's own
	 * runtime-only side map instead, exactly mirroring `observedAt`'s treatment. Absent ownership (a
	 * legacy/resumed lane, a replayed mailbox turn, or any future surface that forgets to call
	 * `noteAttemptOwnerEpoch`) safely routes through the idle path -- it is a missed latency optimization,
	 * never a correctness risk.
	 */
	ownerEpoch?: number;
	/**
	 * The owner started this turn by talking to the bot in its own chat (`/bot msg`, a group message): the bot's answer
	 * belongs to that chat. Runtime-only, like `ownerEpoch`; an absent flag is the root's own work and wakes it.
	 */
	ownerDirect?: true;
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
	/**
	 * Already counted in a status event. A failed delivery returns the notification to `pending` and
	 * redelivers it, but its terminal is not new any more, so a later status event must not count it again.
	 */
	reportedInStatus?: boolean;
}

interface NotificationAlarm {
	readonly purpose: "retry" | "handoff deadline";
	timer?: unknown;
}

export interface WorkerNotificationCoordinatorOptions {
	/** The session's `worker-notification` port: the delivery retry backoff and the handoff observation watchdog. */
	timers: TimerPort;
	getWorkerRecords(): readonly LaneRecord[];
	/** Bind a transient terminal to its durable notification before attempting delivery. */
	ensureDurableNotification?(record: WorkerTerminalHandoffRecord): string | undefined;
	emitStatus(status: WorkerNotificationStatus): void;
	/** Resolve durable custody before enqueueing a parent handoff. Lookup failure retains the local notification. */
	deliveryOwner?(
		record: WorkerTerminalHandoffRecord,
		notificationId: string,
	): "coordinator" | "separate" | "acknowledged";
	notify(records: readonly WorkerTerminalHandoffRecord[]): Promise<void>;
	warn(message: string): void;
	markDurableDelivered(notificationIds: readonly string[]): void;
}

/**
 * The one identity of a worker terminal generation, shared by terminal observation and foreground
 * delivery. A record with an attempt is that attempt; a record without one keeps its legacy
 * lane/time/status/reason identity in a separate namespace, so it can never alias a known attempt.
 */
export function workerTerminalGenerationIdentity(
	record: Pick<LaneRecord, "laneId" | "status" | "completedAt" | "reasonCode" | "attemptId">,
): string {
	if (record.attemptId !== undefined) return ["attempt", record.attemptId].join("\0");
	return ["lane", record.laneId, record.completedAt ?? "", record.status, record.reasonCode ?? ""].join("\0");
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
	/**
	 * Foreground submission epoch owning an exact attempt, recorded once at creation by whichever
	 * creation surface minted it (`WorkerDelegationController.prepareWorkerAttempt`,
	 * `ManagedLaneController.record`'s dispatch phase) via `noteAttemptOwnerEpoch`. Read and consumed
	 * exactly once, in `recordTerminal`, when that attempt's terminal record is built. A refresh of
	 * the same pending terminal retains its captured epoch. An attempt with no entry (never noted, or a resumed/legacy/cross-process lane
	 * whose creation surface could not establish current ownership) yields `ownerEpoch: undefined` on
	 * the resulting `WorkerTerminalHandoffRecord`, which is the correct, safe default: absent
	 * ownership routes the handoff through the idle delivery path, never the boundary fold.
	 */
	private readonly attemptOwnerEpochs = new Map<string, number>();
	/** Attempts the owner started by talking to a bot directly, consumed with their terminal like `attemptOwnerEpochs`. */
	private readonly ownerDirectAttempts = new Set<string>();
	private scheduled = false;
	private disposed = false;
	private deliveryTail = Promise.resolve();
	private retryAlarm: NotificationAlarm | undefined;
	private readonly alarms = new Set<NotificationAlarm>();
	private retryCount = 0;

	constructor(options: WorkerNotificationCoordinatorOptions) {
		this.options = options;
	}

	/** Pending notifications still owned here; separate owners retain their own durable outbox custody. */
	getOutstandingRecords(): readonly WorkerTerminalHandoffRecord[] {
		return [...this.pending.values(), ...this.inFlight.values()].map((notification) => notification.record);
	}

	/**
	 * Record the foreground submission epoch that owned `attemptId` at the moment its creation surface
	 * minted it. Call exactly once, at genuine lane creation -- never on a retry/resume/drain of an
	 * already-tracked attempt, the same discipline `goalId` already follows on this same record. An attempt
	 * never noted here (legacy, resumed, or a creation surface with no start-time capture wired yet)
	 * simply has no entry, which `recordTerminal` treats as absent ownership, not a match.
	 */
	noteAttemptOwnerEpoch(attemptId: string, ownerEpoch: number): void {
		if (this.disposed) return;
		if (!this.attemptOwnerEpochs.has(attemptId)) this.attemptOwnerEpochs.set(attemptId, ownerEpoch);
	}

	/** Note that `attemptId` is the owner's own turn with a bot, so its terminal does not wake the root. */
	noteOwnerDirectAttempt(attemptId: string): void {
		if (!this.disposed) this.ownerDirectAttempts.add(attemptId);
	}

	recordTerminal(record: LaneRecord, durableNotificationId?: string): void {
		if (this.disposed || record.status === "queued" || record.status === "running") return;
		const key = durableNotificationId ?? `transient:${workerTerminalGenerationIdentity(record)}`;
		const inFlight = this.inFlight.get(key);
		if (inFlight) {
			// A terminal can be observed again while its handoff is still awaiting the parent. Keep
			// the existing receipt and consumer: replacing it in `pending` would enqueue a second
			// wake as soon as the first delivery settles.
			return;
		}
		const identity = workerTerminalGenerationIdentity(record);
		const observedAt = this.observedTerminals.get(identity);
		if (observedAt) this.rememberObserved(identity, observedAt);
		// Consumed exactly once, here, at the same point `goalId` is read off the durable projection --
		// see `noteAttemptOwnerEpoch`'s doc comment for why an absent entry must never be treated as epoch 0
		// or any other sentinel; it is simply omitted, same as `goalId` is omitted when absent.
		const pending = this.pending.get(key);
		const ownerEpoch =
			pending?.record.ownerEpoch ??
			(record.attemptId === undefined ? undefined : this.attemptOwnerEpochs.get(record.attemptId));
		if (record.attemptId !== undefined) this.attemptOwnerEpochs.delete(record.attemptId);
		const ownerDirect =
			pending?.record.ownerDirect === true ||
			(record.attemptId !== undefined && this.ownerDirectAttempts.delete(record.attemptId));
		// Re-recording the same generation while it waits for redelivery replaces its payload, not its count.
		const reportedInStatus = pending?.reportedInStatus === true;
		this.pending.set(key, {
			key,
			record: {
				laneId: record.laneId,
				...(record.attemptId ? { attemptId: record.attemptId } : {}),
				status: record.status,
				...(record.completedAt ? { completedAt: record.completedAt } : {}),
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(record.reasonDetail ? { reasonDetail: record.reasonDetail } : {}),
				...(record.goalId ? { goalId: record.goalId } : {}),
				...(observedAt ? { observedAt } : {}),
				...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
				...(ownerDirect ? { ownerDirect: true as const } : {}),
			},
			...(durableNotificationId ? { durableNotificationId } : {}),
			...(reportedInStatus ? { reportedInStatus } : {}),
		});
		this.schedule();
	}

	/** Mark exact terminal generations as already exposed to the parent model. */
	observeTerminals(
		records: readonly Pick<LaneRecord, "laneId" | "status" | "completedAt" | "reasonCode" | "attemptId">[],
		observedAt = new Date().toISOString(),
	): void {
		if (this.disposed) return;
		const identities = new Set(records.map(workerTerminalGenerationIdentity));
		for (const identity of identities) this.rememberObserved(identity, observedAt);
		for (const notification of [...this.pending.values(), ...this.inFlight.values()]) {
			if (identities.has(workerTerminalGenerationIdentity(notification.record)))
				notification.record.observedAt = observedAt;
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
		this.retryAlarm = undefined;
		const alarms = [...this.alarms];
		this.alarms.clear();
		this.pending.clear();
		this.inFlight.clear();
		this.observedTerminals.clear();
		this.attemptOwnerEpochs.clear();
		this.ownerDirectAttempts.clear();
		for (const alarm of alarms) this.clearTimerBestEffort(alarm.timer, alarm.purpose);
	}

	private schedule(): void {
		if (this.disposed || this.scheduled) return;
		this.scheduled = true;
		const retryAlarm = this.retryAlarm;
		this.retryAlarm = undefined;
		this.disarmAlarm(retryAlarm);
		queueMicrotask(() => this.flush());
	}

	private scheduleRetry(): void {
		if (this.disposed || this.scheduled || this.retryAlarm !== undefined) return;
		const delayMs = Math.min(100 * 2 ** Math.min(this.retryCount, 5), 5_000);
		this.retryCount++;
		const alarm: NotificationAlarm = { purpose: "retry" };
		this.retryAlarm = alarm;
		const armed = this.armAlarm(alarm, delayMs, () => {
			if (this.retryAlarm !== alarm) return;
			this.retryAlarm = undefined;
			this.schedule();
		});
		if (!armed && this.retryAlarm === alarm) this.retryAlarm = undefined;
	}

	/** Timer adapters cannot change delivery outcomes or reject the serialized delivery tail. */
	private armAlarm(alarm: NotificationAlarm, delayMs: number, onFire: () => void): boolean {
		this.alarms.add(alarm);
		try {
			const timer = this.options.timers.setTimeout(() => {
				if (!this.alarms.delete(alarm) || this.disposed) return;
				onFire();
			}, delayMs);
			if (this.alarms.has(alarm)) {
				alarm.timer = timer;
				return true;
			}
			// An injected adapter can fire or dispose this owner before returning the handle.
			this.clearTimerBestEffort(timer, alarm.purpose);
		} catch (error) {
			this.alarms.delete(alarm);
			this.warnBestEffort(
				`Background worker ${alarm.purpose} timer could not be armed: ${error instanceof Error ? error.message : String(error)}. Pending handoffs remain available to the next notification event or session recovery.`,
			);
		}
		return false;
	}

	private disarmAlarm(alarm: NotificationAlarm | undefined): void {
		if (!alarm || !this.alarms.delete(alarm)) return;
		this.clearTimerBestEffort(alarm.timer, alarm.purpose);
	}

	private clearTimerBestEffort(timer: unknown, purpose: NotificationAlarm["purpose"]): void {
		try {
			this.options.timers.clearTimeout(timer);
		} catch (error) {
			this.warnBestEffort(
				`Background worker ${purpose} timer could not be cleared; its callback is inactive: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private warnBestEffort(message: string): void {
		try {
			this.options.warn(message);
		} catch {
			// Diagnostics cannot consume or stop durable notification delivery.
		}
	}

	/**
	 * Waits for `work` at most HANDOFF_DEADLINE_MS. On expiry it logs and reports the batch as retained: `work` keeps
	 * running and is never re-dispatched, but it no longer holds the delivery tail.
	 */
	private async waitForHandoff<T>(work: Promise<T>, laneIds: readonly string[]): Promise<T | typeof HANDOFF_RETAINED> {
		const expired = Promise.withResolvers<typeof HANDOFF_RETAINED>();
		const alarm: NotificationAlarm = { purpose: "handoff deadline" };
		this.armAlarm(alarm, HANDOFF_DEADLINE_MS, () => {
			harnessLog.warn("workers", "a worker handoff did not settle in time; it is retained and the queue continues", {
				lanes: laneIds,
				afterMs: HANDOFF_DEADLINE_MS,
			});
			this.warnBestEffort(
				`Background worker handoff has not settled after ${HANDOFF_DEADLINE_MS}ms for lane(s): ${laneIds.join(", ")}. It stays outstanding without a second delivery; later handoffs continue.`,
			);
			expired.resolve(HANDOFF_RETAINED);
		});
		try {
			return await Promise.race([work, expired.promise]);
		} finally {
			this.disarmAlarm(alarm);
		}
	}

	/** A confirmed delivery: the batch leaves the outbox and its durable receipts are acknowledged. */
	private completeDelivery(batch: readonly PendingWorkerNotification[]): void {
		// Disposal clears the process-local outbox but deliberately leaves its durable receipt
		// pending for the next session owner. A late notifier must not write through the retired
		// lifecycle after a replacement session may already have opened the same ledger.
		if (this.disposed) return;
		for (const notification of batch) this.inFlight.delete(notification.key);
		this.retryCount = 0;
		harnessLog.info("workers", "worker results were handed to the parent", () => ({
			count: batch.length,
			lanes: batch.map((notification) => notification.record.laneId),
			statuses: batch.map((notification) => notification.record.status),
		}));
		const durableIds = batch.flatMap((notification) =>
			notification.durableNotificationId ? [notification.durableNotificationId] : [],
		);
		if (durableIds.length === 0) return;
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

	/** A rejected delivery returns the batch to `pending` and arms the retry backoff. */
	private failDelivery(batch: readonly PendingWorkerNotification[], error: unknown): void {
		if (this.disposed) return;
		for (const notification of batch) {
			this.inFlight.delete(notification.key);
			this.pending.set(notification.key, notification);
		}
		this.warnBestEffort(
			`Background worker handoff failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		this.scheduleRetry();
		harnessLog.warn("workers", "a worker handoff failed; a retry is scheduled", {
			lanes: batch.map((notification) => notification.record.laneId),
		});
	}

	private flush(): void {
		this.scheduled = false;
		if (this.disposed) return;
		let batch = [...this.pending.values()];
		this.pending.clear();
		let workerRecords: readonly LaneRecord[] = [];
		try {
			workerRecords = this.options.getWorkerRecords();
		} catch (error) {
			this.warnBestEffort(
				`Background worker status projection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (this.disposed) return;
		const queued = workerRecords.filter((record) => record.status === "queued").length;
		const running = workerRecords.filter((record) => record.status === "running").length;
		// Delivery retries the whole batch; the status event reports only terminals no earlier event counted.
		const terminalSinceFlush = batch
			.filter((notification) => !notification.reportedInStatus)
			.map((notification) => notification.record);
		for (const notification of batch) {
			if (this.disposed) return;
			if (notification.durableNotificationId) continue;
			try {
				notification.durableNotificationId = this.options.ensureDurableNotification?.(notification.record);
			} catch (error) {
				this.warnBestEffort(
					`Failed to durably back the worker terminal notification for ${notification.record.laneId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (this.disposed) return;
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
		if (this.disposed) return;
		for (const notification of batch) notification.reportedInStatus = true;
		// A separately owned handoff must never occupy this serialized delivery tail.
		// Its native outbox stays pending until that owner confirms physical parent acceptance.
		const offered = batch.length;
		if (this.options.deliveryOwner) {
			batch = batch.filter((notification) => {
				try {
					if (!notification.durableNotificationId) throw new Error("Worker notification has no durable custody.");
					return (
						this.options.deliveryOwner!(notification.record, notification.durableNotificationId) === "coordinator"
					);
				} catch (error) {
					this.pending.set(notification.key, notification);
					this.warnBestEffort(
						`Worker notification ownership is unresolved: ${error instanceof Error ? error.message : String(error)}`,
					);
					harnessLog.warn("workers", "a worker notification's owner could not be resolved", {
						lane: notification.record.laneId,
					});
					this.scheduleRetry();
					return false;
				}
			});
		}
		if (offered > batch.length)
			harnessLog.debug("workers", "worker notifications were left for another owner", {
				count: offered - batch.length,
			});
		if (batch.length === 0) return;
		const batchRecords = batch.map((notification) => notification.record);
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
			const notifying = this.options.notify(batchRecords);
			const outcome = await this.waitForHandoff(
				notifying,
				batchRecords.map((record) => record.laneId),
			);
			if (outcome === HANDOFF_RETAINED) {
				void notifying.then(
					() => this.completeDelivery(batch),
					(error: unknown) => this.failDelivery(batch, error),
				);
				return;
			}
			this.completeDelivery(batch);
		});
		this.deliveryTail = delivery.catch((error: unknown) => this.failDelivery(batch, error));
	}
}
