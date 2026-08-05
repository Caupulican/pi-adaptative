import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { sameAgentResumeIdentity } from "../orchestration/agent-resume.ts";
import type {
	AgentBindingContract,
	AgentResumeContext,
	AttemptUsageSnapshot,
	ExecutionGrant,
	WorkerExecutionContract,
	WorkerResultContract,
	WorkerRole,
} from "../orchestration/contracts.ts";
import {
	DelegationOrchestrationLedger,
	type PrepareDelegationInput,
	type PrepareManagedDelegationInput,
	type StartedDelegationAttempt,
} from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { verifierWorkerExecutionContract } from "../orchestration/worker-execution-contract.ts";
import {
	ACTIVE_WORKER_ATTEMPT_STATUSES,
	isManagedWorkerAttempt,
	projectManagedWorkerLaneRecords,
	projectWorkerLaneRecord,
	selectedManagedWorkerAttempt,
	selectedWorkerAttempt,
} from "./worker-lane-projection.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";

export type PendingVerificationRecovery =
	| {
			action: "dispatch";
			subjectTaskId: string;
			implementationProfileId: string;
			summary: string;
			artifactUris: readonly string[];
			verifierExecutionContract?: WorkerExecutionContract;
	  }
	| {
			action: "reconcile";
			subjectTaskId: string;
			verifierTaskId: string;
			verifierAttemptId: string;
			verdict: "accepted" | "rejected" | "inconclusive";
			reasonCode: string;
	  };

/**
 * Sole owner of in-process worker lifecycle state. LaneRecord is a compatibility/UI projection;
 * all transitions are committed through DurableTaskRuntime before the projection is returned.
 */
export class WorkerLifecycle {
	readonly ledger: DelegationOrchestrationLedger;
	private nextLaneNumber: number;
	private readonly isProcessAlive: (pid: number) => boolean;

	constructor(options: { agentDir: string; sessionId: string; isProcessAlive?: (pid: number) => boolean }) {
		this.ledger = new DelegationOrchestrationLedger(options);
		this.isProcessAlive = options.isProcessAlive ?? isLocalProcessAlive;
		const snapshot = this.ledger.runtime.getSnapshot();
		const highest = Object.keys(snapshot.tasks).reduce((current, taskId) => {
			const suffix = /^worker-(\d+)$/.exec(taskId)?.[1];
			return suffix ? Math.max(current, Number(suffix)) : current;
		}, 0);
		this.nextLaneNumber = highest + 1;
	}

	prepare(
		input: Omit<PrepareDelegationInput, "laneId">,
		laneId?: string,
	): {
		record: LaneRecord;
		attempt: AttemptRuntimeState;
	} {
		let selectedLaneId = laneId;
		if (!selectedLaneId) {
			const snapshot = this.ledger.runtime.getSnapshot();
			while (snapshot.tasks[`worker-${this.nextLaneNumber}`]) this.nextLaneNumber += 1;
			selectedLaneId = `worker-${this.nextLaneNumber++}`;
		}
		const attempt = this.ledger.prepare({ ...input, laneId: selectedLaneId });
		const record = this.getRecord(selectedLaneId);
		if (!record) throw new Error(`Durable worker '${selectedLaneId}' was not projected after enqueue.`);
		return { record, attempt };
	}

	/** Queue the next distinct task/attempt for an idle logical agent. */
	prepareAgentTurn(input: { agentId: string; instructions: string }): {
		record: LaneRecord;
		attempt: AttemptRuntimeState;
	} {
		const attempt = this.ledger.prepareAgentTurn(input);
		const record = this.getRecord(attempt.taskId);
		if (!record) throw new Error(`Logical worker '${input.agentId}' turn was not projected after enqueue.`);
		return { record, attempt };
	}

