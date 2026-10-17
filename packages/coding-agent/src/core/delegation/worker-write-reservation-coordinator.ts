import { canonicalPathScopeIdentity } from "../autonomy/path-scope.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { AtomicFileLockOptions } from "../util/atomic-file.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import { resolveWorkerWorkspacePath, workerMachinePathRoots } from "./worker-machine-scope.ts";
import { isLocalProcessAlive, localWorkerProcessOwnerLiveness } from "./worker-process-owner.ts";
import {
	type WorkerWriteReservationConflict,
	type WorkerWriteReservationLease,
	type WorkerWriteReservationReleaseResult,
	type WorkerWriteReservationRequest,
	WorkerWriteReservationStore,
	type WorkerWriteReservationWorkspace,
} from "./worker-write-reservation.ts";

/** Why a write admission is blocked, in terms the parent can act on. */
export interface WorkerWriteReservationBlockDetail {
	reasonCode: "overlapping_write_scope" | "attempt_reservation_conflict" | "reservation_capacity_reached";
	repositoryRoot: string;
	/** Reservations still standing after dead-owner reaping. */
	conflicts: readonly {
		reservationId: string;
		ownerId: string;
		parentSessionId: string;
		createdAt: string;
		ownerLiveness: "live" | "dead" | "unknown";
		/** Held by a lane of this same coordinator (so a local worker, not a foreign process). */
		local: boolean;
	}[];
	/** Dead-owner reservations this acquire released before retrying. */
	reapedReservationIds: readonly string[];
}

export type WorkerWriteReservationAdmission =
	| { kind: "granted" }
	| { kind: "blocked"; detail?: WorkerWriteReservationBlockDetail }
	| { kind: "denied"; reasonCode: "write_reservation_scope_invalid" | "write_reservation_unavailable" };

/** One line a queue view can print for a blocked write admission. */
export function formatWorkerWriteReservationBlock(detail: WorkerWriteReservationBlockDetail): string {
	if (detail.reasonCode === "reservation_capacity_reached") {
		return `${detail.repositoryRoot} reservation store is full`;
	}
	if (detail.reasonCode === "attempt_reservation_conflict") {
		return `${detail.repositoryRoot} already reserved by this attempt with a different scope`;
	}
	const conflict = detail.conflicts[0];
	const others = detail.conflicts.length > 1 ? ` and ${detail.conflicts.length - 1} more` : "";
	const reaped =
		detail.reapedReservationIds.length > 0
			? `; released ${detail.reapedReservationIds.length} dead-owner reservation${detail.reapedReservationIds.length === 1 ? "" : "s"}`
			: "";
	if (!conflict) return `${detail.repositoryRoot} overlapping scope${reaped}`;
	const holder = conflict.local ? "a worker of this session" : `session ${conflict.parentSessionId}`;
	return `${detail.repositoryRoot} held by ${holder} (${conflict.ownerId}, owner ${conflict.ownerLiveness}, since ${conflict.createdAt})${others}${reaped}`;
}

export interface WorkerWriteReservationWaitYield {
	laneId: string;
	lease: WorkerWriteReservationLease;
}

