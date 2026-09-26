import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { workerQueueHasCapacity } from "./worker-fleet-limits.ts";

export type WorkerDispatchWaitReason = "capacity" | "dependencies" | "objective" | "write_reservation";

export type WorkerDispatchAdmission =
	| { action: "start" }
	| { action: "wait"; reason?: WorkerDispatchWaitReason; detail?: string }
	| { action: "cancel"; reasonCode: string };

/** Process-local explanation of why a queued lane has not been dispatched yet. */
export interface WorkerDispatchWaitState {
	reason: WorkerDispatchWaitReason | "unspecified";
	detail?: string;
	/** ISO time the current reason was first observed; reset when the reason or detail changes. */
	since: string;
}

/**
 * What this scheduler observed for one lane it owned. `unowned` says only that this scheduler holds
 * nothing for that lane -- never that the work completed.
 */
export type WorkerLaneOutcome =
	| { state: "ran"; outcome: WorkerDelegationRunOutcome }
	| { state: "cancelled"; reasonCode: string }
	| { state: "failed"; error: unknown }
	| { state: "unowned" };

interface WorkerLaneObserver {
	resolve(outcome: WorkerLaneOutcome): void;
	onStarted?(record: LaneRecord): void;
	/** True while this observer belongs to a resume waiting behind the lane's current run. */
	deferredGeneration: boolean;
}

/** One line for status views: `write_reservation: … (since 2026-09-08T08:14:26.000Z)`. */
export function formatWorkerDispatchWait(state: WorkerDispatchWaitState): string {
	return `${state.reason}${state.detail ? `: ${state.detail}` : ""} (since ${state.since})`;
}

export interface WorkerDispatchSchedulerOptions {
	agentDir: string;
	/** Test seam for proving queue insertion rollback when reload-gate registration fails. */
	registerInFlightWork?: typeof registerInFlightWork;
	isDisposed(): boolean;
	admit(request: WorkerDelegationRequest, record: LaneRecord): WorkerDispatchAdmission;
	/** Read-only asynchronous validation; queue ownership stays live until it settles. */
	preflight?(
		request: WorkerDelegationRequest,
		record: LaneRecord,
	): Promise<Exclude<WorkerDispatchAdmission, { action: "wait" }>>;
	getRecord(laneId: string): LaneRecord | undefined;
	/** Exact durable attempt generation that this scheduler may dispatch; undefined means another owner. */
	getDispatchToken?(laneId: string): string | undefined;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	/** Literal false means the exact attempt changed before conditional cancellation could commit. */
	cancel(laneId: string, reasonCode: string, dispatchToken?: string): unknown;
	warn(message: string): void;
}

interface PendingCancellation {
	reasonCode: string;
	dispatchToken?: string;
	deregister?: () => void;
}

type CancellationOutcome = { state: "cancelled" } | { state: "unowned" } | { state: "failed"; error: unknown };

/**
 * Single owner of worker queue and promise transitions. Execution policy and durable lifecycle stay
 * outside; this class only decides when a prepared durable attempt moves from queued to running.
 */
export class WorkerDispatchScheduler {
	private readonly options: WorkerDispatchSchedulerOptions;
	private readonly queued = new Map<string, WorkerDelegationRequest>();
	private readonly queuedDispatchTokens = new Map<string, string | undefined>();
	private readonly queuedDeregisters = new Map<string, () => void>();
	private readonly running = new Map<string, Promise<WorkerDelegationRunOutcome>>();
	private readonly runningDispatchTokens = new Map<string, string | undefined>();
	/** Lanes enqueued while their previous run was still settling; queued when that run finishes. */
	private readonly deferred = new Map<
		string,
		{
			record: LaneRecord;
			request: WorkerDelegationRequest;
			recovered: boolean;
			priority: boolean;
			dispatchToken?: string;
		}
	>();
	private readonly preflights = new Map<string, symbol>();
	private readonly validated = new Set<string>();
	private readonly pendingCancellations = new Map<string, PendingCancellation>();
	private readonly reservationBlocked = new Set<string>();
	private readonly waitStates = new Map<string, WorkerDispatchWaitState>();
	private readonly queueCapacityListeners = new Set<() => void>();
	/**
	 * Callers awaiting the outcome this scheduler produces for a lane. Entries exist only while an
	 * observer is waiting: every terminal transition settles and removes its set, so no completed run
	 * is retained here.
	 */
	private readonly laneObservers = new Map<string, Set<WorkerLaneObserver>>();
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