	ensureAgent(input: {
		agentId: string;
		parentAgentId?: string;
		role: WorkerRole;
		resumeContext: AgentResumeContext;
	}): AgentBindingContract {
		const agentId = input.agentId.trim();
		const existing = this.ledger.runtime.getSnapshot().agents[agentId];
		if (!existing) return this.ledger.runtime.registerAgent(input);
		if (
			existing.role !== input.role ||
			existing.parentAgentId !== input.parentAgentId ||
			!sameAgentResumeIdentity(existing.resumeContext, input.resumeContext)
		) {
			throw new Error(`Agent '${agentId}' was re-registered with conflicting identity.`);
		}
		return existing;
	}

	prepareManaged(
		input: PrepareManagedDelegationInput & {
			leaseTtlMs: number;
			compileGrant(target: { objectiveId: string; taskId: string; attemptId: string }): ExecutionGrant;
		},
	): {
		record: LaneRecord;
		attempt: AttemptRuntimeState;
		handle: StartedDelegationAttempt;
		created: boolean;
	} {
		const before = selectedManagedWorkerAttempt(this.ledger.runtime.getSnapshot(), input.laneId);
		if (before?.dispatch.dispatchSequence === input.dispatchSequence) {
			if (
				before.dispatch.provider !== "legacy" &&
				(before.dispatch.instructions !== input.instructions ||
					before.dispatch.profileId !== input.profileId ||
					before.dispatch.provider !== input.provider ||
					before.dispatch.worktreeLaneKey !== input.worktreeLaneKey ||
					before.dispatch.authorizationId !== input.authorizationId)
			) {
				throw new Error(
					`Managed worker '${input.laneId}' turn ${input.dispatchSequence} was re-reported with conflicting dispatch data.`,
				);
			}
			if (before.status === "queued") {
				const handle = this.startPreparedManagedAttempt(before, input.leaseTtlMs, input.compileGrant);
				const record = this.getManagedRecord(input.laneId);
				if (!record) throw new Error(`Managed worker '${input.laneId}' was not projected.`);
				return {
					record,
					attempt: this.ledger.runtime.getSnapshot().attempts[before.attemptId]!,
					handle,
					created: true,
				};
			}
			const record = this.getManagedRecord(input.laneId);
			if (!record) throw new Error(`Managed worker '${input.laneId}' was not projected.`);
			if (!before.lease) throw new Error(`Managed worker '${input.laneId}' has no durable lease.`);
			return {
				record,
				attempt: before,
				handle: this.startedHandle(before),
				created: false,
			};
		}
		if (before && ACTIVE_WORKER_ATTEMPT_STATUSES.has(before.status)) {
			throw new Error(
				`Managed worker '${input.laneId}' cannot dispatch turn ${input.dispatchSequence} while turn ${before.dispatch.dispatchSequence ?? 1} is active.`,
			);
		}
		const attempt = this.ledger.prepareManaged(input);
		const handle = this.startPreparedManagedAttempt(attempt, input.leaseTtlMs, input.compileGrant);
		const record = this.getManagedRecord(input.laneId);
		if (!record) throw new Error(`Managed worker '${input.laneId}' was not projected after dispatch.`);
		return { record, attempt: this.ledger.runtime.getSnapshot().attempts[attempt.attemptId]!, handle, created: true };
	}

	synchronizeGoalState(goal: GoalState): LaneRecord[] {
		const before = new Map(this.getRecords().map((record) => [record.laneId, record.status]));
		this.ledger.synchronizeGoalState(goal);
		return this.getRecords().filter((record) => {
			const previous = before.get(record.laneId);
			return (
				(previous === "queued" || previous === "running") &&
				record.status !== "queued" &&
				record.status !== "running"
			);
		});
	}

	start(laneId: string, leaseTtlMs: number): StartedDelegationAttempt {
		const attempt = this.requireActiveAttempt(laneId);
		return this.ledger.start(attempt.attemptId, leaseTtlMs);
	}