export interface WorkerWriteReservationResourceSnapshot {
	readonly heldLeases: readonly Readonly<WorkerWriteReservationLease>[];
	readonly watchCount: number;
	readonly availabilityListenerCount: number;
	readonly availabilityDeliveryDepth: number;
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

/** Backoff bounds for retrying a durable release that failed (lock contention, store I/O). */
const PENDING_RELEASE_RETRY_BASE_MS = 1_000;
const PENDING_RELEASE_RETRY_MAX_MS = 30_000;
/**
 * A retained-release retry owns its own backoff, so it takes the store lock in one attempt: the sync
 * lock's default contention budget blocks the event loop between attempts (seconds per record).
 */
const PENDING_RELEASE_LOCK_OPTIONS: Readonly<AtomicFileLockOptions> = Object.freeze({ retries: 0 });

/** A workspace as a message names it: its repository root once, and its execution root as well when it is another path. */
function workspaceLabel(workspace: WorkerWriteReservationWorkspace): string {
	return [...new Set([workspace.repositoryRoot, workspace.executionRoot])].join(" and ");
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
	private readonly availabilityListeners = new Set<() => void>();
	/** Keyed by the workspace identity; the workspace is kept beside its watcher so a teardown failure can name it readably. */
	private readonly watchDisposes = new Map<
		string,
		{ readonly workspace: WorkerWriteReservationWorkspace; readonly dispose: () => void }
	>();
	private availabilityDeliveryDepth = 0;
	/**
	 * Durable records this owner no longer holds for a lane but could not release yet, keyed by
	 * reservation id. They still fence other writers, so they stay visible as held leases until released.
	 */
	private readonly pendingReleases = new Map<string, WorkerWriteReservationLease>();
	private pendingReleaseTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingReleaseFailures = 0;
	private disposed = false;

	constructor(options: WorkerWriteReservationCoordinatorOptions) {
		this.options = options;
		this.store = new WorkerWriteReservationStore({ agentDir: options.agentDir });
	}

	/** Clone this owner's actual leases, including retained releases; never discover, acquire, release or attach a watcher. */
	getResourceSnapshot(): WorkerWriteReservationResourceSnapshot {
		return {
			heldLeases: [...this.leases.values(), ...this.pendingReleases.values()].map((lease) => ({
				...lease,
				writeScopes: [...lease.writeScopes],
			})),
			watchCount: this.watchDisposes.size,
			availabilityListenerCount: this.availabilityListeners.size,
			availabilityDeliveryDepth: this.availabilityDeliveryDepth,
		};
	}

	acquire(
		laneId: string,
		attempt: Pick<AttemptRuntimeState, "attemptId" | "lease">,
		plan: Pick<WorkerExecutionPlan, "writeEnabled" | "writePaths"> &
			Partial<Pick<WorkerExecutionPlan, "cwd" | "writeReservationPaths">>,
	): WorkerWriteReservationAdmission {
		// Only explicit scopes fence other lanes; a plan's bare cwd default reserves nothing.
		const reservedPaths = plan.writeReservationPaths ?? plan.writePaths;
		if (!plan.writeEnabled || reservedPaths.length === 0) {
			this.blockedByLocalLaneIds.delete(laneId);
			return { kind: "granted" };
		}
		const fencingToken = (attempt.lease?.fencingToken ?? 0) + 1;
		const current = this.leases.get(laneId);
		if (current && current.attemptId === attempt.attemptId && current.fencingToken === fencingToken) {
			this.blockedByLocalLaneIds.delete(laneId);
			return { kind: "granted" };
		}
		const planCwd = plan.cwd ?? this.options.getCwd();
		const machineRoots = workerMachinePathRoots(planCwd);
		const requestedScopes = new Set(reservedPaths.map(canonicalPathScopeIdentity));
		const machineWide =
			requestedScopes.size === machineRoots.length &&
			machineRoots.every((root) => requestedScopes.has(canonicalPathScopeIdentity(root)));
		// Machine authority is intentionally unreserved: reserving `/` (or every Windows volume)
		// serializes the swarm globally. Explicit workspace profiles retain collision fencing.
		if (machineWide) {
			this.blockedByLocalLaneIds.delete(laneId);
			return { kind: "granted" };
		}
		const workspace = this.workspace(planCwd);
		return this.acquireLease(
			laneId,
			{
				parentSessionId: this.options.getParentSessionId(),
				ownerId: this.options.ownerId,
				taskId: laneId,
				attemptId: attempt.attemptId,
				fencingToken,
				access: "write",
				workspace,
				writeScopes: reservedPaths,
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

	/** Event-driven wakeup when a write reservation is released; same signal that drains the queue. */
	subscribeAvailability(listener: () => void): () => void {
		this.availabilityListeners.add(listener);
		for (const workspace of this.hostWorkspaces()) this.ensureWatch(workspace);
		return () => {
			this.availabilityListeners.delete(listener);
		};
	}

	/** True only while the current release generation is giving every waiter first restoration access. */
	isDeliveringAvailability(): boolean {
		return this.availabilityDeliveryDepth > 0;
	}

	/** Release one exact live caller lane while its model turn is blocked inside a worker wait. */
	yieldForWait(
		laneId: string,
		expectedAttemptId: string,
		expectedFencingToken: number,
	): WorkerWriteReservationWaitYield | undefined {
		if (!this.leases.has(laneId)) return undefined;
		const held = this.releaseOwnedLease(laneId, expectedAttemptId, expectedFencingToken, "yield")?.held;
		if (!held) return undefined;
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
		this.releaseOwnedLease(laneId, expectedAttemptId, expectedFencingToken, "best_effort");
	}

	/**
	 * Release the lease of a lane whose run has physically stopped. The exact fence must match, and a
	 * superseded fence still throws. A store failure moves the exact durable record from the lane to the
	 * retained-release owner, which keeps it fencing other writers and retries it on its backoff alarm.
	 * Returns that store failure, if any, so a strict shutdown can still report it.
	 */
	releaseRequired(laneId: string, expectedAttemptId: string, expectedFencingToken: number): unknown {
		return this.releaseOwnedLease(laneId, expectedAttemptId, expectedFencingToken, "settled")?.failure;
	}

	/**
	 * `yield` keeps the lease on the lane when the store fails: the lane is still live and resumes under
	 * it. `best_effort` and `settled` lanes no longer hold it, so the exact record moves to the retained
	 * release owner. Only `best_effort` ignores a fence mismatch or a `stale_fence` result.
	 */
	private releaseOwnedLease(
		laneId: string,
		expectedAttemptId: string | undefined,
		expectedFencingToken: number | undefined,
		mode: "best_effort" | "yield" | "settled",
	): { held: WorkerWriteReservationLease; failure?: unknown } | undefined {
		const held = this.leases.get(laneId);
		if (!held) {
			this.blockedByLocalLaneIds.delete(laneId);
			return;
		}
		const strict = mode !== "best_effort";
		if (
			this.hasFenceMismatch(laneId, expectedAttemptId ?? held.attemptId, expectedFencingToken ?? held.fencingToken)
		) {
			if (strict)
				throw new Error(`Worker ${laneId} cannot release a write reservation owned by another attempt fence.`);
			return;
		}
		let result: WorkerWriteReservationReleaseResult;
		try {
			result = this.store.release(held);
		} catch (error) {
			if (mode === "yield") throw error;
			this.warnBestEffort(
				`Failed to release worker write reservation ${laneId}; retrying: ${error instanceof Error ? error.message : String(error)}`,
			);
			// The lane no longer holds the lease, but its durable record still names this live process,
			// which no reaper may release. Keep the exact record until a release is proven.
			this.forgetLease(laneId, held);
			this.retainPendingRelease(held);
			return { held, failure: error };
		}
		if (strict && result.kind !== "released" && result.kind !== "not_found") {
			throw new Error(`Worker ${laneId} required write reservation release encountered ${result.kind}.`);
		}
		this.forgetLease(laneId, held);
		return { held };
	}

	/**
	 * A failed best-effort release owns its retry. Waiters latched on that reservation are skipped by the
	 * scheduler until an availability event, and only a successful release produces one, so the retained
	 * record carries its own bounded backoff alarm beside the opportunistic retries on coordinator signals.
	 */
	private retainPendingRelease(lease: WorkerWriteReservationLease): void {
		// A retained set that starts from empty starts its backoff from the base delay, however the
		// previous set emptied (a full retry pass, a repository-scoped retry, or a re-adopting grant).
		if (this.pendingReleases.size === 0) this.pendingReleaseFailures = 0;
		this.pendingReleases.set(lease.reservationId, lease);
		if (this.disposed) return;
		try {
			// A successful retry wakes waiters through this workspace's availability listener.
			this.ensureWatch({
				repositoryRoot: lease.repositoryRoot,
				executionRoot: lease.executionRoot,
				...(lease.isolatedWorktreeId ? { isolatedWorktreeId: lease.isolatedWorktreeId } : {}),
			});
		} catch (error) {
			this.warnBestEffort(
				`Worker write reservation watch for retained release ${lease.reservationId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.armPendingReleaseRetry();
	}

	private armPendingReleaseRetry(): void {
		if (this.disposed || this.pendingReleaseTimer || this.pendingReleases.size === 0) return;
		const delayMs = Math.min(
			PENDING_RELEASE_RETRY_MAX_MS,
			PENDING_RELEASE_RETRY_BASE_MS * 2 ** Math.min(this.pendingReleaseFailures, 16),
		);
		const timer = setTimeout(() => {
			this.pendingReleaseTimer = undefined;
			this.retryPendingReleases({ warn: true });
		}, delayMs);
		timer.unref?.();
		this.pendingReleaseTimer = timer;
	}

	/**
	 * Retry every retained release once; a failure keeps its exact record and re-arms the backoff alarm.
	 * Only the alarm warns: opportunistic retries on admission signals would repeat the same diagnostic.
	 * Every retry with a later retry behind it takes the store lock in one attempt; only the final
	 * shutdown pass (`lastChance`) waits out lock contention, since nothing retries after it.
	 */
	private retryPendingReleases(options: { warn: boolean; repositoryRoot?: string; lastChance?: boolean }): unknown[] {
		const errors: unknown[] = [];
		if (this.pendingReleases.size === 0) return errors;
		const repository =
			options.repositoryRoot === undefined ? undefined : canonicalPathScopeIdentity(options.repositoryRoot);
		let failed = false;
		for (const [reservationId, lease] of [...this.pendingReleases]) {
			if (repository !== undefined && canonicalPathScopeIdentity(lease.repositoryRoot) !== repository) continue;
			try {
				// Any result settles the record: `released` removed it, `not_found` means it is gone, and
				// `stale_fence` means a newer fence of the same task owns that scope now, not this record.
				this.store.release(lease, options.lastChance ? undefined : PENDING_RELEASE_LOCK_OPTIONS);
				this.pendingReleases.delete(reservationId);
			} catch (error) {
				failed = true;
				errors.push(error);
				if (options.warn) {
					this.warnBestEffort(
						`Retained worker write reservation ${reservationId} release failed again: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
		// Only a pass over every retained record says whether the backoff may reset.
		if (failed) this.pendingReleaseFailures += 1;
		else if (repository === undefined) this.pendingReleaseFailures = 0;
		if (this.pendingReleases.size === 0 && this.pendingReleaseTimer) {
			clearTimeout(this.pendingReleaseTimer);
			this.pendingReleaseTimer = undefined;
		}
		this.armPendingReleaseRetry();
		return errors;
	}

	recoverProvenStale(): void {
		this.retryPendingReleases({ warn: false });
		for (const workspace of this.recoveryWorkspaces()) {
			const discovered = this.store.recover({ workspace, evidence: [] });
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
			for (const outcome of this.store.recover({ workspace, evidence }).outcomes) {
				if (outcome.kind !== "stale") continue;
				const released = this.store.release(outcome.lease);
				if (released.kind !== "released" && released.kind !== "not_found") {
					this.options.warn(
						`Stale worker write reservation ${outcome.reservationId} was not released (${released.kind}).`,
					);
				}
			}
		}
	}

	dispose(): void {
		this.disposeOwnedResources(false);
	}

	/** Close every observer independently; physically unresolved lanes retain their fenced leases. */
	disposeRequired(canRelease: (laneId: string) => boolean = () => true): void {
		this.disposeOwnedResources(true, canRelease);
	}

	private disposeOwnedResources(required: boolean, canRelease?: (laneId: string) => boolean): void {
		this.disposed = true;
		if (this.pendingReleaseTimer) {
			clearTimeout(this.pendingReleaseTimer);
			this.pendingReleaseTimer = undefined;
		}
		// Retained releases belong to no lane any more, so no physical hold can make them unreleasable.
		const pendingErrors = this.retryPendingReleases({ warn: !required, lastChance: true });
		const errors: unknown[] = required ? pendingErrors : [];
		const watchers = [...this.watchDisposes];
		this.watchDisposes.clear();
		this.availabilityListeners.clear();
		for (const [key, watch] of watchers) {
			try {
				watch.dispose();
			} catch (error) {
				if (required) {
					errors.push(error);
					this.watchDisposes.set(key, watch);
				}
				this.warnBestEffort(
					`Worker write reservation watcher ${workspaceLabel(watch.workspace)} teardown failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const [laneId, lease] of [...this.leases]) {
			try {
				if (canRelease && !canRelease(laneId)) continue;
				if (required) {
					// A store failure retains the exact record (reported below); its cause is reported too.
					const failure = this.releaseRequired(laneId, lease.attemptId, lease.fencingToken);
					if (failure !== undefined) errors.push(failure);
				} else this.release(laneId);
			} catch (error) {
				errors.push(error);
			}
		}
		if (!required || this.leases.size === 0) this.blockedByLocalLaneIds.clear();
		if (required && (this.leases.size > 0 || this.pendingReleases.size > 0)) {
			const retained = [...this.leases.values(), ...this.pendingReleases.values()].map(
				(lease) => `${lease.taskId}:${lease.attemptId}:${lease.fencingToken}`,
			);
			errors.push(
				new Error(
					`Worker shutdown retained ${retained.length} exact write reservation lease(s): ${retained.slice(0, 8).join(", ")}.`,
				),
			);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Worker write reservation shutdown failed.");
	}

	private workspace(cwd = this.options.getCwd()) {
		const resolved = resolveWorkerWorkspacePath(this.options.getCwd(), cwd);
		return { repositoryRoot: resolved, executionRoot: resolved };
	}

	private hostWorkspaces() {
		const candidates = [this.options.getCwd(), ...workerMachinePathRoots(this.options.getCwd())];
		const unique = new Map(
			candidates.map((candidate) => [canonicalPathScopeIdentity(candidate), this.workspace(candidate)]),
		);
		return [...unique.values()];
	}

	/**
	 * Host workspaces plus every workspace that has a durable reservation file. A reservation fences
	 * the repository it names, not the cwd of the process that inspects it, so recovery limited to the
	 * cwd leaves a dead owner's fence on any other repository standing forever.
	 */
	private recoveryWorkspaces(): WorkerWriteReservationWorkspace[] {
		const unique = new Map<string, WorkerWriteReservationWorkspace>();
		const key = (workspace: WorkerWriteReservationWorkspace) =>
			`${canonicalPathScopeIdentity(workspace.repositoryRoot)}\0${canonicalPathScopeIdentity(workspace.executionRoot)}\0${workspace.isolatedWorktreeId ?? ""}`;
		for (const workspace of this.hostWorkspaces()) unique.set(key(workspace), workspace);
		let persisted: WorkerWriteReservationWorkspace[] = [];
		try {
			persisted = this.store.listWorkspaces();
		} catch (error) {
			this.options.warn(
				`Worker write reservation directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const workspace of persisted) {
			const id = key(workspace);
			if (!unique.has(id)) unique.set(id, workspace);
		}
		return [...unique.values()];
	}

	/**
	 * Release every conflicting reservation whose owner process is provably dead. `unknown` liveness
	 * (malformed owner, probe failure) never releases: recovery must not steal a live worker's fence.
	 */
	private reapDeadOwners(
		conflicts: readonly WorkerWriteReservationConflict[],
		options: { release: boolean } = { release: true },
	): {
		reaped: string[];
		remaining: WorkerWriteReservationBlockDetail["conflicts"];
	} {
		const reaped: string[] = [];
		const remaining: WorkerWriteReservationBlockDetail["conflicts"][number][] = [];
		const localReservationIds = new Set([
			...[...this.leases.values()].map((lease) => lease.reservationId),
			...this.pendingReleases.keys(),
		]);
		for (const conflict of conflicts) {
			const local = localReservationIds.has(conflict.lease.reservationId);
			const ownerLiveness = local
				? "live"
				: localWorkerProcessOwnerLiveness(
						conflict.lease.ownerId,
						this.options.isProcessAlive ?? isLocalProcessAlive,
					);
			if (ownerLiveness === "dead" && options.release) {
				let released: ReturnType<WorkerWriteReservationStore["release"]>["kind"] | "error" = "error";
				try {
					released = this.store.release(conflict.lease).kind;
				} catch (error) {
					this.options.warn(
						`Stale worker write reservation ${conflict.lease.reservationId} release failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (released === "released" || released === "not_found") {
					reaped.push(conflict.lease.reservationId);
					this.options.warn(
						`Released stale worker write reservation ${conflict.lease.reservationId} on ${conflict.lease.repositoryRoot}: owner ${conflict.lease.ownerId} (session ${conflict.lease.parentSessionId}, created ${conflict.createdAt}) is dead.`,
					);
					continue;
				}
			}
			remaining.push({
				reservationId: conflict.lease.reservationId,
				ownerId: conflict.lease.ownerId,
				parentSessionId: conflict.lease.parentSessionId,
				createdAt: conflict.createdAt,
				ownerLiveness,
				local,
			});
		}
		return { reaped, remaining };
	}

	private acquireLease(
		laneId: string,
		request: WorkerWriteReservationRequest,
		warningPrefix: string,
		classifyScopeFailure: boolean,
	): WorkerWriteReservationAdmission {
		// A retained release on this repository may be the very record this admission would conflict with.
		// The retry takes the same store lock this acquire takes; other repositories are left to the alarm.
		this.retryPendingReleases({ warn: false, repositoryRoot: request.workspace.repositoryRoot });
		try {
			let result = this.store.acquire(request);
			let reapedReservationIds: string[] = [];
			let remainingConflicts: WorkerWriteReservationBlockDetail["conflicts"] = [];
			if (result.kind === "blocked" && result.conflicts && result.conflicts.length > 0) {
				// A fence left by a process that no longer exists must not block a live writer. Prove the
				// owner dead, release exactly those records, and re-run the same admission once.
				const { reaped, remaining } = this.reapDeadOwners(result.conflicts);
				reapedReservationIds = reaped;
				remainingConflicts = remaining;
				if (reaped.length > 0) {
					result = this.store.acquire(request);
					if (result.kind === "blocked") {
						remainingConflicts = this.reapDeadOwners(result.conflicts ?? [], { release: false }).remaining;
					}
				}
			}
			if (result.kind === "blocked") {
				this.recordLocalBlockers(laneId, result.conflictingReservationIds);
				this.ensureWatch(request.workspace);
				return {
					kind: "blocked",
					detail: {
						reasonCode: result.reasonCode,
						repositoryRoot: request.workspace.repositoryRoot,
						conflicts: remainingConflicts,
						reapedReservationIds,
					},
				};
			}
			if (!result.lease) {
				this.blockedByLocalLaneIds.delete(laneId);
				this.ensureWatch(request.workspace);
				return { kind: "blocked" };
			}
			this.blockedByLocalLaneIds.delete(laneId);
			// The store grants a same-attempt, same-fence request the record it already holds. If that record
			// was waiting for a retained release, the lane owns it again and the retry must not release it.
			this.pendingReleases.delete(result.lease.reservationId);
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

	private emitAvailability(): void {
		// A completed wait still owns its logical attempt and must restore the reservation it yielded
		// before ordinary queued work can consume the release. Snapshot this wake generation so a
		// callback cannot extend the synchronous dispatch by registering more waiters.
		this.availabilityDeliveryDepth += 1;
		try {
			for (const listener of [...this.availabilityListeners]) {
				try {
					listener();
				} catch {
					// Waiters re-enter restore; a throwing observer cannot consume the release event.
				}
			}
		} finally {
			this.availabilityDeliveryDepth -= 1;
		}
		try {
			this.options.drainQueuedWorkers();
		} catch (error) {
			this.warnBestEffort(
				`Worker write reservation queue drain failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private warnBestEffort(message: string): void {
		try {
			this.options.warn(message);
		} catch {
			// Diagnostics cannot interrupt teardown or consume a reservation-availability event.
		}
	}

	private ensureWatch(workspace = this.workspace()): void {
		const key = `${workspace.repositoryRoot}\0${workspace.executionRoot}`;
		if (this.watchDisposes.has(key)) return;
		this.watchDisposes.set(key, {
			workspace,
			dispose: this.store.watchAvailability(workspace, () => this.emitAvailability()),
		});
	}
}
