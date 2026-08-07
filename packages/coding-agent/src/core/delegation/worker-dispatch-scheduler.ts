import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { workerQueueHasCapacity } from "./worker-fleet-limits.ts";

export type WorkerDispatchAdmission =
	| { action: "start" }
	| { action: "wait"; reason?: "capacity" | "dependencies" | "objective" | "write_reservation" }
	| { action: "cancel"; reasonCode: string };

export interface WorkerDispatchSchedulerOptions {
	agentDir: string;
	/** Test seam for proving queue insertion rollback when reload-gate registration fails. */
	registerInFlightWork?: typeof registerInFlightWork;
	isDisposed(): boolean;
	admit(request: WorkerDelegationRequest, record: LaneRecord): WorkerDispatchAdmission;
	getRecord(laneId: string): LaneRecord | undefined;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	cancel(laneId: string, reasonCode: string): void;
	warn(message: string): void;
}

interface PendingCancellation {
	reasonCode: string;
	deregister?: () => void;
}

/**
 * Single owner of worker queue and promise transitions. Execution policy and durable lifecycle stay
 * outside; this class only decides when a prepared durable attempt moves from queued to running.
 */
export class WorkerDispatchScheduler {
	private readonly options: WorkerDispatchSchedulerOptions;
	private readonly queued = new Map<string, WorkerDelegationRequest>();
	private readonly queuedDeregisters = new Map<string, () => void>();
	private readonly running = new Map<string, Promise<WorkerDelegationRunOutcome>>();
	private readonly pendingCancellations = new Map<string, PendingCancellation>();
	private readonly reservationBlocked = new Set<string>();
	private readonly queueCapacityListeners = new Set<() => void>();
	private draining = false;
	private redrainRequested = false;
	private reservationAvailabilityRequested = false;
	private queueCapacityNotificationPending = false;

	constructor(options: WorkerDispatchSchedulerOptions) {
		this.options = options;
	}

	get queuedCount(): number {
		return this.queued.size;
	}

	hasQueueCapacity(priority = false): boolean {
		return workerQueueHasCapacity(this.queued.size, priority);
	}

	/** Notify retained priority work when a bounded queue slot is released. */
	onQueueCapacityAvailable(listener: () => void): () => void {
		this.queueCapacityListeners.add(listener);
		return () => this.queueCapacityListeners.delete(listener);
	}

	enqueue(record: LaneRecord, request: WorkerDelegationRequest, recovered = false, priority = false): void {
		if (
			this.queued.has(record.laneId) ||
			this.running.has(record.laneId) ||
			this.pendingCancellations.has(record.laneId)
		) {
			return;
		}
		if (!this.hasQueueCapacity(priority)) throw new Error("worker_dispatch_queue_full");
		if (priority) {
			const waiting = [...this.queued];
			this.queued.clear();
			this.queued.set(record.laneId, request);
			for (const [laneId, queuedRequest] of waiting) this.queued.set(laneId, queuedRequest);
		} else {
			this.queued.set(record.laneId, request);
		}
		try {
			this.queuedDeregisters.set(
				record.laneId,
				(this.options.registerInFlightWork ?? registerInFlightWork)(
					this.options.agentDir,
					"lane",
					recovered ? `worker-recovered:${record.laneId}` : `worker-queued:${record.laneId}`,
				),
			);
		} catch (error) {
			// Queue insertion and reload-gate registration are one process-local transition. A failed
			// registration must not leave a lane that appears queued but has no matching blocker.
			this.queued.delete(record.laneId);
			this.reservationBlocked.delete(record.laneId);
			throw error;
		}
	}

