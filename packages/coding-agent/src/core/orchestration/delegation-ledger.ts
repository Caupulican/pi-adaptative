import { deriveWorkerTaskLabel } from "../delegation/worker-task-label.ts";
import { hasGoalAcceptanceOverride } from "../goals/goal-acceptance.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type {
	HarnessCapability,
	OrchestrationDispatchRequest,
	RiskBudget,
	WorkerExecutionContract,
	WorkerRole,
} from "./contracts.ts";
import { OrchestrationEventStore } from "./event-store.ts";
import { type AttemptRuntimeState, DurableTaskRuntime, DurableTaskRuntimeError } from "./task-runtime.ts";
import { goalObjectiveId, projectGoalAcceptanceEvidence, projectGoalObjective } from "./work-state-projection.ts";

export interface DelegationLedgerOptions {
	agentDir: string;
	sessionId: string;
	now?: () => number;
}

export interface PrepareDelegationInput {
	laneId: string;
	instructions: string;
	executionContract: WorkerExecutionContract;
	requiredCapabilities: readonly HarnessCapability[];
	goal?: GoalState;
	verificationOfTaskId?: string;
}

export interface PrepareManagedDelegationInput {
	laneId: string;
	dispatchSequence: number;
	instructions: string;
	profileId: string;
	provider: string;
	authorizationId: string;
	role: WorkerRole;
	riskBudget: RiskBudget;
	goal?: GoalState;
	goalId?: string;
	worktreeLaneKey?: string;
}

export interface StartedDelegationAttempt {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
	expiresAt: string;
}

function activeAttempt(attempt: AttemptRuntimeState): boolean {
	return attempt.status === "queued" || attempt.status === "leased" || attempt.status === "running";
}

/**
 * Durable adapter for in-process delegated completions. It records the dispatch before execution,
 * fences interrupted completions on restart, and returns queued work for event-driven re-dispatch.
 * It deliberately does not pretend an isolated completion has a resumable model transcript.
 */
export class DelegationOrchestrationLedger {
	readonly runtime: DurableTaskRuntime;
	private readonly sessionId: string;

