import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../autonomy/contracts.ts";
import {
	type AgentBindingContract,
	type ApprovalRequestContract,
	type ApprovalResolutionContract,
	type AttemptCheckpoint,
	type AttemptLease,
	type AttemptStatus,
	type EvidenceContract,
	type ExecutionGrant,
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_APPROVALS,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_CHECKPOINTS,
	MAX_ORCHESTRATION_NOTIFICATIONS,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_TASKS,
	type ObjectiveContract,
	type ObjectiveStatus,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
	type OrchestrationTaskStatus,
	type TaskContract,
	WORKER_RESULT_STATUSES,
	type WorkerResultContract,
} from "./contracts.ts";
import {
	agentFromPayload,
	approvalFromPayload,
	approvalResolutionFromPayload,
	assertReferencedAcceptanceCriteriaRetained,
	checkpointFromPayload,
	dispatchFromValue,
	dispatchIdentifier,
	evidenceFromPayload,
	executionGrantFromValue,
	leaseFromPayload,
	number,
	objectiveFromPayload,
	resultFromPayload,
	retryStateFromValue,
	string,
	taskFromPayload,
	validateTaskContractForState,
} from "./task-runtime-codecs.ts";
import {
	assertIdentifierListHasCapacity,
	assertObjectiveEvidenceHasCapacity,
	assertProjectionWithinLimits,
	assertRecordHasCapacity,
	cacheProjectionSerializedBytes,
	emptyProjection,
	ProjectionByteTracker,
} from "./task-runtime-projection.ts";
import {
	type ApprovalRuntimeState,
	type AttemptDispatchReadiness,
	type AttemptRuntimeState,
	DurableTaskRuntimeError,
	missingTrustedCriteria,
	type NotificationRuntimeState,
	type ObjectiveRuntimeState,
	type TaskRuntimeProjection,
	type TaskRuntimeState,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";

function updateObjectiveStatus(
	state: TaskRuntimeProjection,
	objectiveId: string,
	status: ObjectiveStatus,
	at: string,
): void {
	const current = state.objectives[objectiveId];
	if (!current) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	(state.objectives as Record<string, ObjectiveRuntimeState>)[objectiveId] = {
		...current,
		objective: { ...current.objective, status, updatedAt: at },
	};
}

function assertObjectiveUpdateTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	objective: ObjectiveContract,
): ObjectiveRuntimeState {
	const current = state.objectives[aggregateId];
	if (!current) throw new DurableTaskRuntimeError(`Unknown objective '${aggregateId}'.`);
	if (objective.objectiveId !== aggregateId) {
		throw new DurableTaskRuntimeError(`Updated objective id '${objective.objectiveId}' does not match aggregate.`);
	}
	if (
		objective.schemaVersion !== current.objective.schemaVersion ||
		objective.status !== current.objective.status ||
		objective.createdAt !== current.objective.createdAt
	) {
		throw new DurableTaskRuntimeError(`Updated objective '${aggregateId}' changed immutable lifecycle fields.`);
	}
	assertReferencedAcceptanceCriteriaRetained(state.tasks, current, objective.acceptanceCriteria);
	return current;
}

function assertObjectiveEvidenceTransition(
	state: TaskRuntimeProjection,
	objectiveId: string,
	evidence: EvidenceContract,
): ObjectiveRuntimeState {
	const objective = state.objectives[objectiveId];
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	if (
		evidence.criterionId &&
		!objective.objective.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)
	) {
		throw new DurableTaskRuntimeError(
			`Objective evidence references unknown acceptance criterion '${evidence.criterionId}'.`,
		);
	}
	return objective;
}

export type ObjectiveCompletionPolicy = "task_evidence" | "owner_evidence" | "owner_override";

function assertObjectiveCompletion(
	state: TaskRuntimeProjection,
	objectiveId: string,
	policy: ObjectiveCompletionPolicy,
): void {
	const objective = state.objectives[objectiveId];
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	if (policy === "owner_override") return;
	if (policy === "task_evidence") {
		const incomplete = objective.taskIds.filter((taskId) => state.tasks[taskId]?.task.status !== "completed");
		if (incomplete.length > 0) {
			throw new DurableTaskRuntimeError(
				`Objective '${objectiveId}' has incomplete tasks: ${incomplete.join(", ")}.`,
			);
		}
	}
	const evidence =
		policy === "owner_evidence"
			? objective.evidence
			: [
					...objective.evidence,
					...objective.taskIds.flatMap((taskId) =>
						(state.tasks[taskId]?.attemptIds ?? []).flatMap(
							(attemptId) => state.attempts[attemptId]?.result?.evidence ?? [],
						),
					),
				];
	const provenCriterionIds = new Set(
		evidence.flatMap((item) => (item.trusted && item.criterionId ? [item.criterionId] : [])),
	);
	const unproven = objective.objective.acceptanceCriteria
		.filter((criterion) => criterion.required && !provenCriterionIds.has(criterion.id))
		.map((criterion) => criterion.id);
	if (unproven.length > 0) {
		throw new DurableTaskRuntimeError(
			`Objective '${objectiveId}' lacks trusted ${policy === "owner_evidence" ? "owner " : ""}evidence for required criteria: ${unproven.join(", ")}.`,
		);
	}
}