	track(laneId: string, promise: Promise<WorkerDelegationRunOutcome>): void {
		this.running.set(laneId, promise);
		void promise.then(
			(outcome) => {
				try {
					if (!outcome.started) {
						const reasonCode = outcome.skipReason ?? "worker_not_started";
						if (!this.cancelBestEffort(laneId, reasonCode)) {
							this.retainPendingCancellation(laneId, reasonCode);
						}
					}
				} finally {
					this.finishTrackedRun(laneId);
				}
			},
			(error: unknown) => {
				try {
					if (!this.cancelBestEffort(laneId, "worker_background_error")) {
						this.retainPendingCancellation(laneId, "worker_background_error");
					}
					this.warnBestEffort(
						`Worker ${laneId} rejected: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					this.finishTrackedRun(laneId);
				}
			},
		);
	}

	private retainPendingCancellation(laneId: string, reasonCode: string): void {
		if (this.pendingCancellations.has(laneId)) return;
		const pending: PendingCancellation = { reasonCode };
		this.pendingCancellations.set(laneId, pending);
		this.registerPendingCancellation(laneId, pending);
	}

	private registerPendingCancellation(laneId: string, pending: PendingCancellation): void {
		if (pending.deregister) return;
		try {
			pending.deregister = (this.options.registerInFlightWork ?? registerInFlightWork)(
				this.options.agentDir,
				"lane",
				`worker-cancellation-pending:${laneId}`,
			);
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} cancellation reload-gate registration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private retryPendingCancellations(): void {
		for (const [laneId, pending] of [...this.pendingCancellations]) {
			this.registerPendingCancellation(laneId, pending);
			if (!this.cancelBestEffort(laneId, pending.reasonCode)) continue;
			this.removePendingCancellation(laneId);
		}
	}

	private removePendingCancellation(laneId: string): void {
		const pending = this.pendingCancellations.get(laneId);
		if (!pending) return;
		this.pendingCancellations.delete(laneId);
		try {
			pending.deregister?.();
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} cancellation reload-gate deregistration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private cancelBestEffort(laneId: string, reasonCode: string): boolean {
		try {
			this.options.cancel(laneId, reasonCode);
			return true;
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private finishTrackedRun(laneId: string): void {
		this.running.delete(laneId);
		if (this.options.isDisposed()) {
			// A disposed generation has no future scheduler signal. Its durable state is recovered by the
			// next generation, so do not leak this generation's process-local reload blocker.
			this.removePendingCancellation(laneId);
			return;
		}
		try {
			this.drain();
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} scheduler redrain failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private warnBestEffort(message: string): void {
		try {
			this.options.warn(message);
		} catch {
			// Diagnostics cannot retain a completed promise in the running set.
		}
	}

	drain(reservationAvailable = false): void {
		if (this.options.isDisposed()) return;
		if (reservationAvailable) this.reservationAvailabilityRequested = true;
		if (this.draining) {
			this.redrainRequested = true;
			return;
		}
		this.draining = true;
		try {
			// Promise settlement and every later scheduler signal retry each retained durable cancellation
			// once. Keep this outside the redrain loop so a reentrant signal cannot create a busy retry.
			this.retryPendingCancellations();
			do {
				this.redrainRequested = false;
				const passReservationAvailable = this.reservationAvailabilityRequested;
				this.reservationAvailabilityRequested = false;
				for (const [laneId, request] of [...this.queued]) {
					if (this.reservationBlocked.has(laneId) && !passReservationAvailable) continue;
					const record = this.options.getRecord(laneId);
					if (!record) {
						this.removeQueued(laneId);
						continue;
					}
					const admission = this.options.admit(request, record);
					if (admission.action === "wait") {
						if (admission.reason === "write_reservation") this.reservationBlocked.add(laneId);
						else this.reservationBlocked.delete(laneId);
						continue;
					}
					if (admission.action === "cancel") {
						this.reservationBlocked.delete(laneId);
						// Durable cancellation owns this transition. Retain the scheduler entry when
						// that write fails so a later explicit drain can retry it without a busy loop.
						if (!this.cancelBestEffort(laneId, admission.reasonCode)) continue;
						this.removeQueued(laneId);
						// Cancellation can synchronously block another queued task that appeared earlier.
						// Re-evaluate the bounded queue until that dependency cascade reaches a fixed point.
						this.redrainRequested = true;
						continue;
					}
					this.reservationBlocked.delete(laneId);
					this.removeQueued(laneId);
					let run: Promise<WorkerDelegationRunOutcome>;
					try {
						run = this.options.run(request, record);
					} catch (error) {
						// Preserve synchronous start semantics while routing a throwing implementation
						// through the same cancellation and cleanup owner as a rejected run promise.
						run = Promise.reject(error);
					}
					this.track(laneId, run);
				}
			} while ((this.redrainRequested || this.reservationAvailabilityRequested) && !this.options.isDisposed());
		} finally {
			this.draining = false;
		}
	}

	cancelQueued(): void {
		for (const laneId of [...this.queued.keys()]) {
			// The controller owns durable cancellation and any pre-admission resources (for example a
			// write reservation). Disposal must still visit every lane and release every process-local
			// blocker when one durable write fails; the next controller generation recovers any retained
			// durable queued attempt.
			this.cancelBestEffort(laneId, "session_disposed");
			this.removeQueued(laneId);
		}
		for (const [laneId, pending] of [...this.pendingCancellations]) {
			this.cancelBestEffort(laneId, pending.reasonCode);
			// Disposal hands any remaining durable recovery to the next controller generation. Release
			// this generation's process-local reload blocker even when its last cancellation attempt fails.
			this.removePendingCancellation(laneId);
		}
	}

	dropQueued(laneId: string): boolean {
		if (!this.queued.has(laneId)) return false;
		this.removeQueued(laneId);
		return true;
	}

	private removeQueued(laneId: string): void {
		const removed = this.queued.delete(laneId);
		this.reservationBlocked.delete(laneId);
		const deregister = this.queuedDeregisters.get(laneId);
		this.queuedDeregisters.delete(laneId);
		try {
			deregister?.();
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} reload-gate deregistration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (removed) this.notifyQueueCapacityAvailable();
	}

	private notifyQueueCapacityAvailable(): void {
		if (this.queueCapacityNotificationPending || this.queueCapacityListeners.size === 0) return;
		this.queueCapacityNotificationPending = true;
		queueMicrotask(() => {
			this.queueCapacityNotificationPending = false;
			for (const listener of this.queueCapacityListeners) {
				try {
					listener();
				} catch (error) {
					this.warnBestEffort(
						`Worker queue-capacity listener failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		});
	}
}