	/** Why a queued lane is still waiting, or undefined once it left the queue or was never admitted. */
	getWaitState(laneId: string): WorkerDispatchWaitState | undefined {
		return this.queued.has(laneId) ? this.waitStates.get(laneId) : undefined;
	}

	private recordWait(laneId: string, admission: Extract<WorkerDispatchAdmission, { action: "wait" }>): void {
		const reason = admission.reason ?? "unspecified";
		const current = this.waitStates.get(laneId);
		if (current && current.reason === reason && current.detail === admission.detail) return;
		this.waitStates.set(laneId, {
			reason,
			...(admission.detail ? { detail: admission.detail } : {}),
			since: new Date().toISOString(),
		});
	}

	hasQueueCapacity(priority = false): boolean {
		return workerQueueHasCapacity(this.queued.size, priority);
	}

	/** Notify retained priority work when a bounded queue slot is released. */
	onQueueCapacityAvailable(listener: () => void): () => void {
		this.queueCapacityListeners.add(listener);
		return () => this.queueCapacityListeners.delete(listener);
	}

	enqueue(
		record: LaneRecord,
		request: WorkerDelegationRequest,
		recovered = false,
		priority = false,
		dispatchToken = this.options.getDispatchToken?.(record.laneId),
	): void {
		if (this.running.has(record.laneId)) {
			// The previous run is still unwinding (an interrupt aborted it and a resume followed at once):
			// queue the lane the moment that run settles, instead of dropping the resume.
			this.deferred.set(record.laneId, { record, request, recovered, priority, dispatchToken });
			return;
		}
		if (this.queued.has(record.laneId) || this.pendingCancellations.has(record.laneId)) {
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
		this.queuedDispatchTokens.set(record.laneId, dispatchToken);
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
			this.queuedDispatchTokens.delete(record.laneId);
			this.reservationBlocked.delete(record.laneId);
			throw error;
		}
	}

	/** Is this lane's run executing (tracked and not yet settled)? */
	isRunning(laneId: string): boolean {
		return this.running.has(laneId);
	}

	/** Does this scheduler currently own this lane's queue entry or its run? */
	ownsLane(laneId: string): boolean {
		return (
			this.queued.has(laneId) || this.running.has(laneId) || this.deferred.has(laneId) || this.preflights.has(laneId)
		);
	}

	/**
	 * Observe the outcome THIS scheduler reaches for a lane it owns, across every transition it owns:
	 * preflight rejection, admission cancellation, a dropped queue entry, disposal, and the tracked
	 * run's own settlement. Register before the transition that could start or settle the lane, so a
	 * synchronous drain cannot complete unobserved. A lane this scheduler does not own settles
	 * immediately with `unowned`, which is not a completion claim.
	 */
	observeLane(laneId: string, hooks: { onStarted?: (record: LaneRecord) => void } = {}): Promise<WorkerLaneOutcome> {
		if (!this.ownsLane(laneId)) return Promise.resolve({ state: "unowned" });
		const deferredGeneration = this.deferred.has(laneId);
		const observed = new Promise<WorkerLaneOutcome>((resolve) => {
			const observers = this.laneObservers.get(laneId) ?? new Set<WorkerLaneObserver>();
			observers.add({
				resolve,
				deferredGeneration,
				...(hooks.onStarted ? { onStarted: hooks.onStarted } : {}),
			});
			this.laneObservers.set(laneId, observers);
		});
		// The start transition may already have happened. An observer that arrives afterwards still
		// needs it once, reported from the lane's own current projection. A deferred observer belongs
		// to the next run and must not receive the previous generation's running record.
		if (hooks.onStarted && !deferredGeneration && this.running.has(laneId)) {
			const started = this.options.getRecord(laneId);
			if (started?.status === "running") this.notifyStart(laneId, hooks.onStarted, started);
		}
		return observed;
	}