export function assertObjectiveStatusTransition(
	state: TaskRuntimeProjection,
	objectiveId: string,
	target: ObjectiveStatus,
	completionPolicy?: ObjectiveCompletionPolicy,
): void {
	const objective = state.objectives[objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	const validSource =
		(target === "paused" && objective.status === "active") ||
		(target === "active" && objective.status === "paused") ||
		((target === "completed" || target === "cancelled") &&
			(objective.status === "active" || objective.status === "paused"));
	if (!validSource) {
		throw new DurableTaskRuntimeError(
			`Objective '${objectiveId}' cannot transition from '${objective.status}' to '${target}'.`,
		);
	}
	if (target === "completed") {
		if (!completionPolicy) throw new DurableTaskRuntimeError("Objective completion policy is required.");
		assertObjectiveCompletion(state, objectiveId, completionPolicy);
	}
}

const RETIREMENT_BLOCKING_ATTEMPT_STATUSES = new Set<AttemptStatus>(["queued", "leased", "running", "suspended"]);

function isAgentDescendant(
	agents: Readonly<Record<string, AgentBindingContract>>,
	candidate: AgentBindingContract,
	ancestorAgentId: string,
): boolean {
	let parentAgentId = candidate.parentAgentId;
	const visited = new Set<string>();
	while (parentAgentId) {
		if (parentAgentId === ancestorAgentId) return true;
		if (visited.has(parentAgentId)) {
			throw new DurableTaskRuntimeError(`Agent '${candidate.agentId}' lineage contains a cycle.`);
		}
		visited.add(parentAgentId);
		parentAgentId = agents[parentAgentId]?.parentAgentId;
	}
	return false;
}

/** One authoritative guard shared by command admission and durable event replay. */
export function assertAgentRetirementEligible(state: TaskRuntimeProjection, agentId: string): AgentBindingContract {
	const agent = state.agents[agentId];
	if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
	if (agent.status === "retired") return agent;
	if (agent.status !== "registered") {
		throw new DurableTaskRuntimeError(`Agent '${agentId}' cannot retire from '${agent.status}'.`);
	}
	if (agent.activeAttemptId) {
		throw new DurableTaskRuntimeError(`Agent '${agentId}' still owns active attempt '${agent.activeAttemptId}'.`);
	}
	const blockingAttempt = Object.values(state.attempts).find(
		(attempt) =>
			(attempt.agentId === agentId || attempt.dispatch.logicalLaneId === agentId) &&
			RETIREMENT_BLOCKING_ATTEMPT_STATUSES.has(attempt.status),
	);
	if (blockingAttempt) {
		throw new DurableTaskRuntimeError(
			`Agent '${agentId}' owns active '${blockingAttempt.status}' attempt '${blockingAttempt.attemptId}'.`,
		);
	}
	const liveDescendant = Object.values(state.agents).find(
		(candidate) =>
			candidate.status !== "retired" &&
			candidate.agentId !== agentId &&
			isAgentDescendant(state.agents, candidate, agentId),
	);
	if (liveDescendant) {
		throw new DurableTaskRuntimeError(`Agent '${agentId}' has non-retired descendant '${liveDescendant.agentId}'.`);
	}
	return agent;
}

export function assertAgentNotRetired(agent: AgentBindingContract, transition: string): void {
	if (agent.status === "retired") {
		throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' is retired and cannot ${transition}.`);
	}
}

function withoutAttemptRetry(attempt: AttemptRuntimeState): AttemptRuntimeState {
	const next = { ...attempt };
	delete next.retry;
	return next;
}

function cancelOpenObjectiveWork(
	state: TaskRuntimeProjection,
	objectiveId: string,
	at: string,
	reasonCode: string,
): void {
	const objective = state.objectives[objectiveId];
	const tasks = state.tasks as Record<string, TaskRuntimeState>;
	const attempts = state.attempts as Record<string, AttemptRuntimeState>;
	const agents = state.agents as Record<string, AgentBindingContract>;
	for (const taskId of objective?.taskIds ?? []) {
		const taskState = tasks[taskId];
		if (taskState && !["completed", "failed", "cancelled"].includes(taskState.task.status)) {
			tasks[taskId] = {
				...taskState,
				task: { ...taskState.task, status: "cancelled", updatedAt: at },
			};
		}
		for (const attemptId of taskState?.attemptIds ?? []) {
			const attempt = attempts[attemptId];
			if (attempt && !terminalAttemptStatus(attempt.status)) {
				attempts[attemptId] = withoutAttemptRetry({
					...attempt,
					status: "cancelled",
					reasonCode,
					updatedAt: at,
				});
				releaseAttemptAgent(agents, attempt, at);
			}
		}
	}
}

function taskStatusForResult(status: WorkerResultContract["status"]): OrchestrationTaskStatus {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return "blocked";
}

function releaseAttemptAgent(
	agents: Record<string, AgentBindingContract>,
	attempt: AttemptRuntimeState,
	at: string,
): void {
	if (!attempt.agentId) return;
	const agent = agents[attempt.agentId];
	if (!agent) return;
	assertAgentNotRetired(agent, "release an attempt");
	const next = { ...agent, status: "registered" as const, updatedAt: at };
	delete next.activeAttemptId;
	agents[attempt.agentId] = next;
}

function taskDependencyReadiness(
	state: TaskRuntimeProjection,
	task: TaskRuntimeState,
):
	| { state: "ready" }
	| { state: "waiting"; dependencyTaskIds: string[] }
	| {
			state: "blocked";
			dependencyTaskIds: string[];
			failedDependencyTaskIds: string[];
			cancelledDependencyTaskIds: string[];
	  } {
	const dependencyTaskIds: string[] = [];
	const failedDependencyTaskIds: string[] = [];
	const cancelledDependencyTaskIds: string[] = [];
	for (const dependencyId of task.task.dependsOn) {
		const dependency = state.tasks[dependencyId];
		if (!dependency || dependency.task.objectiveId !== task.task.objectiveId) {
			throw new DurableTaskRuntimeError(
				`Task dependency '${dependencyId}' is not in objective '${task.task.objectiveId}'.`,
			);
		}
		if (dependency.task.status === "completed" || dependency.task.status === "blocked") continue;
		dependencyTaskIds.push(dependencyId);
		if (dependency.task.status === "failed") failedDependencyTaskIds.push(dependencyId);
		if (dependency.task.status === "cancelled") cancelledDependencyTaskIds.push(dependencyId);
	}
	if (failedDependencyTaskIds.length > 0 || cancelledDependencyTaskIds.length > 0) {
		return {
			state: "blocked",
			dependencyTaskIds,
			failedDependencyTaskIds,
			cancelledDependencyTaskIds,
		};
	}
	return dependencyTaskIds.length > 0 ? { state: "waiting", dependencyTaskIds } : { state: "ready" };
}

export function attemptDispatchReadiness(
	state: TaskRuntimeProjection,
	attempt: AttemptRuntimeState,
): AttemptDispatchReadiness {
	if (attempt.status !== "queued" && attempt.status !== "suspended") {
		throw new DurableTaskRuntimeError(`Attempt '${attempt.attemptId}' is neither queued nor suspended.`);
	}
	const task = state.tasks[attempt.taskId];
	if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
	const objective = state.objectives[task.task.objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${task.task.objectiveId}'.`);
	if (objective.status === "paused") {
		return {
			state: "waiting",
			reasonCode: "objective_paused",
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			objectiveStatus: "paused",
		};
	}
	if (objective.status !== "active") {
		return {
			state: "blocked",
			reasonCode: "objective_inactive",
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			objectiveStatus: objective.status,
		};
	}
	const dependencyReadiness = taskDependencyReadiness(state, task);
	if (dependencyReadiness.state === "blocked") {
		return {
			state: "blocked",
			reasonCode: "dependency_failed_or_cancelled",
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			dependencyTaskIds: dependencyReadiness.dependencyTaskIds,
			failedDependencyTaskIds: dependencyReadiness.failedDependencyTaskIds,
			cancelledDependencyTaskIds: dependencyReadiness.cancelledDependencyTaskIds,
		};
	}
	if (dependencyReadiness.state === "waiting") {
		return {
			state: "waiting",
			reasonCode: "dependencies_incomplete",
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			dependencyTaskIds: dependencyReadiness.dependencyTaskIds,
		};
	}
	return { state: "ready", attemptId: attempt.attemptId, taskId: attempt.taskId };
}

function assertAttemptDispatchReady(state: TaskRuntimeProjection, attempt: AttemptRuntimeState): void {
	const readiness = attemptDispatchReadiness(state, attempt);
	if (readiness.state === "ready") {
		const task = state.tasks[attempt.taskId];
		if (task?.task.status !== "ready") {
			throw new DurableTaskRuntimeError(`Task '${attempt.taskId}' is not ready after its dependencies completed.`);
		}
		return;
	}
	if (readiness.reasonCode === "dependencies_incomplete") {
		throw new DurableTaskRuntimeError(
			`Attempt '${attempt.attemptId}' dependencies are incomplete: ${readiness.dependencyTaskIds.join(", ")}.`,
		);
	}
	if (readiness.reasonCode === "dependency_failed_or_cancelled") {
		throw new DurableTaskRuntimeError(
			`Attempt '${attempt.attemptId}' has failed or cancelled dependencies: ${readiness.dependencyTaskIds.join(", ")}.`,
		);
	}
	throw new DurableTaskRuntimeError(
		`Attempt '${attempt.attemptId}' objective is not active (${readiness.objectiveStatus}).`,
	);
}

export function activeTaskAttempt(
	state: TaskRuntimeProjection,
	task: TaskRuntimeState,
): AttemptRuntimeState | undefined {
	return task.attemptIds
		.map((attemptId) => state.attempts[attemptId])
		.find(
			(attempt): attempt is AttemptRuntimeState => attempt !== undefined && !terminalAttemptStatus(attempt.status),
		);
}

export function assertTaskAttemptBudgetForState(task: TaskRuntimeState, objective: ObjectiveContract): void {
	const attemptCeilings = [task.task.riskBudget.maxAttempts, objective.riskBudget.maxAttempts].filter(
		(value): value is number => value !== undefined,
	);
	const maxAttempts = attemptCeilings.length > 0 ? Math.min(...attemptCeilings) : undefined;
	if (maxAttempts !== undefined && task.attemptIds.length >= maxAttempts) {
		throw new DurableTaskRuntimeError(`Task '${task.task.taskId}' exhausted its ${maxAttempts} attempt budget.`);
	}
}

function refreshReadyTasks(state: TaskRuntimeProjection, objectiveId: string, at: string): void {
	const objective = state.objectives[objectiveId];
	if (objective?.objective.status !== "active") return;
	const mutableTasks = state.tasks as Record<string, TaskRuntimeState>;
	for (const taskId of objective.taskIds) {
		const current = mutableTasks[taskId];
		if (current?.task.status !== "pending") continue;
		if (taskDependencyReadiness(state, current).state === "ready") {
			mutableTasks[taskId] = { ...current, task: { ...current.task, status: "ready", updatedAt: at } };
		}
	}
}

function applyTaskCreated(state: TaskRuntimeProjection, task: TaskContract, occurredAt: string): void {
	const objectives = state.objectives as Record<string, ObjectiveRuntimeState>;
	const tasks = state.tasks as Record<string, TaskRuntimeState>;
	const objective = objectives[task.objectiveId];
	if (!objective) throw new DurableTaskRuntimeError(`Task '${task.taskId}' references an unknown objective.`);
	validateTaskContractForState(state, task, `Task '${task.taskId}'`);
	if (tasks[task.taskId]) throw new DurableTaskRuntimeError(`Task '${task.taskId}' was created more than once.`);
	assertRecordHasCapacity(tasks, MAX_ORCHESTRATION_TASKS, "task");
	assertIdentifierListHasCapacity(objective.taskIds, MAX_ORCHESTRATION_TASKS, "objective task list");
	tasks[task.taskId] = { task, attemptIds: [] };
	objectives[task.objectiveId] = { ...objective, taskIds: [...objective.taskIds, task.taskId] };
	refreshReadyTasks(state, task.objectiveId, occurredAt);
}

function applyAttemptQueued(state: TaskRuntimeProjection, payload: JsonObject, occurredAt: string): void {
	const objectives = state.objectives as Record<string, ObjectiveRuntimeState>;
	const tasks = state.tasks as Record<string, TaskRuntimeState>;
	const attempts = state.attempts as Record<string, AttemptRuntimeState>;
	const attemptId = string(payload.attemptId, "attempt.queued.attemptId");
	const taskId = string(payload.taskId, "attempt.queued.taskId");
	const task = tasks[taskId];
	if (!task) throw new DurableTaskRuntimeError(`Attempt '${attemptId}' references an unknown task.`);
	if (attempts[attemptId]) throw new DurableTaskRuntimeError(`Attempt '${attemptId}' was queued more than once.`);
	assertRecordHasCapacity(attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
	assertIdentifierListHasCapacity(task.attemptIds, MAX_ORCHESTRATION_ATTEMPTS, "task attempt list");
	const active = activeTaskAttempt(state, task);
	if (active) {
		throw new DurableTaskRuntimeError(`Task '${taskId}' already owns active attempt '${active.attemptId}'.`);
	}
	const objective = objectives[task.task.objectiveId]?.objective;
	if (objective?.status !== "active") {
		throw new DurableTaskRuntimeError(`Objective '${task.task.objectiveId}' is not active.`);
	}
	assertTaskAttemptBudgetForState(task, objective);
	if (!["pending", "ready", "blocked", "failed"].includes(task.task.status)) {
		throw new DurableTaskRuntimeError(`Task '${taskId}' is not dispatchable from '${task.task.status}'.`);
	}
	const dispatch = dispatchFromValue(payload.dispatch, "attempt.queued.dispatch");
	if (dispatch.taskId !== taskId) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' dispatch task does not match its task.`);
	}
	if (
		dispatch.executionContract &&
		(dispatch.executionContract.worker.profile.profileId !== dispatch.profileId ||
			dispatch.executionContract.worker.profile.role !== task.task.role)
	) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' execution contract does not match its dispatch.`);
	}
	attempts[attemptId] = {
		attemptId,
		taskId,
		dispatch,
		status: "queued",
		...(typeof payload.grantId === "string" ? { grantId: payload.grantId } : {}),
		checkpointIds: [],
		createdAt: occurredAt,
		updatedAt: occurredAt,
	};
	const nextTask: TaskRuntimeState = {
		...task,
		task: {
			...task.task,
			status: taskDependencyReadiness(state, task).state === "ready" ? "ready" : "pending",
			updatedAt: occurredAt,
		},
		attemptIds: [...task.attemptIds, attemptId],
	};
	delete nextTask.verification;
	tasks[taskId] = nextTask;
}

export function requireActiveObjectiveForAttemptInProjection(
	state: TaskRuntimeProjection,
	attempt: AttemptRuntimeState,
): ObjectiveContract {
	const task = state.tasks[attempt.taskId];
	if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
	const objective = state.objectives[task.task.objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${task.task.objectiveId}'.`);
	if (objective.status !== "active") {
		throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' is not active.`);
	}
	return objective;
}

export function assertRetryBackoffElapsedAt(attempt: AttemptRuntimeState, atMs: number): void {
	if (!attempt.retry) return;
	const remainingMs = Date.parse(attempt.retry.notBefore) - atMs;
	if (remainingMs > 0) {
		throw new DurableTaskRuntimeError(`Attempt '${attempt.attemptId}' retry backoff has ${remainingMs}ms remaining.`);
	}
}

function assertLeaseLiveAt(lease: AttemptLease, occurredAt: string, label: string): void {
	const occurredAtMs = Date.parse(occurredAt);
	if (!Number.isFinite(occurredAtMs) || Date.parse(lease.expiresAt) <= occurredAtMs) {
		throw new DurableTaskRuntimeError(`${label} lease has expired.`);
	}
}

function assertEventAggregateId(event: OrchestrationEvent, expectedId: string, label: string): void {
	if (event.aggregateId !== expectedId) {
		throw new DurableTaskRuntimeError(`${label} '${expectedId}' does not match aggregate '${event.aggregateId}'.`);
	}
}

export function assertAttemptFinishTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	result: WorkerResultContract,
	occurredAt: string,
): { attempt: AttemptRuntimeState; task: TaskRuntimeState } {
	if (
		result.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION ||
		!result.resultId?.trim() ||
		!result.attemptId?.trim() ||
		!result.taskId?.trim() ||
		!result.objectiveId?.trim() ||
		!result.leaseId?.trim() ||
		!WORKER_RESULT_STATUSES.some((status) => status === result.status) ||
		!Array.isArray(result.evidence)
	) {
		throw new DurableTaskRuntimeError("Worker result contract is invalid.");
	}
	if (aggregateId !== result.attemptId) {
		throw new DurableTaskRuntimeError("Worker result attemptId does not match its aggregate.");
	}
	const attempt = state.attempts[result.attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${result.attemptId}'.`);
	if (attempt.status !== "running" && attempt.status !== "leased") {
		throw new DurableTaskRuntimeError(`Attempt '${result.attemptId}' cannot finish from '${attempt.status}'.`);
	}
	if (
		!attempt.lease ||
		attempt.lease.leaseId !== result.leaseId ||
		attempt.lease.fencingToken !== result.fencingToken
	) {
		throw new DurableTaskRuntimeError(`Attempt '${result.attemptId}' lease or fencing token is stale.`);
	}
	assertLeaseLiveAt(attempt.lease, occurredAt, `Attempt '${result.attemptId}'`);
	if (attempt.taskId !== result.taskId) {
		throw new DurableTaskRuntimeError("Worker result taskId does not match attempt.");
	}
	const task = state.tasks[attempt.taskId];
	if (!task || task.task.objectiveId !== result.objectiveId) {
		throw new DurableTaskRuntimeError("Worker result objectiveId does not match attempt.");
	}
	if (result.status === "completed") {
		const missingCriteria = missingTrustedCriteria(result, task.task.acceptanceCriterionIds);
		if (missingCriteria.length > 0) {
			throw new DurableTaskRuntimeError(
				`Completed result lacks trusted evidence for acceptance criteria: ${missingCriteria.join(", ")}.`,
			);
		}
	}
	return { attempt, task };
}

function approvalForAttemptInProjection(
	state: TaskRuntimeProjection,
	attemptId: string,
): ApprovalRuntimeState | undefined {
	return Object.values(state.approvals).find((approval) => approval.request.attemptId === attemptId);
}

export function assertAttemptGrantTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	attemptId: string,
	grant: ExecutionGrant,
): AttemptRuntimeState {
	if (aggregateId !== attemptId) {
		throw new DurableTaskRuntimeError(`Grant-bound attempt '${attemptId}' does not match its aggregate.`);
	}
	const attempt = state.attempts[attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
	if (!["queued", "leased", "running"].includes(attempt.status)) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot bind a grant from '${attempt.status}'.`);
	}
	const task = state.tasks[attempt.taskId];
	if (
		!task ||
		grant.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION ||
		!grant.grantId?.trim() ||
		grant.attemptId !== attemptId ||
		grant.taskId !== attempt.taskId ||
		grant.objectiveId !== task.task.objectiveId ||
		grant.role !== task.task.role
	) {
		throw new DurableTaskRuntimeError("Execution grant target does not match the attempt.");
	}
	const approval = approvalForAttemptInProjection(state, attemptId);
	if (approval?.status === "pending") {
		throw new DurableTaskRuntimeError(
			`Attempt '${attemptId}' is awaiting approval '${approval.request.approvalId}'.`,
		);
	}
	if (approval?.status === "rejected") {
		throw new DurableTaskRuntimeError(`Approval '${approval.request.approvalId}' was rejected.`);
	}
	if (attempt.grantId === grant.grantId && attempt.grant && !isDeepStrictEqual(attempt.grant, grant)) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' grant has conflicting content.`);
	}
	if (attempt.grantId && attempt.grantId !== grant.grantId) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' already has a different grant.`);
	}
	return attempt;
}