	startAgent(laneId: string, agentId: string, leaseTtlMs: number, ownerId = agentId): StartedDelegationAttempt {
		const attempt = this.requireActiveAttempt(laneId);
		return this.ledger.start(attempt.attemptId, leaseTtlMs, ownerId, agentId);
	}

	checkpoint(
		laneId: string,
		input: {
			summary: string;
			artifactIds?: readonly string[];
			evidenceIds?: readonly string[];
			usage?: AttemptUsageSnapshot;
		},
	) {
		const attempt = this.requireActiveAttempt(laneId);
		if (!attempt.lease) throw new Error(`Durable worker '${laneId}' has no live lease.`);
		return this.ledger.runtime.checkpointAttempt({
			attemptId: attempt.attemptId,
			leaseId: attempt.lease.leaseId,
			fencingToken: attempt.lease.fencingToken,
			summary: input.summary,
			...(input.artifactIds ? { artifactIds: input.artifactIds } : {}),
			...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
			...(input.usage ? { usage: input.usage } : {}),
		});
	}

	/**
	 * Suspend only attempts whose exact controller owner is known (explicit shutdown) or whose
	 * recorded local owner PID is proven gone (recovery). A live/unknown owner is never stolen.
	 */
	suspendBoundInProcessAttemptsForRestart(ownerId?: string): string[] {
		const suspended: string[] = [];
		for (const attempt of Object.values(this.ledger.runtime.getSnapshot().attempts)) {
			if (
				(attempt.status !== "leased" && attempt.status !== "running") ||
				!attempt.agentId ||
				attempt.dispatch.executionKind === "managed-process" ||
				!attempt.lease
			) {
				continue;
			}
			const ownsAttempt =
				ownerId !== undefined
					? attempt.lease.ownerId === ownerId
					: isLocalWorkerProcessOwnerProvenDead(attempt.lease.ownerId, this.isProcessAlive);
			if (!ownsAttempt) continue;
			this.suspendBoundAttempt({
				laneId: attempt.taskId,
				ownerId: attempt.lease.ownerId,
				leaseId: attempt.lease.leaseId,
				fencingToken: attempt.lease.fencingToken,
				reasonCode:
					ownerId === undefined ? "agent_process_recovered_after_owner_exit" : "agent_process_interrupted",
			});
			suspended.push(attempt.attemptId);
		}
		return suspended;
	}

