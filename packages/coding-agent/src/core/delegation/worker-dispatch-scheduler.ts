import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";

export type WorkerDispatchAdmission =
	| { action: "start" }
	| { action: "wait"; reason?: "capacity" | "write_reservation" }
	| { action: "cancel"; reasonCode: string };

export interface WorkerDispatchSchedulerOptions {
	agentDir: string;
	isDisposed(): boolean;
	admit(request: WorkerDelegationRequest, record: LaneRecord): WorkerDispatchAdmission;
	getRecord(laneId: string): LaneRecord | undefined;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	cancel(laneId: string, reasonCode: string): void;
	warn(message: string): void;
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
	private readonly reservationBlocked = new Set<string>();
	private draining = false;

	constructor(options: WorkerDispatchSchedulerOptions) {
		this.options = options;
	}

	get queuedCount(): number {
		return this.queued.size;
	}

	enqueue(record: LaneRecord, request: WorkerDelegationRequest, recovered = false, priority = false): void {
		if (this.queued.has(record.laneId) || this.running.has(record.laneId)) return;
		if (priority) {
			const waiting = [...this.queued];
			this.queued.clear();
			this.queued.set(record.laneId, request);
			for (const [laneId, queuedRequest] of waiting) this.queued.set(laneId, queuedRequest);
		} else {
			this.queued.set(record.laneId, request);
		}
		this.queuedDeregisters.set(
			record.laneId,
			registerInFlightWork(
				this.options.agentDir,
				"lane",
				recovered ? `worker-recovered:${record.laneId}` : `worker-queued:${record.laneId}`,
			),
		);
	}

	track(laneId: string, promise: Promise<WorkerDelegationRunOutcome>): void {
		this.running.set(laneId, promise);
		void promise.then(
			(outcome) => {
				if (!outcome.started) this.options.cancel(laneId, outcome.skipReason ?? "worker_not_started");
				this.running.delete(laneId);
				if (!this.options.isDisposed()) this.drain();
			},
			(error: unknown) => {
				this.options.cancel(laneId, "worker_background_error");
				this.options.warn(`Worker ${laneId} rejected: ${error instanceof Error ? error.message : String(error)}`);
				this.running.delete(laneId);
				if (!this.options.isDisposed()) this.drain();
			},
		);
	}

	drain(reservationAvailable = false): void {
		if (this.draining || this.options.isDisposed()) return;
		this.draining = true;
		try {
			for (const [laneId, request] of [...this.queued]) {
				if (this.reservationBlocked.has(laneId) && !reservationAvailable) continue;
				const record = this.options.getRecord(laneId);
				if (!record) {
					this.removeQueued(laneId);
					continue;
				}
				const admission = this.options.admit(request, record);
				if (admission.action === "wait") {
					if (admission.reason === "write_reservation") this.reservationBlocked.add(laneId);
					continue;
				}
				this.reservationBlocked.delete(laneId);
				this.removeQueued(laneId);
				if (admission.action === "cancel") {
					this.options.cancel(laneId, admission.reasonCode);
					continue;
				}
				this.track(laneId, this.options.run(request, record));
			}
		} finally {
			this.draining = false;
		}
	}

	cancelQueued(): void {
		for (const laneId of [...this.queued.keys()]) {
			// The controller owns durable cancellation and any pre-admission resources (for example a
			// write reservation). Dropping this scheduler-only reference would leak those resources.
			this.options.cancel(laneId, "session_disposed");
			this.removeQueued(laneId);
		}
	}

	dropQueued(laneId: string): boolean {
		if (!this.queued.has(laneId)) return false;
		this.removeQueued(laneId);
		return true;
	}

	private removeQueued(laneId: string): void {
		this.queued.delete(laneId);
		this.reservationBlocked.delete(laneId);
		this.queuedDeregisters.get(laneId)?.();
		this.queuedDeregisters.delete(laneId);
	}
}