export function assertAttemptLeaseTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	lease: AttemptLease,
	agentId: string | undefined,
	occurredAt: string,
): AttemptRuntimeState {
	if (aggregateId !== lease.attemptId) {
		throw new DurableTaskRuntimeError(`Leased attempt '${lease.attemptId}' does not match its aggregate.`);
	}
	const attempt = state.attempts[lease.attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${lease.attemptId}'.`);
	if (attempt.status !== "queued") throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' is not queued.`);
	assertAttemptDispatchReady(state, attempt);
	const approval = approvalForAttemptInProjection(state, lease.attemptId);
	if (approval?.status === "pending") {
		throw new DurableTaskRuntimeError(
			`Attempt '${lease.attemptId}' is awaiting approval '${approval.request.approvalId}'.`,
		);
	}
	if (approval?.status === "rejected") {
		throw new DurableTaskRuntimeError(`Approval '${approval.request.approvalId}' was rejected.`);
	}
	if (!attempt.grantId) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' requires an execution grant before leasing.`);
	}
	if (lease.fencingToken !== (attempt.lease?.fencingToken ?? 0) + 1) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' lease fence is not monotonic.`);
	}
	const occurredAtMs = Date.parse(occurredAt);
	const issuedAtMs = Date.parse(lease.issuedAt);
	const expiresAtMs = Date.parse(lease.expiresAt);
	if (
		!Number.isFinite(occurredAtMs) ||
		!Number.isFinite(issuedAtMs) ||
		!Number.isFinite(expiresAtMs) ||
		issuedAtMs > occurredAtMs ||
		expiresAtMs <= occurredAtMs
	) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' lease dates are invalid.`);
	}
	if (agentId) {
		const agent = state.agents[agentId];
		const task = state.tasks[attempt.taskId];
		if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
		assertAgentNotRetired(agent, "lease an attempt");
		if (agent.status !== "registered") throw new DurableTaskRuntimeError(`Agent '${agentId}' is not idle.`);
		if (!task || task.task.role !== agent.role) {
			throw new DurableTaskRuntimeError(`Agent '${agentId}' role does not match task.`);
		}
	}
	return attempt;
}

