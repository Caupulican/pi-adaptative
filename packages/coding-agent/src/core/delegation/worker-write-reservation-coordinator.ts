import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import { isLocalProcessAlive, localWorkerProcessOwnerLiveness } from "./worker-process-owner.ts";
import {
	type WorkerWriteReservationLease,
	type WorkerWriteReservationRequest,
	WorkerWriteReservationStore,
} from "./worker-write-reservation.ts";

export type WorkerWriteReservationAdmission =
	| { kind: "granted" }
	| { kind: "blocked" }
	| { kind: "denied"; reasonCode: "write_reservation_scope_invalid" | "write_reservation_unavailable" };

export interface WorkerWriteReservationWaitYield {
	laneId: string;
	lease: WorkerWriteReservationLease;
}

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
	private readonly blockedByLocalLaneIds = new Map<string, Set<string>>();
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
		if (!plan.writeEnabled || plan.writePaths.length === 0) {
			this.blockedByLocalLaneIds.delete(laneId);
			return { kind: "granted" };
		}
		const fencingToken = (attempt.lease?.fencingToken ?? 0) + 1;
		const current = this.leases.get(laneId);
		if (current && current.attemptId === attempt.attemptId && current.fencingToken === fencingToken) {
			this.blockedByLocalLaneIds.delete(laneId);
			return { kind: "granted" };
		}
		return this.acquireLease(
			laneId,
			{
				parentSessionId: this.options.getParentSessionId(),
				ownerId: this.options.ownerId,
				taskId: laneId,
				attemptId: attempt.attemptId,
				fencingToken,
				access: "write",
				workspace: this.workspace(),
				writeScopes: plan.writePaths,
			},
			"Worker write reservation denied",
			true,
		);
	}

	hasFenceMismatch(laneId: string, attemptId: string, fencingToken: number): boolean {
		const lease = this.leases.get(laneId);
		return lease !== undefined && (lease.attemptId !== attemptId || lease.fencingToken !== fencingToken);
	}

	isBlockedBy(targetLaneId: string, blockerLaneId: string): boolean {
		return this.blockedByLocalLaneIds.get(targetLaneId)?.has(blockerLaneId) === true;
	}

	/** Release one exact live caller lane while its model turn is blocked inside a worker wait. */
	yieldForWait(
		laneId: string,
		expectedAttemptId: string,
		expectedFencingToken: number,
	): WorkerWriteReservationWaitYield | undefined {
		const held = this.leases.get(laneId);
		if (!held) return undefined;
		if (held.attemptId !== expectedAttemptId || held.fencingToken !== expectedFencingToken) {
			throw new Error("Worker wait cannot yield a write reservation owned by another attempt fence.");
		}
		const released = this.store.release(held);
		if (released.kind === "stale_fence") {
			throw new Error("Worker wait write reservation yield encountered a stale attempt fence.");
		}
		this.forgetLease(laneId, held);
		return {
			laneId,
			lease: { ...held, writeScopes: [...held.writeScopes] },
		};
	}

	/** Reacquire the exact yielded attempt fence before its model turn may resume. */
	restoreAfterWait(yielded: WorkerWriteReservationWaitYield): WorkerWriteReservationAdmission {
		const { laneId, lease } = yielded;
		if (
			lease.taskId !== laneId ||
			lease.parentSessionId !== this.options.getParentSessionId() ||
			lease.ownerId !== this.options.ownerId
		) {
			return { kind: "denied", reasonCode: "write_reservation_unavailable" };
		}
		const current = this.leases.get(laneId);
		if (current) {
			return current.attemptId === lease.attemptId && current.fencingToken === lease.fencingToken
				? { kind: "granted" }
				: { kind: "denied", reasonCode: "write_reservation_unavailable" };
		}
		return this.acquireLease(
			laneId,
			{
				parentSessionId: lease.parentSessionId,
				ownerId: lease.ownerId,
				taskId: lease.taskId,
				attemptId: lease.attemptId,
				fencingToken: lease.fencingToken,
				access: "write",
				workspace: {
					repositoryRoot: lease.repositoryRoot,
					executionRoot: lease.executionRoot,
					...(lease.isolatedWorktreeId ? { isolatedWorktreeId: lease.isolatedWorktreeId } : {}),
				},
				writeScopes: lease.writeScopes,
			},
			"Worker write reservation restore denied",
			false,
		);
	}

	release(laneId: string, expectedAttemptId?: string, expectedFencingToken?: number): void {
		const held = this.leases.get(laneId);
		if (!held) {
			this.blockedByLocalLaneIds.delete(laneId);
			return;
		}
		if (expectedAttemptId !== undefined && held.attemptId !== expectedAttemptId) return;
		if (expectedFencingToken !== undefined && held.fencingToken !== expectedFencingToken) return;
		try {
			this.store.release(held);
		} catch (error) {
			this.options.warn(
				`Failed to release worker write reservation ${laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.forgetLease(laneId, held);
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
		this.blockedByLocalLaneIds.clear();
	}

	private workspace() {
		const cwd = this.options.getCwd();
		return { repositoryRoot: cwd, executionRoot: cwd };
	}

	private acquireLease(
		laneId: string,
		request: WorkerWriteReservationRequest,
		warningPrefix: string,
		classifyScopeFailure: boolean,
	): WorkerWriteReservationAdmission {
		try {
			const result = this.store.acquire(request);
			if (result.kind === "blocked") {
				this.recordLocalBlockers(laneId, result.conflictingReservationIds);
				this.ensureWatch();
				return { kind: "blocked" };
			}
			if (!result.lease) {
				this.blockedByLocalLaneIds.delete(laneId);
				this.ensureWatch();
				return { kind: "blocked" };
			}
			this.blockedByLocalLaneIds.delete(laneId);
			this.leases.set(laneId, result.lease);
			return { kind: "granted" };
		} catch (error) {
			this.blockedByLocalLaneIds.delete(laneId);
			const message = error instanceof Error ? error.message : String(error);
			this.options.warn(`${warningPrefix}: ${message}`);
			return {
				kind: "denied",
				reasonCode:
					classifyScopeFailure && message.includes("within the execution root")
						? "write_reservation_scope_invalid"
						: "write_reservation_unavailable",
			};
		}
	}

	private recordLocalBlockers(laneId: string, conflictingReservationIds: readonly string[] | undefined): void {
		const conflictingIds = new Set(conflictingReservationIds ?? []);
		const localBlockers = new Set(
			[...this.leases]
				.filter(([, lease]) => conflictingIds.has(lease.reservationId))
				.map(([blockedLaneId]) => blockedLaneId),
		);
		if (localBlockers.size > 0) this.blockedByLocalLaneIds.set(laneId, localBlockers);
		else this.blockedByLocalLaneIds.delete(laneId);
	}

	private forgetLease(laneId: string, held: WorkerWriteReservationLease): void {
		if (this.leases.get(laneId) !== held) return;
		this.leases.delete(laneId);
		this.blockedByLocalLaneIds.delete(laneId);
		for (const [targetLaneId, blockerLaneIds] of this.blockedByLocalLaneIds) {
			blockerLaneIds.delete(laneId);
			if (blockerLaneIds.size === 0) this.blockedByLocalLaneIds.delete(targetLaneId);
		}
	}

	private ensureWatch(): void {
		if (this.watchDispose) return;
		this.watchDispose = this.store.watchAvailability(this.workspace(), () => this.options.drainQueuedWorkers());
	}
}