	/**
	 * Applies an explicitly authorized restart suspension. The caller must identify both the logical
	 * lane and the current lease fence; process liveness policy is intentionally kept by this class.
	 */
	suspendBoundAttempt(args: {
		laneId: string;
		ownerId: string;
		leaseId: string;
		fencingToken: number;
		reasonCode: string;
	}): void {
		const attempt = this.getActiveAttempt(args.laneId);
		if (!attempt || !attempt.agentId || !attempt.lease) {
			throw new Error(`Durable worker '${args.laneId}' has no live agent-bound attempt for suspension.`);
		}
		this.ledger.runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: args.ownerId,
			leaseId: args.leaseId,
			fencingToken: args.fencingToken,
			reasonCode: args.reasonCode,
		});
	}

	resumeAgent(laneId: string, agentId: string, leaseTtlMs: number, ownerId = agentId): StartedDelegationAttempt {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt) throw new Error(`Durable worker '${laneId}' has no resumable attempt.`);
		this.ledger.runtime.requestAgentResume(agentId);
		const lease = this.ledger.runtime.resumeAttempt(attempt.attemptId, agentId, leaseTtlMs, ownerId);
		return this.startedHandle(this.ledger.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken));
	}

	suspendAgent(laneId: string, agentId: string, ownerId: string, reasonCode = "agent_interrupted"): void {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt || attempt.agentId !== agentId || !attempt.lease) {
			throw new Error(`Logical worker '${agentId}' has no live attempt for interruption.`);
		}
		this.suspendBoundAttempt({
			laneId,
			ownerId,
			leaseId: attempt.lease.leaseId,
			fencingToken: attempt.lease.fencingToken,
			reasonCode,
		});
	}

	bindGrant(attemptId: string, grant: ExecutionGrant): void {
		this.ledger.runtime.bindAttemptGrant(attemptId, grant);
	}

	finish(result: WorkerResultContract, options: { notify?: boolean } = {}): LaneRecord {
		this.ledger.runtime.finishAttempt(result);
		const record = this.getRecord(result.taskId);
		if (!record) throw new Error(`Durable worker '${result.taskId}' was not projected after completion.`);
		if (options.notify !== false) this.enqueueTerminalNotification(record);
		return record;
	}

	reconcileVerification(args: {
		subjectTaskId: string;
		verifierTaskId: string;
		verifierAttemptId: string;
		verdict: "accepted" | "rejected" | "inconclusive";
		reasonCode: string;
	}): LaneRecord {
		this.ledger.runtime.finishVerification({
			taskId: args.subjectTaskId,
			verifierTaskId: args.verifierTaskId,
			verifierAttemptId: args.verifierAttemptId,
			verdict: args.verdict,
			reasonCode: args.reasonCode,
		});
		const subject = this.getRecord(args.subjectTaskId);
		if (!subject) throw new Error(`Verified worker '${args.subjectTaskId}' was not projected.`);
		this.enqueueTerminalNotification(subject);
		return subject;
	}

	cancel(laneId: string, reasonCode: string): LaneRecord | undefined {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt) return this.getRecord(laneId);
		this.ledger.cancel(attempt.attemptId, reasonCode);
		const record = this.getRecord(laneId);
		if (record) this.enqueueTerminalNotification(record);
		return record;
	}

	recoverQueued(): Array<{
		record: LaneRecord;
		attempt: AttemptRuntimeState;
		verificationOfTaskId?: string;
	}> {
		return this.ledger.recoverQueuedDispatches().flatMap((attempt) => {
			if (isManagedWorkerAttempt(attempt)) return [];
			const record = this.getRecord(attempt.taskId);
			const task = this.ledger.runtime.getSnapshot().tasks[attempt.taskId]?.task;
			return record
				? [
						{
							record,
							attempt,
							...(task?.verificationOfTaskId ? { verificationOfTaskId: task.verificationOfTaskId } : {}),
						},
					]
				: [];
		});
	}

	/** Close crash windows between implementation completion, verifier dispatch, and reconciliation. */
	getPendingVerificationRecoveries(): PendingVerificationRecovery[] {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.values(snapshot.tasks).flatMap<PendingVerificationRecovery>((subject) => {
			if (subject.verification) return [];
			const implementationAttempt = selectedWorkerAttempt(snapshot, subject.task.taskId);
			if (implementationAttempt?.result?.nextAction !== "independent_verification_required") return [];
			const verifier = Object.values(snapshot.tasks)
				.filter((candidate) => candidate.task.verificationOfTaskId === subject.task.taskId)
				.sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt))
				.at(-1);
			if (!verifier) {
				const verifierExecutionContract = implementationAttempt.dispatch.executionContract
					? verifierWorkerExecutionContract(implementationAttempt.dispatch.executionContract)
					: undefined;
				return [
					{
						action: "dispatch" as const,
						subjectTaskId: subject.task.taskId,
						implementationProfileId: implementationAttempt.dispatch.profileId,
						summary: implementationAttempt.result.summary,
						artifactUris: implementationAttempt.result.artifacts.map((artifact) => artifact.uri),
						...(verifierExecutionContract ? { verifierExecutionContract } : {}),
					},
				];
			}
			const verifierAttempt = selectedWorkerAttempt(snapshot, verifier.task.taskId);
			if (!verifierAttempt || ACTIVE_WORKER_ATTEMPT_STATUSES.has(verifierAttempt.status)) return [];
			const review = verifierAttempt.result?.evidence.find(
				(evidence) => evidence.kind === "review" && evidence.metadata?.subjectTaskId === subject.task.taskId,
			);
			const verdictValue = review?.metadata?.verdict;
			const verdict =
				review?.trusted && (verdictValue === "accepted" || verdictValue === "rejected")
					? verdictValue
					: "inconclusive";
			const reasonCodesValue = review?.metadata?.reasonCodes;
			const reasonCodes = Array.isArray(reasonCodesValue)
				? reasonCodesValue.filter((reasonCode): reasonCode is string => typeof reasonCode === "string")
				: [];
			return [
				{
					action: "reconcile" as const,
					subjectTaskId: subject.task.taskId,
					verifierTaskId: verifier.task.taskId,
					verifierAttemptId: verifierAttempt.attemptId,
					verdict,
					reasonCode:
						verdict === "accepted"
							? "independent_verification_accepted"
							: verdict === "rejected"
								? `independent_verification_rejected:${reasonCodes.join(",") || "unspecified"}`
								: `independent_verification_inconclusive:${verifierAttempt.reasonCode ?? verifierAttempt.result?.reasonCode ?? "interrupted"}`,
				},
			];
		});
	}

	getTask(taskId: string): TaskRuntimeProjection["tasks"][string] | undefined {
		return this.ledger.runtime.getSnapshot().tasks[taskId];
	}

	getAgent(agentId: string): AgentBindingContract | undefined {
		return this.ledger.runtime.getSnapshot().agents[agentId];
	}

	getLatestAgentAttempt(agentId: string): AttemptRuntimeState | undefined {
		return Object.values(this.ledger.runtime.getSnapshot().attempts)
			.filter((attempt) => attempt.agentId === agentId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.at(-1);
	}

	getTaskRuntimeSnapshot(): TaskRuntimeProjection {
		return this.ledger.runtime.getSnapshot();
	}

	getRecords(): LaneRecord[] {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).flatMap((taskId) => {
			const attempt = selectedWorkerAttempt(snapshot, taskId);
			if (!attempt || isManagedWorkerAttempt(attempt)) return [];
			const record = projectWorkerLaneRecord(snapshot, taskId);
			return record ? [record] : [];
		});
	}

	getManagedRecords(): LaneRecord[] {
		return projectManagedWorkerLaneRecords(this.ledger.runtime.getSnapshot());
	}

	getAllRecords(): LaneRecord[] {
		return [...this.getRecords(), ...this.getManagedRecords()];
	}

	getRecord(laneId: string): LaneRecord | undefined {
		return projectWorkerLaneRecord(this.ledger.runtime.getSnapshot(), laneId);
	}

	getManagedRecord(laneId: string): LaneRecord | undefined {
		return this.getManagedRecords().find((record) => record.laneId === laneId);
	}

	getManagedAttempt(laneId: string): AttemptRuntimeState | undefined {
		return selectedManagedWorkerAttempt(this.ledger.runtime.getSnapshot(), laneId);
	}

	getManagedHandle(laneId: string): StartedDelegationAttempt | undefined {
		const attempt = this.getManagedAttempt(laneId);
		return attempt?.lease ? this.startedHandle(attempt) : undefined;
	}

	getActiveAttempt(laneId: string): AttemptRuntimeState | undefined {
		return selectedWorkerAttempt(this.ledger.runtime.getSnapshot(), laneId);
	}

	getAttemptUsage(laneId: string): AttemptUsageSnapshot | undefined {
		const attempt = this.getActiveAttempt(laneId);
		return attempt ? this.ledger.getAttemptUsage(attempt.attemptId) : undefined;
	}

	getRunningCount(profileId?: string): number {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).filter((taskId) => {
			const attempt = selectedWorkerAttempt(snapshot, taskId);
			return (
				attempt?.status === "running" &&
				!isManagedWorkerAttempt(attempt) &&
				(!profileId || attempt.dispatch.profileId === profileId)
			);
		}).length;
	}

	getPendingTerminalNotifications(): Array<{ notificationId: string; record: LaneRecord }> {
		this.ensureTerminalNotifications();
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.values(snapshot.notifications).flatMap((notification) => {
			if (notification.status !== "pending" || !notification.attemptId) return [];
			const attempt = snapshot.attempts[notification.attemptId];
			if (!attempt) return [];
			const record = projectWorkerLaneRecord(snapshot, attempt.taskId);
			if (!record || record.status === "queued" || record.status === "running") return [];
			return [{ notificationId: notification.notificationId, record }];
		});
	}

	getTerminalNotification(
		laneId: string,
	): { notificationId: string; status: "pending" | "delivered"; record: LaneRecord } | undefined {
		const record = this.getRecord(laneId) ?? this.getManagedRecord(laneId);
		if (!record || record.status === "queued" || record.status === "running") return undefined;
		this.enqueueTerminalNotification(record);
		const attempt = this.getActiveAttempt(laneId) ?? this.getManagedAttempt(laneId);
		if (!attempt) return undefined;
		const notificationId = `worker-terminal:${attempt.attemptId}`;
		const notification = this.ledger.runtime.getSnapshot().notifications[notificationId];
		return notification ? { notificationId, status: notification.status, record } : undefined;
	}

	markNotificationsDelivered(notificationIds: readonly string[]): void {
		for (const notificationId of notificationIds) this.ledger.runtime.markNotificationDelivered(notificationId);
	}

	private ensureTerminalNotifications(): void {
		const snapshot = this.ledger.runtime.getSnapshot();
		for (const taskId of Object.keys(snapshot.tasks)) {
			const record = projectWorkerLaneRecord(snapshot, taskId);
			if (record && record.status !== "queued" && record.status !== "running") {
				this.enqueueTerminalNotification(record);
			}
		}
	}

	private enqueueTerminalNotification(record: LaneRecord): void {
		const attempt = this.getActiveAttempt(record.laneId) ?? this.getManagedAttempt(record.laneId);
		if (!attempt || ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status)) return;
		const snapshot = this.ledger.runtime.getSnapshot();
		const task = snapshot.tasks[attempt.taskId];
		if (!task) return;
		if (attempt.result?.nextAction === "independent_verification_required" && !task.verification) return;
		this.ledger.runtime.enqueueNotification({
			notificationId: `worker-terminal:${attempt.attemptId}`,
			objectiveId: task.task.objectiveId,
			attemptId: attempt.attemptId,
			message: `Worker ${record.laneId} reached ${record.status}.`,
		});
	}

	private requireActiveAttempt(laneId: string): AttemptRuntimeState {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt || !ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status)) {
			throw new Error(`Durable worker '${laneId}' has no active attempt.`);
		}
		return attempt;
	}

	private startedHandle(attempt: AttemptRuntimeState): StartedDelegationAttempt {
		const task = this.ledger.runtime.getSnapshot().tasks[attempt.taskId];
		if (!task || !attempt.lease) throw new Error(`Attempt '${attempt.attemptId}' has no started handle.`);
		return {
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId: attempt.attemptId,
			leaseId: attempt.lease.leaseId,
			fencingToken: attempt.lease.fencingToken,
			expiresAt: attempt.lease.expiresAt,
		};
	}

	private startPreparedManagedAttempt(
		attempt: AttemptRuntimeState,
		leaseTtlMs: number,
		compileGrant: (target: { objectiveId: string; taskId: string; attemptId: string }) => ExecutionGrant,
	): StartedDelegationAttempt {
		const task = this.ledger.runtime.getSnapshot().tasks[attempt.taskId];
		if (!task) throw new Error(`Managed attempt '${attempt.attemptId}' has no durable task.`);
		const grant = compileGrant({
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId: attempt.attemptId,
		});
		this.bindGrant(attempt.attemptId, grant);
		return this.ledger.start(
			attempt.attemptId,
			leaseTtlMs,
			`managed:${attempt.dispatch.logicalLaneId ?? attempt.taskId}`,
		);
	}
}