export function assertAttemptStartTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	attemptId: string,
	leaseId: string,
	fencingToken: number,
	occurredAt: string,
): AttemptRuntimeState {
	if (aggregateId !== attemptId) {
		throw new DurableTaskRuntimeError(`Started attempt '${attemptId}' does not match its aggregate.`);
	}
	const attempt = state.attempts[attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
	if (attempt.status !== "leased") throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not leased.`);
	if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
	}
	assertLeaseLiveAt(attempt.lease, occurredAt, `Attempt '${attemptId}'`);
	requireActiveObjectiveForAttemptInProjection(state, attempt);
	return attempt;
}

export function assertAttemptLeaseRenewalTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	attemptId: string,
	leaseId: string,
	fencingToken: number,
	expiresAt: string,
	occurredAt: string,
): AttemptRuntimeState {
	if (aggregateId !== attemptId) {
		throw new DurableTaskRuntimeError(`Renewed attempt '${attemptId}' does not match its aggregate.`);
	}
	const attempt = state.attempts[attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
	if (attempt.status !== "leased" && attempt.status !== "running") {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot renew from '${attempt.status}'.`);
	}
	if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
	}
	assertLeaseLiveAt(attempt.lease, occurredAt, `Attempt '${attemptId}'`);
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.parse(attempt.lease.expiresAt)) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' renewed lease must extend its expiration.`);
	}
	requireActiveObjectiveForAttemptInProjection(state, attempt);
	return attempt;
}

export function assertAttemptCheckpointTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	checkpoint: AttemptCheckpoint,
	leaseId: string,
	occurredAt: string,
): AttemptRuntimeState {
	if (aggregateId !== checkpoint.attemptId) {
		throw new DurableTaskRuntimeError(`Checkpointed attempt '${checkpoint.attemptId}' does not match its aggregate.`);
	}
	const attempt = state.attempts[checkpoint.attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${checkpoint.attemptId}'.`);
	if (attempt.status !== "running") {
		throw new DurableTaskRuntimeError(`Attempt '${checkpoint.attemptId}' is not running.`);
	}
	if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== checkpoint.fencingToken) {
		throw new DurableTaskRuntimeError(`Attempt '${checkpoint.attemptId}' lease or fencing token is stale.`);
	}
	assertLeaseLiveAt(attempt.lease, occurredAt, `Attempt '${checkpoint.attemptId}'`);
	return attempt;
}

export function assertApprovalRequestTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	approval: ApprovalRequestContract,
): void {
	const expectedAggregateId = approval.attemptId ?? approval.taskId ?? approval.objectiveId;
	if (aggregateId !== expectedAggregateId) {
		throw new DurableTaskRuntimeError(`Approval target '${expectedAggregateId}' does not match its aggregate.`);
	}
	const objective = state.objectives[approval.objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${approval.objectiveId}'.`);
	if (objective.status !== "active") {
		throw new DurableTaskRuntimeError(`Objective '${approval.objectiveId}' is not active.`);
	}
	if (approval.attemptId && !approval.taskId) {
		throw new DurableTaskRuntimeError("Attempt-scoped approval requires a taskId.");
	}
	if (approval.taskId) {
		const task = state.tasks[approval.taskId];
		if (!task || task.task.objectiveId !== approval.objectiveId) {
			throw new DurableTaskRuntimeError(`Approval task '${approval.taskId}' does not belong to its objective.`);
		}
	}
	if (approval.attemptId) {
		const attempt = state.attempts[approval.attemptId];
		if (!attempt || attempt.taskId !== approval.taskId) {
			throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' does not belong to its task.`);
		}
		if (attempt.status !== "queued" || attempt.grantId) {
			throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' is not awaiting policy.`);
		}
	}
	const pendingForTarget = Object.values(state.approvals).find(
		(candidate) =>
			candidate.status === "pending" &&
			candidate.request.objectiveId === approval.objectiveId &&
			candidate.request.taskId === approval.taskId &&
			candidate.request.attemptId === approval.attemptId,
	);
	if (pendingForTarget) {
		throw new DurableTaskRuntimeError(`Target already awaits approval '${pendingForTarget.request.approvalId}'.`);
	}
}

export function assertApprovalResolutionTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	resolution: ApprovalResolutionContract,
): ApprovalRuntimeState {
	const approval = state.approvals[resolution.approvalId];
	if (!approval) throw new DurableTaskRuntimeError(`Unknown approval '${resolution.approvalId}'.`);
	const expectedAggregateId = approval.request.attemptId ?? approval.request.taskId ?? approval.request.objectiveId;
	if (aggregateId !== expectedAggregateId) {
		throw new DurableTaskRuntimeError(`Resolved approval target '${expectedAggregateId}' does not match aggregate.`);
	}
	if (approval.status !== "pending") {
		throw new DurableTaskRuntimeError(`Approval '${resolution.approvalId}' was already ${approval.status}.`);
	}
	return approval;
}