	private settleLaneObservers(laneId: string, outcome: WorkerLaneOutcome, deferredGeneration = false): void {
		const observers = this.laneObservers.get(laneId);
		if (!observers) return;
		for (const observer of [...observers]) {
			if (observer.deferredGeneration !== deferredGeneration) continue;
			observers.delete(observer);
			observer.resolve(outcome);
		}
		if (observers.size === 0) this.laneObservers.delete(laneId);
	}

	private promoteDeferredObservers(laneId: string): void {
		const observers = this.laneObservers.get(laneId);
		if (!observers) return;
		for (const observer of observers) {
			if (observer.deferredGeneration) observer.deferredGeneration = false;
		}
	}

	private notifyStart(laneId: string, onStarted: (record: LaneRecord) => void, record: LaneRecord): void {
		try {
			onStarted(record);
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} start notification failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Announce the lane's ACTUAL start, after `options.run` accepted it: the run owns the durable
	 * lease transition, so the record is re-read here instead of replaying the queued one.
	 */
	private announceLaneStart(laneId: string): void {
		const observers = this.laneObservers.get(laneId);
		if (!observers || observers.size === 0) return;
		const started = this.options.getRecord(laneId);
		if (started?.status !== "running") return;
		for (const observer of observers) {
			if (!observer.deferredGeneration && observer.onStarted) {
				this.notifyStart(laneId, observer.onStarted, started);
			}
		}
	}

	track(
		laneId: string,
		promise: Promise<WorkerDelegationRunOutcome>,
		dispatchToken = this.options.getDispatchToken?.(laneId),
	): void {
		this.running.set(laneId, promise);
		this.runningDispatchTokens.set(laneId, dispatchToken);
		void promise.then(
			(outcome) => {
				let observed: WorkerLaneOutcome = { state: "ran", outcome };
				try {
					if (!outcome.started) {
						const reasonCode = outcome.skipReason ?? "worker_not_started";
						const cancellation = this.cancelWithOutcome(laneId, reasonCode, dispatchToken);
						if (cancellation.state === "failed")
							this.retainPendingCancellation(laneId, reasonCode, dispatchToken);
						else if (cancellation.state === "unowned") observed = { state: "unowned" };
					}
				} finally {
					this.settleLaneObservers(laneId, observed);
					this.finishTrackedRun(laneId);
				}
			},
			(error: unknown) => {
				let observed: WorkerLaneOutcome = { state: "failed", error };
				try {
					const cancellation = this.cancelWithOutcome(laneId, "worker_background_error", dispatchToken);
					if (cancellation.state === "failed")
						this.retainPendingCancellation(laneId, "worker_background_error", dispatchToken);
					else if (cancellation.state === "unowned") observed = { state: "unowned" };
					this.warnBestEffort(
						`Worker ${laneId} rejected: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					this.settleLaneObservers(laneId, observed);
					this.finishTrackedRun(laneId);
				}
			},
		);
	}

	private retainPendingCancellation(laneId: string, reasonCode: string, dispatchToken?: string): void {
		if (this.pendingCancellations.has(laneId)) return;
		const pending: PendingCancellation = { reasonCode, dispatchToken };
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
			const cancellation = this.cancelWithOutcome(laneId, pending.reasonCode, pending.dispatchToken);
			if (cancellation.state === "failed") continue;
			// A durable cancellation terminals the lane rather than freeing its deferred resume for
			// promotion. Delete that ownership before removeQueued releases capacity to other lanes.
			const hadDeferred = this.deferred.delete(laneId);
			this.removePendingCancellation(laneId);
			this.removeQueued(laneId);
			const outcome: WorkerLaneOutcome =
				cancellation.state === "cancelled"
					? { state: "cancelled", reasonCode: pending.reasonCode }
					: { state: "unowned" };
			this.settleLaneObservers(laneId, outcome);
			if (hadDeferred) {
				this.settleLaneObservers(laneId, outcome, true);
			}
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

	/**
	 * Durable cancellation owns whether a lane actually ended. The error is returned, not only logged,
	 * because an observer told "cancelled" when the write failed would be told something untrue.
	 */
	private cancelWithOutcome(
		laneId: string,
		reasonCode: string,
		dispatchToken = this.queuedDispatchTokens.get(laneId) ??
			this.runningDispatchTokens.get(laneId) ??
			this.pendingCancellations.get(laneId)?.dispatchToken,
	): CancellationOutcome {
		try {
			const cancelled =
				dispatchToken === undefined
					? this.options.cancel(laneId, reasonCode)
					: this.options.cancel(laneId, reasonCode, dispatchToken);
			return cancelled === false ? { state: "unowned" } : { state: "cancelled" };
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { state: "failed", error };
		}
	}

	private finishTrackedRun(laneId: string): void {
		this.running.delete(laneId);
		this.runningDispatchTokens.delete(laneId);
		if (this.options.isDisposed()) {
			// A disposed generation has no future scheduler signal. Its durable state is recovered by the
			// next generation, so do not leak this generation's process-local reload blocker.
			if (this.deferred.delete(laneId)) {
				this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: "session_disposed" }, true);
			}
			this.removePendingCancellation(laneId);
			return;
		}
		this.promoteDeferred();
		this.redrainBestEffort(laneId);
	}

	/** Transfer retained resumes into real bounded queue slots without an ownership gap. */
	private promoteDeferred(): void {
		const candidates = [...this.deferred].sort(
			([, left], [, right]) => Number(right.priority) - Number(left.priority),
		);
		for (const [laneId, deferred] of candidates) {
			if (this.running.has(laneId) || this.pendingCancellations.has(laneId)) continue;
			if (!this.hasQueueCapacity(deferred.priority)) continue;
			try {
				this.enqueue(
					deferred.record,
					deferred.request,
					deferred.recovered,
					deferred.priority,
					deferred.dispatchToken,
				);
			} catch (error) {
				this.warnBestEffort(
					`Worker ${laneId} deferred resume promotion failed; retaining it for the next scheduler signal: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			// enqueue can decline a lane already owned by cancellation. Transfer ownership only when the
			// bounded queue demonstrably contains the exact lane.
			if (!this.queued.has(laneId)) continue;
			this.deferred.delete(laneId);
			this.promoteDeferredObservers(laneId);
			if (this.draining) this.redrainRequested = true;
		}
	}

	private redrainBestEffort(laneId: string): void {
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

	private currentQueuedRecord(
		laneId: string,
	): { state: "dispatchable"; record: LaneRecord } | { state: "missing" } | { state: "unowned" } {
		const record = this.options.getRecord(laneId);
		if (!record) return { state: "missing" };
		if (this.options.getDispatchToken) {
			const expected = this.queuedDispatchTokens.get(laneId);
			const current = this.options.getDispatchToken(laneId);
			// Absence is not identity: two undefined values must never make stale ownership compare equal.
			if (expected === undefined || current === undefined || current !== expected) return { state: "unowned" };
		} else if (record.status !== "queued") {
			// Tests and generic adapters without durable attempt identity retain the conservative status fence.
			return { state: "unowned" };
		}
		return { state: "dispatchable", record };
	}

	private settleQueuedUnowned(laneId: string): void {
		this.removePendingCancellation(laneId);
		this.removeQueued(laneId);
		this.settleLaneObservers(laneId, { state: "unowned" });
	}

	private beginPreflight(request: WorkerDelegationRequest, record: LaneRecord): void {
		const laneId = record.laneId;
		if (this.preflights.has(laneId)) return;
		const token = Symbol();
		this.preflights.set(laneId, token);
		void (async () => {
			let result: Exclude<WorkerDispatchAdmission, { action: "wait" }>;
			try {
				result = await this.options.preflight!(request, record);
			} catch (error) {
				this.warnBestEffort(
					`Worker ${laneId} preflight failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				result = { action: "cancel", reasonCode: "worker_preflight_error" };
			}
			if (this.preflights.get(laneId) !== token) return;
			this.preflights.delete(laneId);
			if (this.options.isDisposed() || !this.queued.has(laneId)) return;
			const ownership = this.currentQueuedRecord(laneId);
			if (ownership.state === "missing") {
				this.removeQueued(laneId);
				this.settleLaneObservers(laneId, {
					state: "cancelled",
					reasonCode: "orchestration_projection_missing",
				});
				return;
			}
			if (ownership.state === "unowned") {
				this.settleQueuedUnowned(laneId);
				return;
			}
			if (result.action === "cancel") {
				const dispatchToken = this.queuedDispatchTokens.get(laneId);
				const cancellation = this.cancelWithOutcome(laneId, result.reasonCode, dispatchToken);
				if (cancellation.state === "cancelled") {
					this.removeQueued(laneId);
					this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: result.reasonCode });
					return;
				}
				if (cancellation.state === "unowned") {
					this.settleQueuedUnowned(laneId);
					return;
				}
				// The durable cancellation failed: this lane is still owned and still executable, so no
				// observer may be told it was cancelled. Retain it for the next scheduler signal, which
				// retries the same reason through `retryPendingCancellations`.
				this.retainPendingCancellation(laneId, result.reasonCode, dispatchToken);
				return;
			}
			this.validated.add(laneId);
			this.redrainBestEffort(laneId);
		})();
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
			this.promoteDeferred();
			do {
				this.redrainRequested = false;
				const passReservationAvailable = this.reservationAvailabilityRequested;
				this.reservationAvailabilityRequested = false;
				for (const [laneId, request] of [...this.queued]) {
					if (this.pendingCancellations.has(laneId)) continue;
					if (this.reservationBlocked.has(laneId) && !passReservationAvailable) continue;
					const ownership = this.currentQueuedRecord(laneId);
					if (ownership.state === "missing") {
						this.removeQueued(laneId);
						this.settleLaneObservers(laneId, {
							state: "cancelled",
							reasonCode: "orchestration_projection_missing",
						});
						continue;
					}
					if (ownership.state === "unowned") {
						this.settleQueuedUnowned(laneId);
						continue;
					}
					const record = ownership.record;
					const admission = this.options.admit(request, record);
					if (admission.action === "wait") {
						this.validated.delete(laneId);
						this.recordWait(laneId, admission);
						if (admission.reason === "write_reservation") this.reservationBlocked.add(laneId);
						else this.reservationBlocked.delete(laneId);
						continue;
					}
					this.waitStates.delete(laneId);
					if (admission.action === "cancel") {
						this.reservationBlocked.delete(laneId);
						// Durable cancellation owns this transition. Retain the scheduler entry when
						// that write fails so a later explicit drain can retry it without a busy loop.
						const dispatchToken = this.queuedDispatchTokens.get(laneId);
						const cancellation = this.cancelWithOutcome(laneId, admission.reasonCode, dispatchToken);
						if (cancellation.state === "failed") {
							this.retainPendingCancellation(laneId, admission.reasonCode, dispatchToken);
							continue;
						}
						if (cancellation.state === "unowned") {
							this.settleQueuedUnowned(laneId);
							continue;
						}
						this.removeQueued(laneId);
						this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: admission.reasonCode });
						// Cancellation can synchronously block another queued task that appeared earlier.
						// Re-evaluate the bounded queue until that dependency cascade reaches a fixed point.
						this.redrainRequested = true;
						continue;
					}
					if (this.options.preflight && !this.validated.has(laneId)) {
						this.beginPreflight(request, record);
						continue;
					}
					this.reservationBlocked.delete(laneId);
					const dispatchToken = this.queuedDispatchTokens.get(laneId);
					this.removeQueued(laneId);
					let run: Promise<WorkerDelegationRunOutcome>;
					let started = true;
					try {
						run = this.options.run(request, record);
					} catch (error) {
						// Preserve synchronous start semantics while routing a throwing implementation
						// through the same cancellation and cleanup owner as a rejected run promise.
						run = Promise.reject(error);
						started = false;
					}
					this.track(laneId, run, dispatchToken);
					// A run that threw before doing anything never started: only a run this scheduler
					// handed the lane to may be announced, and only with the lane's own current record.
					if (started) this.announceLaneStart(laneId);
				}
			} while ((this.redrainRequested || this.reservationAvailabilityRequested) && !this.options.isDisposed());
		} finally {
			this.draining = false;
		}
	}

	cancelQueued(): void {
		for (const laneId of this.deferred.keys()) {
			this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: "session_disposed" }, true);
		}
		this.deferred.clear();
		for (const laneId of [...this.queued.keys()]) {
			// The controller owns durable cancellation and any pre-admission resources (for example a
			// write reservation). Disposal must still visit every lane and release every process-local
			// blocker when one durable write fails; the next controller generation recovers any retained
			// durable queued attempt.
			const outcome = this.cancelWithOutcome(laneId, "session_disposed");
			this.removeQueued(laneId);
			// A disposed generation has no future signal, so an observer must not be left waiting for
			// one. A successful durable cancellation is a cancellation; a failed one is reported as the
			// failure it was, carrying the original error, and the next generation recovers the lane.
			this.settleLaneObservers(
				laneId,
				outcome.state === "cancelled"
					? { state: "cancelled", reasonCode: "session_disposed" }
					: outcome.state === "unowned"
						? { state: "unowned" }
						: { state: "failed", error: outcome.error },
			);
		}
		for (const [laneId, pending] of [...this.pendingCancellations]) {
			this.cancelWithOutcome(laneId, pending.reasonCode, pending.dispatchToken);
			// Disposal hands any remaining durable recovery to the next controller generation. Release
			// this generation's process-local reload blocker even when its last cancellation attempt fails.
			this.removePendingCancellation(laneId);
		}
	}

	dropQueued(laneId: string): boolean {
		// A cancel also withdraws a resume that was waiting for the previous run to settle.
		const hadDeferred = this.deferred.delete(laneId);
		if (hadDeferred) {
			this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: "worker_dispatch_dropped" }, true);
		}
		if (!this.queued.has(laneId)) return hadDeferred;
		this.removeQueued(laneId);
		this.settleLaneObservers(laneId, { state: "cancelled", reasonCode: "worker_dispatch_dropped" });
		return true;
	}

	private removeQueued(laneId: string): void {
		this.preflights.delete(laneId);
		this.validated.delete(laneId);
		const removed = this.queued.delete(laneId);
		this.queuedDispatchTokens.delete(laneId);
		this.reservationBlocked.delete(laneId);
		this.waitStates.delete(laneId);
		const deregister = this.queuedDeregisters.get(laneId);
		this.queuedDeregisters.delete(laneId);
		try {
			deregister?.();
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} reload-gate deregistration failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (removed) {
			// Capacity is an event, not a poll. A resume retained while its previous run unwound owns the
			// released slot before external recovery listeners compete for it.
			this.promoteDeferred();
			this.notifyQueueCapacityAvailable();
		}
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
