import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkerDelegationTaskContext } from "../delegation/worker-delegation-request.ts";
import { deriveWorkerTaskLabel } from "../delegation/worker-task-label.ts";
import { hasGoalAcceptanceOverride } from "../goals/goal-acceptance.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { latestAgentAttemptByDurableOrder } from "./attempt-ordering.ts";
import type {
	AttemptUsageSnapshot,
	HarnessCapability,
	OrchestrationDispatchRequest,
	RiskBudget,
	WorkerExecutionContract,
	WorkerRole,
} from "./contracts.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "./contracts.ts";
import { OrchestrationEventStore } from "./event-store.ts";
import {
	type AttemptRuntimeState,
	DurableTaskRuntime,
	DurableTaskRuntimeError,
	validateTaskDependencyIds,
} from "./task-runtime.ts";
import { goalObjectiveId, projectGoalAcceptanceEvidence, projectGoalObjective } from "./work-state-projection.ts";
import {
	normalizeWorkerContextForkReference,
	type WorkerContextForkReference,
} from "./worker-context-fork-reference.ts";

export interface DelegationLedgerOptions {
	agentDir: string;
	sessionId: string;
	now?: () => number;
	store?: OrchestrationEventStore;
}

export interface PrepareDelegationInput {
	laneId: string;
	instructions: string;
	parentAgentId?: string;
	executionContract: WorkerExecutionContract;
	requiredCapabilities: readonly HarnessCapability[];
	goal?: GoalState;
	verificationOfTaskId?: string;
	taskContext?: WorkerDelegationTaskContext;
	birthContextForkReference?: WorkerContextForkReference;
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

export interface PrepareAgentTurnInput {
	agentId: string;
	instructions: string;
	controlMessageId?: string;
	dependsOnTaskIds?: readonly string[];
}

function activeAttempt(attempt: AttemptRuntimeState): boolean {
	return attempt.status === "queued" || attempt.status === "leased" || attempt.status === "running";
}

function mailboxTurnTaskId(agentId: string, controlMessageId: string): string {
	return `mailbox-turn-${createHash("sha256")
		.update("pi-worker-agent-mailbox-turn-v1")
		.update("\0")
		.update(agentId)
		.update("\0")
		.update(controlMessageId)
		.digest("hex")}`;
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
			store:
				options.store ?? new OrchestrationEventStore({ agentDir: options.agentDir, sessionId: options.sessionId }),
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
			...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
			executionContract: input.executionContract,
			...(input.goal ? { goal: input.goal } : {}),
			...(input.verificationOfTaskId ? { verificationOfTaskId: input.verificationOfTaskId } : {}),
			...(input.taskContext ? { taskContext: input.taskContext } : {}),
			dispatchMetadata: {
				logicalLaneId: input.laneId,
				...(input.birthContextForkReference ? { birthContextForkReference: input.birthContextForkReference } : {}),
			},
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

	/**
	 * Queue one new turn for an existing logical agent. The agent identity and its immutable
	 * execution contract are inherited from the last bound turn. Each distinct control message owns
	 * one deterministic task/attempt identity; exact retries adopt it instead of minting new work.
	 */
	prepareAgentTurn(input: PrepareAgentTurnInput): AttemptRuntimeState {
		const agentId = input.agentId.trim();
		const instructions = input.instructions.trim();
		const controlMessageId = input.controlMessageId?.trim();
		if (!agentId) throw new DurableTaskRuntimeError("Logical worker agent id is required.");
		if (!instructions) throw new DurableTaskRuntimeError("Worker follow-up instructions are required.");
		if (
			input.controlMessageId !== undefined &&
			(!controlMessageId || controlMessageId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH)
		) {
			throw new DurableTaskRuntimeError("Worker control message id is invalid.");
		}
		const snapshot = this.runtime.getSnapshot();
		const agent = snapshot.agents[agentId];
		if (!agent) throw new DurableTaskRuntimeError(`Unknown logical worker agent '${agentId}'.`);
		const agentAttempts = Object.values(snapshot.attempts).filter(
			(attempt) => attempt.agentId === agentId || attempt.dispatch.logicalLaneId === agentId,
		);
		const sequence = agentAttempts.length + 1;
		const taskId = controlMessageId ? mailboxTurnTaskId(agentId, controlMessageId) : `${agentId}:turn:${sequence}`;
		const existingTask = snapshot.tasks[taskId]?.task;
		const prior = latestAgentAttemptByDurableOrder(snapshot, agent.agentId);
		const contract = prior?.dispatch.executionContract;
		if (!prior || !contract) {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' has no immutable execution contract.`);
		}
		const priorTask = snapshot.tasks[prior.taskId]?.task;
		if (!priorTask) throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' has no prior durable task.`);
		const dependencyTaskIds = validateTaskDependencyIds(
			snapshot.tasks,
			existingTask?.objectiveId ?? priorTask.objectiveId,
			input.dependsOnTaskIds,
		);
		if (existingTask && controlMessageId) {
			if (
				existingTask.description !== instructions ||
				existingTask.role !== agent.role ||
				existingTask.dependsOn.length !== dependencyTaskIds.length ||
				existingTask.dependsOn.some((dependencyId, index) => dependencyId !== dependencyTaskIds[index])
			) {
				throw new DurableTaskRuntimeError(
					`Worker control message '${controlMessageId}' has conflicting task identity.`,
				);
			}
			const existingAttempts = (snapshot.tasks[taskId]?.attemptIds ?? []).map(
				(attemptId) => snapshot.attempts[attemptId],
			);
			for (const attempt of existingAttempts) {
				if (
					!attempt ||
					attempt.dispatch.logicalLaneId !== agentId ||
					attempt.dispatch.controlMessageId !== controlMessageId ||
					attempt.dispatch.instructions !== instructions
				) {
					throw new DurableTaskRuntimeError(
						`Worker control message '${controlMessageId}' has conflicting dispatch evidence.`,
					);
				}
			}
			const existingAttempt = existingAttempts.at(-1);
			if (existingAttempt) return existingAttempt;
		}
		if (agent.status !== "registered") {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' is not idle.`);
		}
		if (existingTask && !controlMessageId) {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' already has turn ${sequence}.`);
		}
		return this.prepareNormalized({
			laneId: taskId,
			instructions,
			profileId: contract.worker.profile.profileId,
			role: agent.role,
			requiredCapabilities: contract.worker.authority.capabilities,
			riskBudget: contract.worker.profile.budget,
			...(priorTask.objectiveId.startsWith("goal:") ? { goalId: priorTask.objectiveId.slice("goal:".length) } : {}),
			taskContext: {
				requirementIds: prior.dispatch.requirementIds ?? [],
				dependsOnTaskIds: dependencyTaskIds,
				acceptanceCriterionIds: priorTask.acceptanceCriterionIds,
				resourcePointerIds: prior.dispatch.resourcePointerIds,
			},
			executionContract: contract,
			dispatchMetadata: {
				logicalLaneId: agentId,
				dispatchSequence: sequence,
				...(controlMessageId ? { controlMessageId } : {}),
				...(prior.dispatch.birthContextForkReference
					? { birthContextForkReference: prior.dispatch.birthContextForkReference }
					: {}),
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
		parentAgentId?: string;
		goal?: GoalState;
		goalId?: string;
		verificationOfTaskId?: string;
		taskContext?: WorkerDelegationTaskContext;
		executionContract?: WorkerExecutionContract;
		dispatchMetadata?: Pick<
			OrchestrationDispatchRequest,
			| "executionKind"
			| "logicalLaneId"
			| "dispatchSequence"
			| "controlMessageId"
			| "provider"
			| "authorizationId"
			| "worktreeLaneKey"
			| "birthContextForkReference"
		>;
	}): AttemptRuntimeState {
		let birthContextForkReference: WorkerContextForkReference | undefined;
		try {
			birthContextForkReference =
				input.dispatchMetadata?.birthContextForkReference === undefined
					? undefined
					: normalizeWorkerContextForkReference(input.dispatchMetadata.birthContextForkReference);
		} catch (error) {
			throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
		}
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
		const dependencyTaskIds = validateTaskDependencyIds(
			snapshot.tasks,
			objectiveId,
			input.taskContext?.dependsOnTaskIds,
		);
		const existingTask = snapshot.tasks[input.laneId]?.task;
		if (
			existingTask &&
			(existingTask.objectiveId !== objectiveId ||
				existingTask.description !== input.instructions ||
				existingTask.role !== input.role ||
				existingTask.dependsOn.length !== dependencyTaskIds.length ||
				existingTask.dependsOn.some((dependencyId, index) => dependencyId !== dependencyTaskIds[index]))
		) {
			throw new DurableTaskRuntimeError(`Task '${input.laneId}' has conflicting durable dispatch identity.`);
		}
		const taskStateBeforeWrites = snapshot.tasks[input.laneId];
		const activeAttemptBeforeWrites = taskStateBeforeWrites?.attemptIds
			.map((attemptId) => snapshot.attempts[attemptId])
			.find((attempt): attempt is AttemptRuntimeState => attempt !== undefined && activeAttempt(attempt));
		for (const attemptId of taskStateBeforeWrites?.attemptIds ?? []) {
			const durableReference = snapshot.attempts[attemptId]?.dispatch.birthContextForkReference;
			if (!isDeepStrictEqual(durableReference, birthContextForkReference)) {
				throw new DurableTaskRuntimeError(`Task '${input.laneId}' has a conflicting birth context fork reference.`);
			}
		}
		const projectedEvidence =
			input.goal && objectiveId === projectedGoal?.objectiveId ? projectGoalAcceptanceEvidence(input.goal) : [];
		if (projectedGoal) this.runtime.assertObjectiveSynchronizationHeadroom(projectedGoal, projectedEvidence);
		this.runtime.assertProjectionHeadroom({
			objectives: snapshot.objectives[objectiveId] ? 0 : 1,
			tasks: taskStateBeforeWrites ? 0 : 1,
			attempts: activeAttemptBeforeWrites ? 0 : 1,
		});
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

		const verificationSubject = input.verificationOfTaskId ? snapshot.tasks[input.verificationOfTaskId] : undefined;
		const taskInput = {
			taskId: input.laneId,
			objectiveId,
			title: deriveWorkerTaskLabel(input.instructions, `Delegated ${input.role} work`),
			description: input.instructions,
			role: input.role,
			dependsOn: dependencyTaskIds,
			requiredCapabilities: input.requiredCapabilities,
			acceptanceCriterionIds: input.taskContext?.acceptanceCriterionIds ?? [],
			riskBudget: input.riskBudget,
			...(input.verificationOfTaskId
				? {
						verificationOfTaskId: input.verificationOfTaskId,
						acceptanceCriterionIds: verificationSubject?.task.acceptanceCriterionIds ?? [],
					}
				: {}),
		} as const;
		const dispatch = {
			taskId: input.laneId,
			profileId: input.profileId,
			instructions: input.instructions,
			resourcePointerIds: input.taskContext?.resourcePointerIds ?? [],
			...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
			requirementIds: input.taskContext?.requirementIds ?? [],
			...(input.executionContract ? { executionContract: input.executionContract } : {}),
			...input.dispatchMetadata,
			...(birthContextForkReference ? { birthContextForkReference } : {}),
		} as const;
		if (
			existingTask &&
			(existingTask.title !== taskInput.title ||
				existingTask.verificationOfTaskId !== taskInput.verificationOfTaskId ||
				!isDeepStrictEqual(existingTask.requiredCapabilities, [...new Set(taskInput.requiredCapabilities)]) ||
				!isDeepStrictEqual(existingTask.acceptanceCriterionIds, [...new Set(taskInput.acceptanceCriterionIds)]) ||
				!isDeepStrictEqual(existingTask.riskBudget, taskInput.riskBudget))
		) {
			throw new DurableTaskRuntimeError(`Task '${input.laneId}' has conflicting durable task identity.`);
		}
		if (activeAttemptBeforeWrites && !isDeepStrictEqual(activeAttemptBeforeWrites.dispatch, dispatch)) {
			throw new DurableTaskRuntimeError(`Task '${input.laneId}' has conflicting durable dispatch identity.`);
		}
		if (!snapshot.tasks[input.laneId]) {
			return this.runtime.prepareTaskAttempt(
				{
					...taskInput,
				},
				dispatch,
			).attempt;
		}

		const task = snapshot.tasks[input.laneId];
		if (!task) throw new DurableTaskRuntimeError(`Failed to create task '${input.laneId}'.`);
		if (activeAttemptBeforeWrites) return activeAttemptBeforeWrites;

		return this.runtime.queueAttempt(input.laneId, dispatch);
	}

	synchronizeGoalState(goal: GoalState): void {
		const objective = projectGoalObjective(goal);
		const evidence = projectGoalAcceptanceEvidence(goal);
		this.runtime.assertObjectiveSynchronizationHeadroom(objective, evidence);
		this.runtime.ensureObjective(objective);
		for (const item of evidence) {
			this.runtime.recordObjectiveEvidence(objective.objectiveId, item);
		}
		const status = this.runtime.getSnapshot().objectives[goalObjectiveId(goal.goalId)]?.objective.status;
		switch (goal.status) {
			case "active":
				if (status === "paused") this.runtime.resumeObjective(objective.objectiveId);
				break;
			case "paused":
			case "blocked":
			case "usage_limited":
			case "budget_limited":
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

	start(
		attemptId: string,
		leaseTtlMs: number,
		ownerId = `in-process:${this.sessionId}`,
		agentId?: string,
	): StartedDelegationAttempt {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		const task = snapshot.tasks[attempt.taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
		const lease = this.runtime.leaseAttempt(attemptId, ownerId, leaseTtlMs, agentId);
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

	/** Latest fenced cumulative usage, if this attempt has crossed a durable checkpoint boundary. */
	getAttemptUsage(attemptId: string): AttemptUsageSnapshot | undefined {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		for (const checkpointId of [...attempt.checkpointIds].reverse()) {
			const usage = snapshot.checkpoints[checkpointId]?.usage;
			if (usage) return structuredClone(usage);
		}
		return undefined;
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
