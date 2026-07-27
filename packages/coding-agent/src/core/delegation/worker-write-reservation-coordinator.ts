import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import { isLocalProcessAlive, localWorkerProcessOwnerLiveness } from "./worker-process-owner.ts";
import { type WorkerWriteReservationLease, WorkerWriteReservationStore } from "./worker-write-reservation.ts";

export type WorkerWriteReservationAdmission =
	| { kind: "granted" }
	| { kind: "blocked" }
	| { kind: "denied"; reasonCode: "write_reservation_scope_invalid" | "write_reservation_unavailable" };

export interface WorkerWriteReservationCoordinatorOptions {
	agentDir: string;
	getCwd(): string;
	getParentSessionId(): string;
	ownerId: string;
	drainQueuedWorkers(): void;
	warn(message: string): void;
	isProcessAlive?(pid: number): boolean;
}

/**
 * Owns one controller process's write-reservation lifecycle: admission, exact-fence release,
 * event-driven queue wakeup, and fail-closed recovery of positively dead owners.
 */
export class WorkerWriteReservationCoordinator {
	private readonly options: WorkerWriteReservationCoordinatorOptions;
	private readonly store: WorkerWriteReservationStore;
	private readonly leases = new Map<string, WorkerWriteReservationLease>();
	private watchDispose: (() => void) | undefined;

	constructor(options: WorkerWriteReservationCoordinatorOptions) {
		this.options = options;
		this.store = new WorkerWriteReservationStore({ agentDir: options.agentDir });
	}

	acquire(
		laneId: string,
		attempt: Pick<AttemptRuntimeState, "attemptId" | "lease">,
		plan: Pick<WorkerExecutionPlan, "writeEnabled" | "writePaths">,
	): WorkerWriteReservationAdmission {
		if (!plan.writeEnabled || plan.writePaths.length === 0) return { kind: "granted" };
		const fencingToken = (attempt.lease?.fencingToken ?? 0) + 1;
		const current = this.leases.get(laneId);
		if (current && current.attemptId === attempt.attemptId && current.fencingToken === fencingToken) {
			return { kind: "granted" };
		}
		try {
			const result = this.store.acquire({
				parentSessionId: this.options.getParentSessionId(),
				ownerId: this.options.ownerId,
				taskId: laneId,
				attemptId: attempt.attemptId,
				fencingToken,
				access: "write",
				workspace: this.workspace(),
				writeScopes: plan.writePaths,
			});
			if (result.kind !== "granted" || !result.lease) {
				this.ensureWatch();
				return { kind: "blocked" };
			}
			this.leases.set(laneId, result.lease);
			return { kind: "granted" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.warn(`Worker write reservation denied: ${message}`);
			return {
				kind: "denied",
				reasonCode: message.includes("within the execution root")
					? "write_reservation_scope_invalid"
					: "write_reservation_unavailable",
			};
		}
	}

	hasFenceMismatch(laneId: string, attemptId: string, fencingToken: number): boolean {
		const lease = this.leases.get(laneId);
		return lease !== undefined && (lease.attemptId !== attemptId || lease.fencingToken !== fencingToken);
	}

	release(laneId: string, expectedAttemptId?: string, expectedFencingToken?: number): void {
		const held = this.leases.get(laneId);
		if (!held) return;
		if (expectedAttemptId !== undefined && held.attemptId !== expectedAttemptId) return;
		if (expectedFencingToken !== undefined && held.fencingToken !== expectedFencingToken) return;
		try {
			this.store.release(held);
		} catch (error) {
			this.options.warn(
				`Failed to release worker write reservation ${laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (this.leases.get(laneId) === held) this.leases.delete(laneId);
		}
	}

	recoverProvenStale(): void {
		const discovered = this.store.recover({ workspace: this.workspace(), evidence: [] });
		const evidence = discovered.outcomes.map((outcome) => ({
			reservationId: outcome.reservationId,
			state:
				localWorkerProcessOwnerLiveness(
					outcome.lease.ownerId,
					this.options.isProcessAlive ?? isLocalProcessAlive,
				) === "dead"
					? ("not_live" as const)
					: ("unknown" as const),
		}));
		for (const outcome of this.store.recover({ workspace: this.workspace(), evidence }).outcomes) {
			if (outcome.kind !== "stale") continue;
			const released = this.store.release(outcome.lease);
			if (released.kind !== "released" && released.kind !== "not_found") {
				this.options.warn(
					`Stale worker write reservation ${outcome.reservationId} was not released (${released.kind}).`,
				);
			}
		}
	}

	dispose(): void {
		this.watchDispose?.();
		this.watchDispose = undefined;
	}

	private workspace() {
		const cwd = this.options.getCwd();
		return { repositoryRoot: cwd, executionRoot: cwd };
	}

	private ensureWatch(): void {
		if (this.watchDispose) return;
		this.watchDispose = this.store.watchAvailability(this.workspace(), () => this.options.drainQueuedWorkers());
	}
}