	constructor(options: DelegationLedgerOptions) {
		this.sessionId = options.sessionId;
		this.runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir: options.agentDir, sessionId: options.sessionId }),
			now: options.now,
		});
	}

	prepare(input: PrepareDelegationInput): AttemptRuntimeState {
		const profile = input.executionContract.worker.profile;
		return this.prepareNormalized({
			laneId: input.laneId,
			instructions: input.instructions,
			profileId: profile.profileId,
			role: profile.role,
			requiredCapabilities: input.requiredCapabilities,
			riskBudget: profile.budget,
			executionContract: input.executionContract,
			...(input.goal ? { goal: input.goal } : {}),
			...(input.verificationOfTaskId ? { verificationOfTaskId: input.verificationOfTaskId } : {}),
		});
	}

	prepareManaged(input: PrepareManagedDelegationInput): AttemptRuntimeState {
		if (!Number.isSafeInteger(input.dispatchSequence) || input.dispatchSequence < 1) {
			throw new DurableTaskRuntimeError("Managed dispatch sequence must be a positive integer.");
		}
		const taskId = `${input.laneId}:turn:${input.dispatchSequence}`;
		return this.prepareNormalized({
			laneId: taskId,
			instructions: input.instructions,
			profileId: input.profileId,
			role: input.role,
			requiredCapabilities: [],
			riskBudget: input.riskBudget,
			...(input.goal ? { goal: input.goal } : {}),
			...(input.goalId ? { goalId: input.goalId } : {}),
			dispatchMetadata: {
				executionKind: "managed-process",
				logicalLaneId: input.laneId,
				dispatchSequence: input.dispatchSequence,
				provider: input.provider,
				authorizationId: input.authorizationId,
				...(input.worktreeLaneKey ? { worktreeLaneKey: input.worktreeLaneKey } : {}),
			},
		});
	}

	private prepareNormalized(input: {
		laneId: string;
		instructions: string;
		profileId: string;
		role: WorkerRole;
		requiredCapabilities: readonly HarnessCapability[];
		riskBudget: RiskBudget;
		goal?: GoalState;
		goalId?: string;
		verificationOfTaskId?: string;
		executionContract?: WorkerExecutionContract;
		dispatchMetadata?: Pick<
			OrchestrationDispatchRequest,
			"executionKind" | "logicalLaneId" | "dispatchSequence" | "provider" | "authorizationId" | "worktreeLaneKey"
		>;
	}): AttemptRuntimeState {
		let snapshot = this.runtime.getSnapshot();
		const existingVerificationSubject = input.verificationOfTaskId
			? snapshot.tasks[input.verificationOfTaskId]
			: undefined;
		if (input.verificationOfTaskId && !existingVerificationSubject) {
			throw new DurableTaskRuntimeError(`Unknown verification subject '${input.verificationOfTaskId}'.`);
		}
		const projectedGoal = input.goal ? projectGoalObjective(input.goal) : undefined;
		const objectiveId =
			existingVerificationSubject?.task.objectiveId ??
			projectedGoal?.objectiveId ??
			(input.goalId ? goalObjectiveId(input.goalId) : `session:${this.sessionId}`);
		if (input.goal && objectiveId === projectedGoal?.objectiveId) {
			this.synchronizeGoalState(input.goal);
			snapshot = this.runtime.getSnapshot();
		} else if (!snapshot.objectives[objectiveId]) {
			this.runtime.createObjective({
				objectiveId,
				title: input.goalId ? `Goal ${input.goalId}` : `Session ${this.sessionId}`,
				description: input.goalId ? "Externally managed goal work" : "Session-scoped delegated work",
			});
			snapshot = this.runtime.getSnapshot();
		}

		if (!snapshot.tasks[input.laneId]) {
			const verificationSubject = input.verificationOfTaskId
				? snapshot.tasks[input.verificationOfTaskId]
				: undefined;
			this.runtime.createTask({
				taskId: input.laneId,
				objectiveId,
				title: deriveWorkerTaskLabel(input.instructions, `Delegated ${input.role} work`),
				description: input.instructions,
				role: input.role,
				requiredCapabilities: input.requiredCapabilities,
				riskBudget: input.riskBudget,
				...(input.verificationOfTaskId
					? {
							verificationOfTaskId: input.verificationOfTaskId,
							acceptanceCriterionIds: verificationSubject?.task.acceptanceCriterionIds ?? [],
						}
					: {}),
			});
			snapshot = this.runtime.getSnapshot();
		}

		const task = snapshot.tasks[input.laneId];
		if (!task) throw new DurableTaskRuntimeError(`Failed to create task '${input.laneId}'.`);
		const existing = [...task.attemptIds]
			.reverse()
			.map((attemptId) => snapshot.attempts[attemptId])
			.find((attempt): attempt is AttemptRuntimeState => attempt !== undefined && activeAttempt(attempt));
		if (existing) return existing;

		return this.runtime.queueAttempt(input.laneId, {
			taskId: input.laneId,
			profileId: input.profileId,
			instructions: input.instructions,
			resourcePointerIds: [],
			...(input.executionContract ? { executionContract: input.executionContract } : {}),
			...input.dispatchMetadata,
		});
	}

	synchronizeGoalState(goal: GoalState): void {
		const objective = projectGoalObjective(goal);
		this.runtime.ensureObjective(objective);
		for (const evidence of projectGoalAcceptanceEvidence(goal)) {
			this.runtime.recordObjectiveEvidence(objective.objectiveId, evidence);
		}
		const status = this.runtime.getSnapshot().objectives[goalObjectiveId(goal.goalId)]?.objective.status;
		switch (goal.status) {
			case "active":
				if (status === "paused") this.runtime.resumeObjective(objective.objectiveId);
				break;
			case "blocked":
				if (status === "active") this.runtime.pauseObjective(objective.objectiveId);
				break;
			case "cancelled":
				if (status !== "cancelled") this.runtime.cancelObjective(objective.objectiveId);
				break;
			case "completed":
				if (status !== "completed") {
					this.runtime.completeObjectiveFromOwner(objective.objectiveId, hasGoalAcceptanceOverride(goal));
				}
				break;
		}
	}

	start(attemptId: string, leaseTtlMs: number, ownerId = `in-process:${this.sessionId}`): StartedDelegationAttempt {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		const task = snapshot.tasks[attempt.taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
		const lease = this.runtime.leaseAttempt(attemptId, ownerId, leaseTtlMs);
		this.runtime.startAttempt(attemptId, lease.leaseId, lease.fencingToken);
		return {
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			expiresAt: lease.expiresAt,
		};
	}

	cancel(attemptId: string, reasonCode: string): void {
		this.runtime.cancelAttempt(attemptId, reasonCode);
	}

	/** Fence interrupted isolated completions and queue one replacement attempt per task. */
	recoverQueuedDispatches(): AttemptRuntimeState[] {
		this.runtime.recoverInterruptedUnboundAttempts((attempt) => attempt.dispatch.executionKind !== "managed-process");
		let snapshot = this.runtime.getSnapshot();
		for (const task of Object.values(snapshot.tasks)) {
			const attempts = task.attemptIds.map((attemptId) => snapshot.attempts[attemptId]).filter(Boolean);
			if (attempts.some((attempt) => attempt && activeAttempt(attempt))) continue;
			const interrupted = [...attempts].reverse().find((attempt) => attempt?.status === "expired");
			if (!interrupted || task.task.status !== "ready") continue;
			const maxAttempts = task.task.riskBudget.maxAttempts;
			if (maxAttempts !== undefined && task.attemptIds.length >= maxAttempts) {
				this.runtime.failTask(task.task.taskId, "attempt_budget_exhausted");
				snapshot = this.runtime.getSnapshot();
				continue;
			}
			this.runtime.queueAttempt(task.task.taskId, interrupted.dispatch);
			snapshot = this.runtime.getSnapshot();
		}
		return Object.values(snapshot.attempts).filter(
			(attempt) => attempt.status === "queued" && attempt.dispatch.executionKind !== "managed-process",
		);
	}
}