export function assertNotificationTarget(
	state: TaskRuntimeProjection,
	objectiveId: string,
	attemptId: string | undefined,
): void {
	if (!state.objectives[objectiveId]) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	if (!attemptId) return;
	const attempt = state.attempts[attemptId];
	const task = attempt ? state.tasks[attempt.taskId] : undefined;
	if (!attempt || !task || task.task.objectiveId !== objectiveId) {
		throw new DurableTaskRuntimeError(`Notification attempt '${attemptId}' does not belong to its objective.`);
	}
}

export interface VerificationTransitionInput {
	taskId: string;
	verifierTaskId: string;
	verifierAttemptId: string;
	verdict: "accepted" | "rejected" | "inconclusive";
	reasonCode: string;
}

export function assertTaskFailureTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	taskId: string,
	reasonCode: string,
): TaskRuntimeState {
	if (aggregateId !== taskId)
		throw new DurableTaskRuntimeError(`Failed task '${taskId}' does not match its aggregate.`);
	const task = state.tasks[taskId];
	if (!task) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
	if (task.task.status !== "pending" && task.task.status !== "ready" && task.task.status !== "blocked") {
		throw new DurableTaskRuntimeError(`Task '${taskId}' cannot fail from '${task.task.status}'.`);
	}
	const active = activeTaskAttempt(state, task);
	if (active) {
		throw new DurableTaskRuntimeError(`Task '${taskId}' still owns active attempt '${active.attemptId}'.`);
	}
	dispatchIdentifier(reasonCode.trim(), "task.failed.reasonCode");
	return task;
}

export function assertVerificationTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	args: VerificationTransitionInput,
): { subject: TaskRuntimeState; verifierAttempt: AttemptRuntimeState } {
	if (aggregateId !== args.taskId) {
		throw new DurableTaskRuntimeError("Verification subject does not match its aggregate.");
	}
	const subject = state.tasks[args.taskId];
	const verifierTask = state.tasks[args.verifierTaskId];
	const verifierAttempt = state.attempts[args.verifierAttemptId];
	if (!subject) throw new DurableTaskRuntimeError(`Unknown verification subject '${args.taskId}'.`);
	if (subject.verification) {
		throw new DurableTaskRuntimeError(`Verification subject '${args.taskId}' was already reconciled.`);
	}
	if (subject.task.status !== "blocked") {
		throw new DurableTaskRuntimeError(
			`Verification subject '${args.taskId}' cannot reconcile from '${subject.task.status}'.`,
		);
	}
	if (!verifierTask || verifierTask.task.verificationOfTaskId !== args.taskId) {
		throw new DurableTaskRuntimeError(`Task '${args.verifierTaskId}' is not the verifier for '${args.taskId}'.`);
	}
	if (!verifierAttempt || verifierAttempt.taskId !== args.verifierTaskId) {
		throw new DurableTaskRuntimeError(`Unknown verifier attempt '${args.verifierAttemptId}'.`);
	}
	if (!terminalAttemptStatus(verifierAttempt.status)) {
		throw new DurableTaskRuntimeError(`Verifier attempt '${args.verifierAttemptId}' is not terminal.`);
	}
	if (args.verdict === "accepted" && verifierAttempt.status !== "completed") {
		throw new DurableTaskRuntimeError(`Verifier attempt '${args.verifierAttemptId}' is not completed.`);
	}
	dispatchIdentifier(args.reasonCode.trim(), "verification reasonCode");
	if (
		args.verdict !== "inconclusive" &&
		!verifierAttempt.result?.evidence.some(
			(evidence) =>
				evidence.trusted &&
				evidence.kind === "review" &&
				evidence.metadata?.subjectTaskId === args.taskId &&
				evidence.metadata.verdict === args.verdict,
		)
	) {
		throw new DurableTaskRuntimeError(
			`${args.verdict === "accepted" ? "Accepted" : "Rejected"} verification requires matching trusted review evidence for the subject task.`,
		);
	}
	return { subject, verifierAttempt };
}

function applyAttemptResumed(
	state: TaskRuntimeProjection,
	aggregateId: string,
	payload: JsonObject,
	occurredAt: string,
): void {
	const attempts = state.attempts as Record<string, AttemptRuntimeState>;
	const agents = state.agents as Record<string, AgentBindingContract>;
	const lease = leaseFromPayload(payload);
	const agentId = string(payload.agentId, "attempt.resumed.agentId");
	const attempt = attempts[lease.attemptId];
	const agent = agents[agentId];
	if (aggregateId !== lease.attemptId) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' resume does not match its aggregate.`);
	}
	if (attempt?.status !== "suspended" || attempt.agentId !== agentId) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' is not suspended for agent '${agentId}'.`);
	}
	if (agent?.status !== "resuming" || agent.activeAttemptId !== lease.attemptId) {
		throw new DurableTaskRuntimeError(`Agent '${agentId}' is not resuming attempt '${lease.attemptId}'.`);
	}
	assertAgentNotRetired(agent, "resume an attempt");
	if (lease.fencingToken !== (attempt.lease?.fencingToken ?? 0) + 1) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' resume fence is not monotonic.`);
	}
	const occurredAtMs = Date.parse(occurredAt);
	if (!Number.isFinite(occurredAtMs)) throw new DurableTaskRuntimeError("Attempt resume event time is invalid.");
	assertRetryBackoffElapsedAt(attempt, occurredAtMs);
	const issuedAtMs = Date.parse(lease.issuedAt);
	const expiresAtMs = Date.parse(lease.expiresAt);
	if (
		!Number.isFinite(issuedAtMs) ||
		!Number.isFinite(expiresAtMs) ||
		issuedAtMs > occurredAtMs ||
		expiresAtMs <= occurredAtMs
	) {
		throw new DurableTaskRuntimeError(`Attempt '${lease.attemptId}' resume lease dates are invalid.`);
	}
	requireActiveObjectiveForAttemptInProjection(state, attempt);
	attempts[lease.attemptId] = {
		...attempt,
		status: "leased",
		agentId,
		lease,
		updatedAt: occurredAt,
	};
	agents[agentId] = {
		...agent,
		status: "active",
		activeAttemptId: lease.attemptId,
		updatedAt: occurredAt,
	};
}

export function reduceOrchestrationEvent(
	projection: TaskRuntimeProjection,
	event: OrchestrationEvent,
): TaskRuntimeProjection {
	assertProjectionWithinLimits(projection);
	if (event.ordinal <= projection.lastOrdinal) return projection;
	if (event.ordinal !== projection.lastOrdinal + 1) {
		throw new DurableTaskRuntimeError(
			`Orchestration event ordinal ${event.ordinal} is not contiguous after ${projection.lastOrdinal}.`,
		);
	}
	// Copy only the record maps: records are replaced, never mutated, so every unchanged record is
	// shared with the previous projection (which the runtime keeps frozen). Deep-cloning the whole
	// projection per event cost as much as the delegations producing the events.
	const state: TaskRuntimeProjection = {
		...projection,
		agents: { ...projection.agents },
		objectives: { ...projection.objectives },
		tasks: { ...projection.tasks },
		attempts: { ...projection.attempts },
		checkpoints: { ...projection.checkpoints },
		approvals: { ...projection.approvals },
		notifications: { ...projection.notifications },
	};
	const byteTracker = new ProjectionByteTracker(projection);
	const rawAgents = state.agents as Record<string, AgentBindingContract>;
	const rawObjectives = state.objectives as Record<string, ObjectiveRuntimeState>;
	const rawTasks = state.tasks as Record<string, TaskRuntimeState>;
	const rawAttempts = state.attempts as Record<string, AttemptRuntimeState>;
	const rawCheckpoints = state.checkpoints as Record<string, AttemptCheckpoint>;
	const rawApprovals = state.approvals as Record<string, ApprovalRuntimeState>;
	const rawNotifications = state.notifications as Record<string, NotificationRuntimeState>;
	const agents = byteTracker.track("agents", rawAgents);
	const objectives = byteTracker.track("objectives", rawObjectives);
	const tasks = byteTracker.track("tasks", rawTasks);
	const attempts = byteTracker.track("attempts", rawAttempts);
	const checkpoints = byteTracker.track("checkpoints", rawCheckpoints);
	const approvals = byteTracker.track("approvals", rawApprovals);
	const notifications = byteTracker.track("notifications", rawNotifications);
	state.agents = agents;
	state.objectives = objectives;
	state.tasks = tasks;
	state.attempts = attempts;
	state.checkpoints = checkpoints;
	state.approvals = approvals;
	state.notifications = notifications;

	switch (event.type) {
		case "objective.created": {
			const objective = objectiveFromPayload(event.payload);
			assertEventAggregateId(event, objective.objectiveId, "Created objective");
			if (objective.status !== "active") {
				throw new DurableTaskRuntimeError(`Created objective '${objective.objectiveId}' must be active.`);
			}
			if (objectives[objective.objectiveId]) {
				throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' was created more than once.`);
			}
			assertRecordHasCapacity(objectives, MAX_ORCHESTRATION_OBJECTIVES, "objective");
			objectives[objective.objectiveId] = { objective, taskIds: [], evidence: [] };
			break;
		}
		case "objective.updated": {
			const objective = objectiveFromPayload(event.payload);
			const current = assertObjectiveUpdateTransition(state, event.aggregateId, objective);
			objectives[event.aggregateId] = { ...current, objective };
			break;
		}
		case "objective.evidence_recorded": {
			const evidence = evidenceFromPayload(event.payload);
			const current = assertObjectiveEvidenceTransition(state, event.aggregateId, evidence);
			const existing = current.evidence.find((candidate) => candidate.evidenceId === evidence.evidenceId);
			if (existing && !isDeepStrictEqual(existing, evidence)) {
				throw new DurableTaskRuntimeError(`Objective evidence '${evidence.evidenceId}' has conflicting content.`);
			}
			if (!existing) {
				assertObjectiveEvidenceHasCapacity(objectives, current);
				objectives[event.aggregateId] = { ...current, evidence: [...current.evidence, evidence] };
			}
			break;
		}
		case "objective.paused":
			assertObjectiveStatusTransition(state, event.aggregateId, "paused");
			updateObjectiveStatus(state, event.aggregateId, "paused", event.occurredAt);
			break;
		case "objective.resumed":
			assertObjectiveStatusTransition(state, event.aggregateId, "active");
			updateObjectiveStatus(state, event.aggregateId, "active", event.occurredAt);
			refreshReadyTasks(state, event.aggregateId, event.occurredAt);
			break;
		case "objective.completed": {
			const policy = string(event.payload.completionPolicy, "objective.completed.completionPolicy");
			if (policy !== "task_evidence" && policy !== "owner_evidence" && policy !== "owner_override") {
				throw new DurableTaskRuntimeError(`Unknown objective completion policy '${policy}'.`);
			}
			assertObjectiveStatusTransition(state, event.aggregateId, "completed", policy);
			updateObjectiveStatus(state, event.aggregateId, "completed", event.occurredAt);
			cancelOpenObjectiveWork(state, event.aggregateId, event.occurredAt, "objective_completed");
			break;
		}
		case "objective.cancelled": {
			assertObjectiveStatusTransition(state, event.aggregateId, "cancelled");
			updateObjectiveStatus(state, event.aggregateId, "cancelled", event.occurredAt);
			cancelOpenObjectiveWork(state, event.aggregateId, event.occurredAt, "objective_cancelled");
			break;
		}
		case "task.created": {
			const task = taskFromPayload(event.payload);
			assertEventAggregateId(event, task.objectiveId, "Created task objective");
			applyTaskCreated(state, task, event.occurredAt);
			break;
		}
		case "task.attempt_prepared": {
			const task = taskFromPayload(event.payload);
			if (event.aggregateId !== task.taskId) {
				throw new DurableTaskRuntimeError(`Prepared task '${task.taskId}' does not match its aggregate.`);
			}
			applyTaskCreated(state, task, event.occurredAt);
			applyAttemptQueued(state, event.payload, event.occurredAt);
			break;
		}
		case "task.ready": {
			const taskId = string(event.payload.taskId, "task.ready.taskId");
			assertEventAggregateId(event, taskId, "Ready task");
			const current = tasks[taskId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
			if (current.task.status !== "pending") {
				throw new DurableTaskRuntimeError(`Task '${taskId}' cannot become ready from '${current.task.status}'.`);
			}
			if (taskDependencyReadiness(state, current).state !== "ready") {
				throw new DurableTaskRuntimeError(`Task '${taskId}' dependencies are incomplete.`);
			}
			tasks[taskId] = { ...current, task: { ...current.task, status: "ready", updatedAt: event.occurredAt } };
			break;
		}
		case "task.failed": {
			const taskId = string(event.payload.taskId, "task.failed.taskId");
			const reasonCode = string(event.payload.reasonCode, "task.failed.reasonCode");
			const current = assertTaskFailureTransition(state, event.aggregateId, taskId, reasonCode);
			tasks[taskId] = { ...current, task: { ...current.task, status: "failed", updatedAt: event.occurredAt } };
			break;
		}
		case "task.verification_finished": {
			const taskId = string(event.payload.taskId, "task.verification_finished.taskId");
			const verifierTaskId = string(event.payload.verifierTaskId, "task.verification_finished.verifierTaskId");
			const verifierAttemptId = string(
				event.payload.verifierAttemptId,
				"task.verification_finished.verifierAttemptId",
			);
			const verdict = string(event.payload.verdict, "task.verification_finished.verdict");
			if (verdict !== "accepted" && verdict !== "rejected" && verdict !== "inconclusive") {
				throw new DurableTaskRuntimeError(`Unknown verification verdict '${verdict}'.`);
			}
			const reasonCode = string(event.payload.reasonCode, "task.verification_finished.reasonCode");
			const transition: VerificationTransitionInput = {
				taskId,
				verifierTaskId,
				verifierAttemptId,
				verdict,
				reasonCode,
			};
			const { subject: current } = assertVerificationTransition(state, event.aggregateId, transition);
			tasks[taskId] = {
				...current,
				task: {
					...current.task,
					status: verdict === "accepted" ? "completed" : "blocked",
					updatedAt: event.occurredAt,
				},
				verification: {
					verifierTaskId,
					verifierAttemptId,
					verdict,
					reasonCode,
					completedAt: event.occurredAt,
				},
			};
			refreshReadyTasks(state, current.task.objectiveId, event.occurredAt);
			break;
		}
		case "agent.registered": {
			const agent = agentFromPayload(event.payload);
			assertEventAggregateId(event, agent.agentId, "Registered agent");
			if (agent.status !== "registered" || agent.activeAttemptId) {
				throw new DurableTaskRuntimeError(`Registered agent '${agent.agentId}' must start idle.`);
			}
			if (agents[agent.agentId])
				throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' was registered more than once.`);
			assertRecordHasCapacity(agents, MAX_ORCHESTRATION_AGENT_BINDINGS, "agent binding");
			if (agent.parentAgentId) {
				const parent = agents[agent.parentAgentId];
				if (!parent) throw new DurableTaskRuntimeError(`Unknown parent agent '${agent.parentAgentId}'.`);
				if (parent.status === "retired") {
					throw new DurableTaskRuntimeError(`Parent agent '${agent.parentAgentId}' is retired.`);
				}
				if (agent.rootAgentId !== parent.rootAgentId || agent.depth !== parent.depth + 1) {
					throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' lineage conflicts with its parent.`);
				}
			} else if (agent.rootAgentId !== agent.agentId || agent.depth !== 0) {
				throw new DurableTaskRuntimeError(`Root agent '${agent.agentId}' lineage is invalid.`);
			}
			agents[agent.agentId] = agent;
			break;
		}
		case "agent.retired": {
			const agentId = string(event.payload.agentId, "agent.retired.agentId");
			if (event.aggregateId !== agentId) {
				throw new DurableTaskRuntimeError(`Retired agent '${agentId}' does not match its aggregate.`);
			}
			const agent = assertAgentRetirementEligible(state, agentId);
			if (agent.status === "retired") break;
			agents[agentId] = { ...agent, status: "retired", updatedAt: event.occurredAt };
			break;
		}
		case "agent.suspended": {
			const agentId = string(event.payload.agentId, "agent.suspended.agentId");
			assertEventAggregateId(event, agentId, "Suspended agent");
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			assertAgentNotRetired(agent, "suspend");
			throw new DurableTaskRuntimeError(
				"Standalone agent suspension is unsupported; suspend the bound attempt atomically.",
			);
		}
		case "agent.resume_requested": {
			const agentId = string(event.payload.agentId, "agent.resume_requested.agentId");
			const attemptId = string(event.payload.attemptId, "agent.resume_requested.attemptId");
			if (event.aggregateId !== agentId) {
				throw new DurableTaskRuntimeError(`Resuming agent '${agentId}' does not match its aggregate.`);
			}
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			assertAgentNotRetired(agent, "request resume");
			const attempt = attempts[attemptId];
			if (attempt?.status !== "suspended" || attempt.agentId !== agentId || agent.activeAttemptId !== attemptId) {
				throw new DurableTaskRuntimeError(`Agent '${agentId}' cannot resume suspended attempt '${attemptId}'.`);
			}
			if (agent.status === "resuming") break;
			if (agent.status !== "suspended") {
				throw new DurableTaskRuntimeError(`Agent '${agentId}' is not suspended.`);
			}
			const occurredAtMs = Date.parse(event.occurredAt);
			if (!Number.isFinite(occurredAtMs)) {
				throw new DurableTaskRuntimeError("Agent resume request event time is invalid.");
			}
			assertRetryBackoffElapsedAt(attempt, occurredAtMs);
			requireActiveObjectiveForAttemptInProjection(state, attempt);
			agents[agentId] = { ...agent, status: "resuming", updatedAt: event.occurredAt };
			break;
		}
		case "agent.resumed": {
			const agentId = string(event.payload.agentId, "agent.resumed.agentId");
			assertEventAggregateId(event, agentId, "Resumed agent");
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			assertAgentNotRetired(agent, "resume");
			throw new DurableTaskRuntimeError(
				"Standalone agent resume is unsupported; resume the suspended attempt atomically.",
			);
		}
		case "attempt.queued": {
			assertEventAggregateId(event, string(event.payload.taskId, "attempt.queued.taskId"), "Queued attempt task");
			applyAttemptQueued(state, event.payload, event.occurredAt);
			break;
		}
		case "attempt.grant_bound": {
			const attemptId = string(event.payload.attemptId, "attempt.grant_bound.attemptId");
			const grant = executionGrantFromValue(event.payload.grant, "attempt.grant_bound.grant");
			const attempt = assertAttemptGrantTransition(state, event.aggregateId, attemptId, grant);
			attempts[attemptId] = {
				...attempt,
				grantId: grant.grantId,
				grant,
				updatedAt: event.occurredAt,
			};
			break;
		}
		case "attempt.leased": {
			const lease = leaseFromPayload(event.payload);
			const agentId = typeof event.payload.agentId === "string" ? event.payload.agentId : undefined;
			const attempt = assertAttemptLeaseTransition(state, event.aggregateId, lease, agentId, event.occurredAt);
			if (agentId) {
				const agent = agents[agentId];
				if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
				agents[agentId] = {
					...agent,
					status: "active",
					activeAttemptId: lease.attemptId,
					updatedAt: event.occurredAt,
				};
			}
			attempts[lease.attemptId] = {
				...attempt,
				status: "leased",
				lease,
				...(agentId ? { agentId } : {}),
				updatedAt: event.occurredAt,
			};
			const task = tasks[attempt.taskId];
			if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
			tasks[attempt.taskId] = {
				...task,
				task: { ...task.task, status: "running", updatedAt: event.occurredAt },
			};
			break;
		}
		case "attempt.started": {
			const attemptId = string(event.payload.attemptId, "attempt.started.attemptId");
			const leaseId = string(event.payload.leaseId, "attempt.started.leaseId");
			const fencingToken = number(event.payload.fencingToken, "attempt.started.fencingToken");
			const attempt = assertAttemptStartTransition(
				state,
				event.aggregateId,
				attemptId,
				leaseId,
				fencingToken,
				event.occurredAt,
			);
			attempts[attemptId] = { ...attempt, status: "running", updatedAt: event.occurredAt };
			break;
		}
		case "attempt.lease_renewed": {
			const attemptId = string(event.payload.attemptId, "attempt.lease_renewed.attemptId");
			const leaseId = string(event.payload.leaseId, "attempt.lease_renewed.leaseId");
			const fencingToken = number(event.payload.fencingToken, "attempt.lease_renewed.fencingToken");
			const expiresAt = string(event.payload.expiresAt, "attempt.lease_renewed.expiresAt");
			const attempt = assertAttemptLeaseRenewalTransition(
				state,
				event.aggregateId,
				attemptId,
				leaseId,
				fencingToken,
				expiresAt,
				event.occurredAt,
			);
			attempts[attemptId] = {
				...attempt,
				lease: { ...attempt.lease!, expiresAt },
				updatedAt: event.occurredAt,
			};
			break;
		}
		case "attempt.checkpointed": {
			const checkpoint = checkpointFromPayload(event.payload);
			const leaseId = string(event.payload.leaseId, "attempt.checkpointed.leaseId");
			const attempt = assertAttemptCheckpointTransition(
				state,
				event.aggregateId,
				checkpoint,
				leaseId,
				event.occurredAt,
			);
			if (checkpoints[checkpoint.checkpointId]) {
				throw new DurableTaskRuntimeError(`Checkpoint '${checkpoint.checkpointId}' was recorded more than once.`);
			}
			assertIdentifierListHasCapacity(
				attempt.checkpointIds,
				MAX_ORCHESTRATION_CHECKPOINTS,
				"attempt checkpoint list",
			);
			assertRecordHasCapacity(checkpoints, MAX_ORCHESTRATION_CHECKPOINTS, "checkpoint");
			checkpoints[checkpoint.checkpointId] = checkpoint;
			attempts[checkpoint.attemptId] = {
				...attempt,
				checkpointIds: [...attempt.checkpointIds, checkpoint.checkpointId],
				updatedAt: event.occurredAt,
			};
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) {
					assertAgentNotRetired(agent, "checkpoint an attempt");
					agents[attempt.agentId] = {
						...agent,
						resumeContext: { ...agent.resumeContext, latestCheckpointId: checkpoint.checkpointId },
						updatedAt: event.occurredAt,
					};
				}
			}
			break;
		}
		case "attempt.suspended": {
			const attemptId = string(event.payload.attemptId, "attempt.suspended.attemptId");
			assertEventAggregateId(event, attemptId, "Suspended attempt");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			const leaseId = string(event.payload.leaseId, "attempt.suspended.leaseId");
			const fencingToken = number(event.payload.fencingToken, "attempt.suspended.fencingToken");
			if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
			}
			if (attempt.status !== "leased" && attempt.status !== "running") {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot suspend from '${attempt.status}'.`);
			}
			if (!attempt.agentId) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not bound to a resumable agent.`);
			}
			const retry =
				event.payload.retry === undefined
					? undefined
					: retryStateFromValue(event.payload.retry, "attempt.suspended.retry");
			if (retry && retry.retriesUsed !== (attempt.retry?.retriesUsed ?? 0) + 1) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' retry count is not monotonic.`);
			}
			if (retry && Date.parse(retry.notBefore) <= Date.parse(event.occurredAt)) {
				throw new DurableTaskRuntimeError("Retry not-before deadline must be after the suspension event.");
			}
			attempts[attemptId] = {
				...attempt,
				status: "suspended",
				...(typeof event.payload.reasonCode === "string" ? { reasonCode: event.payload.reasonCode } : {}),
				...(retry ? { retry } : {}),
				updatedAt: event.occurredAt,
			};
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) {
					assertAgentNotRetired(agent, "suspend an attempt");
					agents[attempt.agentId] = { ...agent, status: "suspended", updatedAt: event.occurredAt };
				}
			}
			break;
		}
		case "attempt.resumed": {
			applyAttemptResumed(state, event.aggregateId, event.payload, event.occurredAt);
			break;
		}
		case "attempt.cancelled": {
			const attemptId = string(event.payload.attemptId, "attempt.cancelled.attemptId");
			assertEventAggregateId(event, attemptId, "Cancelled attempt");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			if (terminalAttemptStatus(attempt.status)) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot cancel from '${attempt.status}'.`);
			}
			attempts[attemptId] = withoutAttemptRetry({
				...attempt,
				status: "cancelled",
				reasonCode: string(event.payload.reasonCode, "attempt.cancelled.reasonCode"),
				updatedAt: event.occurredAt,
			});
			const task = tasks[attempt.taskId];
			if (task) {
				tasks[attempt.taskId] = {
					...task,
					task: { ...task.task, status: "cancelled", updatedAt: event.occurredAt },
				};
			}
			releaseAttemptAgent(agents, attempt, event.occurredAt);
			break;
		}
		case "attempt.finished": {
			const result = resultFromPayload(event.payload);
			const { attempt, task } = assertAttemptFinishTransition(state, event.aggregateId, result, event.occurredAt);
			attempts[result.attemptId] = withoutAttemptRetry({
				...attempt,
				status: result.status,
				result,
				updatedAt: event.occurredAt,
			});
			tasks[result.taskId] = {
				...task,
				task: { ...task.task, status: taskStatusForResult(result.status), updatedAt: event.occurredAt },
			};
			releaseAttemptAgent(agents, attempt, event.occurredAt);
			refreshReadyTasks(state, task.task.objectiveId, event.occurredAt);
			break;
		}
		case "attempt.lease_expired": {
			const attemptId = string(event.payload.attemptId, "attempt.lease_expired.attemptId");
			assertEventAggregateId(event, attemptId, "Expired attempt");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			if ((attempt.status !== "leased" && attempt.status !== "running") || !attempt.lease || attempt.agentId) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot expire from '${attempt.status}'.`);
			}
			const leaseId = string(event.payload.leaseId, "attempt.lease_expired.leaseId");
			const fencingToken = number(event.payload.fencingToken, "attempt.lease_expired.fencingToken");
			if (attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
			}
			attempts[attemptId] = withoutAttemptRetry({
				...attempt,
				status: "expired",
				...(typeof event.payload.reasonCode === "string" ? { reasonCode: event.payload.reasonCode } : {}),
				updatedAt: event.occurredAt,
			});
			const task = tasks[attempt.taskId];
			if (task)
				tasks[attempt.taskId] = { ...task, task: { ...task.task, status: "ready", updatedAt: event.occurredAt } };
			break;
		}
		case "approval.requested": {
			const approval = approvalFromPayload(event.payload);
			assertApprovalRequestTransition(state, event.aggregateId, approval);
			if (approvals[approval.approvalId]) {
				throw new DurableTaskRuntimeError(`Approval '${approval.approvalId}' was requested more than once.`);
			}
			const notificationId = `approval-requested:${approval.approvalId}`;
			if (notifications[notificationId]) {
				throw new DurableTaskRuntimeError(`Notification '${notificationId}' already exists.`);
			}
			assertRecordHasCapacity(approvals, MAX_ORCHESTRATION_APPROVALS, "approval");
			assertRecordHasCapacity(notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
			approvals[approval.approvalId] = { request: approval, status: "pending" };
			notifications[notificationId] = {
				notificationId,
				objectiveId: approval.objectiveId,
				...(approval.attemptId ? { attemptId: approval.attemptId } : {}),
				status: "pending",
				message: approval.summary,
				createdAt: event.occurredAt,
			};
			break;
		}
		case "approval.resolved": {
			const resolution = approvalResolutionFromPayload(event.payload);
			const approval = assertApprovalResolutionTransition(state, event.aggregateId, resolution);
			approvals[resolution.approvalId] = {
				...approval,
				status: resolution.outcome,
				resolution,
			};
			const approvalNotification = notifications[`approval-requested:${resolution.approvalId}`];
			if (approvalNotification?.status === "pending") {
				notifications[approvalNotification.notificationId] = {
					...approvalNotification,
					status: "delivered",
					deliveredAt: event.occurredAt,
				};
			}
			if (resolution.outcome === "rejected" && approval.request.attemptId) {
				const attempt = attempts[approval.request.attemptId];
				if (attempt && !terminalAttemptStatus(attempt.status)) {
					attempts[attempt.attemptId] = withoutAttemptRetry({
						...attempt,
						status: "blocked",
						reasonCode: "approval_rejected",
						updatedAt: event.occurredAt,
					});
					const task = tasks[attempt.taskId];
					if (task) {
						tasks[attempt.taskId] = {
							...task,
							task: { ...task.task, status: "blocked", updatedAt: event.occurredAt },
						};
					}
				}
			}
			break;
		}
		case "notification.enqueued": {
			const notificationId = string(event.payload.notificationId, "notification.enqueued.notificationId");
			const objectiveId = string(event.payload.objectiveId, "notification.enqueued.objectiveId");
			const attemptId = typeof event.payload.attemptId === "string" ? event.payload.attemptId : undefined;
			assertEventAggregateId(event, objectiveId, "Notification objective");
			assertNotificationTarget(state, objectiveId, attemptId);
			if (notifications[notificationId]) {
				throw new DurableTaskRuntimeError(`Notification '${notificationId}' was enqueued more than once.`);
			}
			assertRecordHasCapacity(notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
			notifications[notificationId] = {
				notificationId,
				objectiveId,
				...(attemptId ? { attemptId } : {}),
				status: "pending",
				message: string(event.payload.message, "notification.enqueued.message"),
				createdAt: event.occurredAt,
			};
			break;
		}
		case "notification.delivered": {
			const notificationId = string(event.payload.notificationId, "notification.delivered.notificationId");
			const notification = notifications[notificationId];
			if (!notification) throw new DurableTaskRuntimeError(`Unknown notification '${notificationId}'.`);
			assertEventAggregateId(event, notification.objectiveId, "Delivered notification objective");
			notifications[notificationId] = { ...notification, status: "delivered", deliveredAt: event.occurredAt };
			break;
		}
	}

	const serializedBytes = byteTracker.finish(event.ordinal);
	state.agents = rawAgents;
	state.objectives = rawObjectives;
	state.tasks = rawTasks;
	state.attempts = rawAttempts;
	state.checkpoints = rawCheckpoints;
	state.approvals = rawApprovals;
	state.notifications = rawNotifications;
	const result = { ...state, lastOrdinal: event.ordinal };
	cacheProjectionSerializedBytes(result, serializedBytes);
	return result;
}

export function projectOrchestrationEvents(events: readonly OrchestrationEvent[]): TaskRuntimeProjection {
	return events.reduce(reduceOrchestrationEvent, emptyProjection());
}
