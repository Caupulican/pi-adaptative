import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../autonomy/contracts.ts";
import { createAgentIdentity } from "./agent-resume.ts";
import {
	type AcceptanceCriterion,
	type AgentBindingContract,
	type AgentIdentityContract,
	type AgentResumeContext,
	type AppendOrchestrationEventInput,
	type ApprovalOutcome,
	type ApprovalRequestContract,
	type ApprovalResolutionContract,
	type AttemptCheckpoint,
	type AttemptLease,
	type AttemptStatus,
	type EvidenceContract,
	isHarnessCapability,
	type ObjectiveContract,
	type ObjectiveStatus,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationDispatchRequest,
	type OrchestrationEvent,
	type OrchestrationTaskStatus,
	type RiskBudget,
	type TaskContract,
	toJsonObject,
	type WorkerResultContract,
} from "./contracts.ts";
import type { OrchestrationEventStore } from "./event-store.ts";
import { validateRiskBudget } from "./risk-budget.ts";

export interface ObjectiveRuntimeState {
	objective: ObjectiveContract;
	taskIds: readonly string[];
	evidence: readonly EvidenceContract[];
}

export interface TaskRuntimeState {
	task: TaskContract;
	attemptIds: readonly string[];
	verification?: {
		verifierTaskId: string;
		verifierAttemptId: string;
		verdict: "accepted" | "rejected" | "inconclusive";
		reasonCode: string;
		completedAt: string;
	};
}

export interface AttemptRuntimeState {
	attemptId: string;
	taskId: string;
	dispatch: OrchestrationDispatchRequest;
	status: AttemptStatus;
	reasonCode?: string;
	grantId?: string;
	agentId?: string;
	lease?: AttemptLease;
	checkpointIds: readonly string[];
	result?: WorkerResultContract;
	createdAt: string;
	updatedAt: string;
}

export interface NotificationRuntimeState {
	notificationId: string;
	objectiveId: string;
	attemptId?: string;
	status: "pending" | "delivered";
	message: string;
	createdAt: string;
	deliveredAt?: string;
}

export interface ApprovalRuntimeState {
	request: ApprovalRequestContract;
	status: "pending" | ApprovalOutcome;
	resolution?: ApprovalResolutionContract;
}

export interface TaskRuntimeProjection {
	lastOrdinal: number;
	agents: Readonly<Record<string, AgentBindingContract>>;
	objectives: Readonly<Record<string, ObjectiveRuntimeState>>;
	tasks: Readonly<Record<string, TaskRuntimeState>>;
	attempts: Readonly<Record<string, AttemptRuntimeState>>;
	checkpoints: Readonly<Record<string, AttemptCheckpoint>>;
	approvals: Readonly<Record<string, ApprovalRuntimeState>>;
	notifications: Readonly<Record<string, NotificationRuntimeState>>;
}

export interface CreateObjectiveInput {
	objectiveId?: string;
	title: string;
	description: string;
	constraints?: readonly string[];
	acceptanceCriteria?: readonly AcceptanceCriterion[];
	riskBudget?: RiskBudget;
}

export interface CreateTaskInput {
	taskId?: string;
	objectiveId: string;
	title: string;
	description: string;
	role: TaskContract["role"];
	dependsOn?: readonly string[];
	requiredCapabilities?: TaskContract["requiredCapabilities"];
	acceptanceCriterionIds?: readonly string[];
	verificationOfTaskId?: string;
	riskBudget?: RiskBudget;
}

export interface DurableTaskRuntimeOptions {
	store: OrchestrationEventStore;
	now?: () => number;
	createId?: () => string;
}

export interface RegisterAgentInput {
	agentId?: string;
	role: AgentBindingContract["role"];
	resumeContext: AgentResumeContext;
}

export class DurableTaskRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DurableTaskRuntimeError";
	}
}

function emptyProjection(): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: {},
		attempts: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

function cloneProjection(state: TaskRuntimeProjection): TaskRuntimeProjection {
	return structuredClone(state);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DurableTaskRuntimeError(`${label} is not an object.`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new DurableTaskRuntimeError(`${label} is required.`);
	return value;
}

function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

function assertRiskBudget(budget: RiskBudget | undefined, label: string): void {
	try {
		validateRiskBudget(budget ?? {}, label);
	} catch (error) {
		throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
	}
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new DurableTaskRuntimeError(`${label} must be a string array.`);
	}
	return [...value];
}

function objectiveFromPayload(payload: JsonObject): ObjectiveContract {
	return structuredClone(record(payload.objective, "objective")) as unknown as ObjectiveContract;
}

function evidenceFromPayload(payload: JsonObject): EvidenceContract {
	return structuredClone(record(payload.evidence, "evidence")) as unknown as EvidenceContract;
}

function assertAcceptanceCriteria(criteria: readonly AcceptanceCriterion[]): void {
	const criterionIds = criteria.map((criterion) => criterion.id);
	if (
		criterionIds.some((id) => !id.trim()) ||
		new Set(criterionIds).size !== criterionIds.length ||
		criteria.some((criterion) => !criterion.description.trim())
	) {
		throw new DurableTaskRuntimeError("Objective acceptance criteria require unique ids and descriptions.");
	}
}

function taskFromPayload(payload: JsonObject): TaskContract {
	return structuredClone(record(payload.task, "task")) as unknown as TaskContract;
}

function leaseFromPayload(payload: JsonObject): AttemptLease {
	const lease = record(payload.lease, "lease");
	return {
		leaseId: string(lease.leaseId, "lease.leaseId"),
		attemptId: string(lease.attemptId, "lease.attemptId"),
		ownerId: string(lease.ownerId, "lease.ownerId"),
		fencingToken: number(lease.fencingToken, "lease.fencingToken"),
		issuedAt: string(lease.issuedAt, "lease.issuedAt"),
		expiresAt: string(lease.expiresAt, "lease.expiresAt"),
	};
}

function checkpointFromPayload(payload: JsonObject): AttemptCheckpoint {
	const checkpoint = record(payload.checkpoint, "checkpoint");
	return {
		checkpointId: string(checkpoint.checkpointId, "checkpoint.checkpointId"),
		attemptId: string(checkpoint.attemptId, "checkpoint.attemptId"),
		fencingToken: number(checkpoint.fencingToken, "checkpoint.fencingToken"),
		summary: string(checkpoint.summary, "checkpoint.summary"),
		artifactIds: stringArray(checkpoint.artifactIds, "checkpoint.artifactIds"),
		evidenceIds: stringArray(checkpoint.evidenceIds, "checkpoint.evidenceIds"),
		createdAt: string(checkpoint.createdAt, "checkpoint.createdAt"),
	};
}

function resultFromPayload(payload: JsonObject): WorkerResultContract {
	return structuredClone(record(payload.result, "result")) as unknown as WorkerResultContract;
}

function agentFromPayload(payload: JsonObject): AgentBindingContract {
	return structuredClone(record(payload.agent, "agent")) as unknown as AgentBindingContract;
}

function approvalFromPayload(payload: JsonObject): ApprovalRequestContract {
	const approval = record(payload.approval, "approval");
	const capabilities = stringArray(approval.requestedCapabilities, "approval.requestedCapabilities");
	if (!capabilities.every(isHarnessCapability)) {
		throw new DurableTaskRuntimeError("Approval contains an unknown capability.");
	}
	const requestedBudget = approval.requestedBudget
		? (structuredClone(record(approval.requestedBudget, "approval.requestedBudget")) as RiskBudget)
		: undefined;
	assertRiskBudget(requestedBudget, "approval.requestedBudget");
	if (capabilities.length === 0 && !requestedBudget) {
		throw new DurableTaskRuntimeError("Approval must request capabilities or budget.");
	}
	if (approval.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError("Approval schema version is invalid.");
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		approvalId: string(approval.approvalId, "approval.approvalId"),
		objectiveId: string(approval.objectiveId, "approval.objectiveId"),
		...(typeof approval.taskId === "string" ? { taskId: string(approval.taskId, "approval.taskId") } : {}),
		...(typeof approval.attemptId === "string"
			? { attemptId: string(approval.attemptId, "approval.attemptId") }
			: {}),
		reasonCode: string(approval.reasonCode, "approval.reasonCode"),
		summary: string(approval.summary, "approval.summary"),
		requestedCapabilities: capabilities,
		...(requestedBudget ? { requestedBudget } : {}),
		reversible: boolean(approval.reversible, "approval.reversible"),
		createdAt: string(approval.createdAt, "approval.createdAt"),
	};
}

function approvalResolutionFromPayload(payload: JsonObject): ApprovalResolutionContract {
	const resolution = record(payload.resolution, "resolution");
	if (resolution.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError("Approval resolution schema version is invalid.");
	}
	const outcome = string(resolution.outcome, "resolution.outcome");
	if (outcome !== "approved" && outcome !== "rejected") {
		throw new DurableTaskRuntimeError(`Unknown approval outcome '${outcome}'.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		approvalId: string(resolution.approvalId, "resolution.approvalId"),
		outcome,
		reasonCode: string(resolution.reasonCode, "resolution.reasonCode"),
		resolvedAt: string(resolution.resolvedAt, "resolution.resolvedAt"),
	};
}

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

function terminalAttemptStatus(status: AttemptStatus): boolean {
	return ["completed", "partial", "blocked", "failed", "cancelled", "expired"].includes(status);
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
				attempts[attemptId] = { ...attempt, status: "cancelled", reasonCode, updatedAt: at };
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

function missingTrustedCriteria(result: WorkerResultContract, criterionIds: readonly string[]): string[] {
	const proven = new Set(
		result.evidence.flatMap((evidence) => (evidence.trusted && evidence.criterionId ? [evidence.criterionId] : [])),
	);
	return criterionIds.filter((criterionId) => !proven.has(criterionId));
}

function refreshReadyTasks(state: TaskRuntimeProjection, objectiveId: string, at: string): void {
	const objective = state.objectives[objectiveId];
	if (!objective || objective.objective.status !== "active") return;
	const mutableTasks = state.tasks as Record<string, TaskRuntimeState>;
	for (const taskId of objective.taskIds) {
		const current = mutableTasks[taskId];
		if (!current || current.task.status !== "pending") continue;
		if (current.task.dependsOn.every((dependencyId) => mutableTasks[dependencyId]?.task.status === "completed")) {
			mutableTasks[taskId] = { ...current, task: { ...current.task, status: "ready", updatedAt: at } };
		}
	}
}

export function reduceOrchestrationEvent(
	projection: TaskRuntimeProjection,
	event: OrchestrationEvent,
): TaskRuntimeProjection {
	if (event.ordinal <= projection.lastOrdinal) return projection;
	const state = cloneProjection(projection);
	const agents = state.agents as Record<string, AgentBindingContract>;
	const objectives = state.objectives as Record<string, ObjectiveRuntimeState>;
	const tasks = state.tasks as Record<string, TaskRuntimeState>;
	const attempts = state.attempts as Record<string, AttemptRuntimeState>;
	const checkpoints = state.checkpoints as Record<string, AttemptCheckpoint>;
	const approvals = state.approvals as Record<string, ApprovalRuntimeState>;
	const notifications = state.notifications as Record<string, NotificationRuntimeState>;

	switch (event.type) {
		case "objective.created": {
			const objective = objectiveFromPayload(event.payload);
			if (objectives[objective.objectiveId]) {
				throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' was created more than once.`);
			}
			objectives[objective.objectiveId] = { objective, taskIds: [], evidence: [] };
			break;
		}
		case "objective.updated": {
			const objective = objectiveFromPayload(event.payload);
			const current = objectives[event.aggregateId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown objective '${event.aggregateId}'.`);
			if (objective.objectiveId !== event.aggregateId) {
				throw new DurableTaskRuntimeError(
					`Updated objective id '${objective.objectiveId}' does not match aggregate.`,
				);
			}
			objectives[event.aggregateId] = { ...current, objective };
			break;
		}
		case "objective.evidence_recorded": {
			const evidence = evidenceFromPayload(event.payload);
			const current = objectives[event.aggregateId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown objective '${event.aggregateId}'.`);
			const existing = current.evidence.find((candidate) => candidate.evidenceId === evidence.evidenceId);
			if (existing && !isDeepStrictEqual(existing, evidence)) {
				throw new DurableTaskRuntimeError(`Objective evidence '${evidence.evidenceId}' has conflicting content.`);
			}
			if (!existing) objectives[event.aggregateId] = { ...current, evidence: [...current.evidence, evidence] };
			break;
		}
		case "objective.paused":
			updateObjectiveStatus(state, event.aggregateId, "paused", event.occurredAt);
			break;
		case "objective.resumed":
			updateObjectiveStatus(state, event.aggregateId, "active", event.occurredAt);
			refreshReadyTasks(state, event.aggregateId, event.occurredAt);
			break;
		case "objective.completed":
			updateObjectiveStatus(state, event.aggregateId, "completed", event.occurredAt);
			cancelOpenObjectiveWork(state, event.aggregateId, event.occurredAt, "objective_completed");
			break;
		case "objective.cancelled": {
			updateObjectiveStatus(state, event.aggregateId, "cancelled", event.occurredAt);
			cancelOpenObjectiveWork(state, event.aggregateId, event.occurredAt, "objective_cancelled");
			break;
		}
		case "task.created": {
			const task = taskFromPayload(event.payload);
			const objective = objectives[task.objectiveId];
			if (!objective) throw new DurableTaskRuntimeError(`Task '${task.taskId}' references an unknown objective.`);
			if (tasks[task.taskId]) throw new DurableTaskRuntimeError(`Task '${task.taskId}' was created more than once.`);
			tasks[task.taskId] = { task, attemptIds: [] };
			objectives[task.objectiveId] = { ...objective, taskIds: [...objective.taskIds, task.taskId] };
			refreshReadyTasks(state, task.objectiveId, event.occurredAt);
			break;
		}
		case "task.ready": {
			const taskId = string(event.payload.taskId, "task.ready.taskId");
			const current = tasks[taskId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
			tasks[taskId] = { ...current, task: { ...current.task, status: "ready", updatedAt: event.occurredAt } };
			break;
		}
		case "task.failed": {
			const taskId = string(event.payload.taskId, "task.failed.taskId");
			const current = tasks[taskId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
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
			const current = tasks[taskId];
			if (!current) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
			const reasonCode = string(event.payload.reasonCode, "task.verification_finished.reasonCode");
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
			if (agents[agent.agentId])
				throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' was registered more than once.`);
			agents[agent.agentId] = agent;
			break;
		}
		case "agent.suspended": {
			const agentId = string(event.payload.agentId, "agent.suspended.agentId");
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			agents[agentId] = { ...agent, status: "suspended", updatedAt: event.occurredAt };
			break;
		}
		case "agent.resume_requested": {
			const agentId = string(event.payload.agentId, "agent.resume_requested.agentId");
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			agents[agentId] = { ...agent, status: "resuming", updatedAt: event.occurredAt };
			break;
		}
		case "agent.resumed": {
			const agentId = string(event.payload.agentId, "agent.resumed.agentId");
			const attemptId = string(event.payload.attemptId, "agent.resumed.attemptId");
			const agent = agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			agents[agentId] = { ...agent, status: "active", activeAttemptId: attemptId, updatedAt: event.occurredAt };
			break;
		}
		case "attempt.queued": {
			const attemptId = string(event.payload.attemptId, "attempt.queued.attemptId");
			const taskId = string(event.payload.taskId, "attempt.queued.taskId");
			const task = tasks[taskId];
			if (!task) throw new DurableTaskRuntimeError(`Attempt '${attemptId}' references an unknown task.`);
			if (attempts[attemptId])
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' was queued more than once.`);
			attempts[attemptId] = {
				attemptId,
				taskId,
				dispatch: structuredClone(
					record(event.payload.dispatch, "attempt.queued.dispatch"),
				) as unknown as OrchestrationDispatchRequest,
				status: "queued",
				...(typeof event.payload.grantId === "string" ? { grantId: event.payload.grantId } : {}),
				checkpointIds: [],
				createdAt: event.occurredAt,
				updatedAt: event.occurredAt,
			};
			tasks[taskId] = {
				...task,
				task: { ...task.task, status: "running", updatedAt: event.occurredAt },
				attemptIds: [...task.attemptIds, attemptId],
			};
			break;
		}
		case "attempt.grant_bound": {
			const attemptId = string(event.payload.attemptId, "attempt.grant_bound.attemptId");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			attempts[attemptId] = {
				...attempt,
				grantId: string(event.payload.grantId, "attempt.grant_bound.grantId"),
				updatedAt: event.occurredAt,
			};
			break;
		}
		case "attempt.leased": {
			const lease = leaseFromPayload(event.payload);
			const attempt = attempts[lease.attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${lease.attemptId}'.`);
			const agentId = typeof event.payload.agentId === "string" ? event.payload.agentId : undefined;
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
			break;
		}
		case "attempt.started": {
			const attemptId = string(event.payload.attemptId, "attempt.started.attemptId");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			attempts[attemptId] = { ...attempt, status: "running", updatedAt: event.occurredAt };
			break;
		}
		case "attempt.checkpointed": {
			const checkpoint = checkpointFromPayload(event.payload);
			const attempt = attempts[checkpoint.attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${checkpoint.attemptId}'.`);
			checkpoints[checkpoint.checkpointId] = checkpoint;
			attempts[checkpoint.attemptId] = {
				...attempt,
				checkpointIds: [...attempt.checkpointIds, checkpoint.checkpointId],
				updatedAt: event.occurredAt,
			};
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) {
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
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			attempts[attemptId] = {
				...attempt,
				status: "suspended",
				...(typeof event.payload.reasonCode === "string" ? { reasonCode: event.payload.reasonCode } : {}),
				updatedAt: event.occurredAt,
			};
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) agents[attempt.agentId] = { ...agent, status: "suspended", updatedAt: event.occurredAt };
			}
			break;
		}
		case "attempt.resumed": {
			const lease = leaseFromPayload(event.payload);
			const agentId = string(event.payload.agentId, "attempt.resumed.agentId");
			const attempt = attempts[lease.attemptId];
			const agent = agents[agentId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${lease.attemptId}'.`);
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			attempts[lease.attemptId] = {
				...attempt,
				status: "leased",
				agentId,
				lease,
				updatedAt: event.occurredAt,
			};
			agents[agentId] = {
				...agent,
				status: "active",
				activeAttemptId: lease.attemptId,
				updatedAt: event.occurredAt,
			};
			break;
		}
		case "attempt.cancelled": {
			const attemptId = string(event.payload.attemptId, "attempt.cancelled.attemptId");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			attempts[attemptId] = {
				...attempt,
				status: "cancelled",
				reasonCode: string(event.payload.reasonCode, "attempt.cancelled.reasonCode"),
				updatedAt: event.occurredAt,
			};
			const task = tasks[attempt.taskId];
			if (task) {
				tasks[attempt.taskId] = {
					...task,
					task: { ...task.task, status: "cancelled", updatedAt: event.occurredAt },
				};
			}
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) {
					const next = { ...agent, status: "registered" as const, updatedAt: event.occurredAt };
					delete next.activeAttemptId;
					agents[attempt.agentId] = next;
				}
			}
			break;
		}
		case "attempt.finished": {
			const result = resultFromPayload(event.payload);
			const attempt = attempts[result.attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${result.attemptId}'.`);
			attempts[result.attemptId] = { ...attempt, status: result.status, result, updatedAt: event.occurredAt };
			const task = tasks[result.taskId];
			if (!task) throw new DurableTaskRuntimeError(`Unknown task '${result.taskId}'.`);
			tasks[result.taskId] = {
				...task,
				task: { ...task.task, status: taskStatusForResult(result.status), updatedAt: event.occurredAt },
			};
			if (attempt.agentId) {
				const agent = agents[attempt.agentId];
				if (agent) {
					const next = { ...agent, status: "registered" as const, updatedAt: event.occurredAt };
					delete next.activeAttemptId;
					agents[attempt.agentId] = next;
				}
			}
			refreshReadyTasks(state, task.task.objectiveId, event.occurredAt);
			break;
		}
		case "attempt.lease_expired": {
			const attemptId = string(event.payload.attemptId, "attempt.lease_expired.attemptId");
			const attempt = attempts[attemptId];
			if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
			attempts[attemptId] = {
				...attempt,
				status: "expired",
				...(typeof event.payload.reasonCode === "string" ? { reasonCode: event.payload.reasonCode } : {}),
				updatedAt: event.occurredAt,
			};
			const task = tasks[attempt.taskId];
			if (task)
				tasks[attempt.taskId] = { ...task, task: { ...task.task, status: "ready", updatedAt: event.occurredAt } };
			break;
		}
		case "approval.requested": {
			const approval = approvalFromPayload(event.payload);
			if (approvals[approval.approvalId]) {
				throw new DurableTaskRuntimeError(`Approval '${approval.approvalId}' was requested more than once.`);
			}
			approvals[approval.approvalId] = { request: approval, status: "pending" };
			const notificationId = `approval-requested:${approval.approvalId}`;
			if (notifications[notificationId]) {
				throw new DurableTaskRuntimeError(`Notification '${notificationId}' already exists.`);
			}
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
			const approval = approvals[resolution.approvalId];
			if (!approval) throw new DurableTaskRuntimeError(`Unknown approval '${resolution.approvalId}'.`);
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
					attempts[attempt.attemptId] = {
						...attempt,
						status: "blocked",
						reasonCode: "approval_rejected",
						updatedAt: event.occurredAt,
					};
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
			notifications[notificationId] = {
				notificationId,
				objectiveId: string(event.payload.objectiveId, "notification.enqueued.objectiveId"),
				...(typeof event.payload.attemptId === "string" ? { attemptId: event.payload.attemptId } : {}),
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
			notifications[notificationId] = { ...notification, status: "delivered", deliveredAt: event.occurredAt };
			break;
		}
	}

	return { ...state, lastOrdinal: event.ordinal };
}

export function projectOrchestrationEvents(events: readonly OrchestrationEvent[]): TaskRuntimeProjection {
	return events.reduce(reduceOrchestrationEvent, emptyProjection());
}

export class DurableTaskRuntime {
	private readonly store: OrchestrationEventStore;
	private readonly now: () => number;
	private readonly createId: () => string;
	private state: TaskRuntimeProjection;

	constructor(options: DurableTaskRuntimeOptions) {
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.state = projectOrchestrationEvents(this.store.readAll());
	}

	getSnapshot(): TaskRuntimeProjection {
		this.refresh();
		return cloneProjection(this.state);
	}

	registerAgent(input: RegisterAgentInput): AgentBindingContract {
		this.refresh();
		const now = this.nowIso();
		let identity: AgentIdentityContract;
		try {
			identity = createAgentIdentity(input.agentId ?? `agent-${this.createId()}`, input.resumeContext);
		} catch (error) {
			throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
		}
		const agent: AgentBindingContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			...identity,
			role: input.role,
			status: "registered",
			createdAt: now,
			updatedAt: now,
		};
		if (this.state.agents[agent.agentId])
			throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' already exists.`);
		this.commit({
			type: "agent.registered",
			aggregateId: agent.agentId,
			actor: "runtime",
			idempotencyKey: `agent-registered:${agent.agentId}`,
			payload: toJsonObject({ agent }),
		});
		return structuredClone(agent);
	}

	createObjective(input: CreateObjectiveInput): ObjectiveContract {
		this.refresh();
		assertRiskBudget(input.riskBudget, "objective.riskBudget");
		const now = this.nowIso();
		const objective: ObjectiveContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			objectiveId: input.objectiveId ?? `objective-${this.createId()}`,
			title: input.title.trim(),
			description: input.description.trim(),
			status: "active",
			constraints: [...(input.constraints ?? [])],
			acceptanceCriteria: structuredClone(input.acceptanceCriteria ?? []),
			riskBudget: { ...(input.riskBudget ?? {}) },
			createdAt: now,
			updatedAt: now,
		};
		if (!objective.title || !objective.description)
			throw new DurableTaskRuntimeError("Objective title and description are required.");
		assertAcceptanceCriteria(objective.acceptanceCriteria);
		if (this.state.objectives[objective.objectiveId]) {
			throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' already exists.`);
		}
		this.commit({
			type: "objective.created",
			aggregateId: objective.objectiveId,
			actor: "kernel",
			idempotencyKey: `objective-created:${objective.objectiveId}`,
			payload: toJsonObject({ objective }),
		});
		return structuredClone(objective);
	}

	/** Create or synchronize owner-authored objective metadata without disturbing lifecycle or task state. */
	ensureObjective(input: CreateObjectiveInput & { objectiveId: string }): ObjectiveContract {
		this.refresh();
		const current = this.state.objectives[input.objectiveId];
		if (!current) return this.createObjective(input);
		assertRiskBudget(input.riskBudget, "objective.riskBudget");
		const acceptanceCriteria = structuredClone(input.acceptanceCriteria ?? []);
		assertAcceptanceCriteria(acceptanceCriteria);
		const nextFields = {
			title: input.title.trim(),
			description: input.description.trim(),
			constraints: [...(input.constraints ?? [])],
			acceptanceCriteria,
			riskBudget: { ...(input.riskBudget ?? {}) },
		};
		if (!nextFields.title || !nextFields.description) {
			throw new DurableTaskRuntimeError("Objective title and description are required.");
		}
		const currentFields = {
			title: current.objective.title,
			description: current.objective.description,
			constraints: current.objective.constraints,
			acceptanceCriteria: current.objective.acceptanceCriteria,
			riskBudget: current.objective.riskBudget,
		};
		if (isDeepStrictEqual(currentFields, nextFields)) return structuredClone(current.objective);

		const retainedCriterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
		const referencedRemovedIds = current.taskIds.flatMap((taskId) =>
			(this.state.tasks[taskId]?.task.acceptanceCriterionIds ?? []).filter(
				(criterionId) => !retainedCriterionIds.has(criterionId),
			),
		);
		if (referencedRemovedIds.length > 0) {
			throw new DurableTaskRuntimeError(
				`Cannot remove acceptance criteria referenced by tasks: ${[...new Set(referencedRemovedIds)].join(", ")}.`,
			);
		}
		const objective: ObjectiveContract = {
			...current.objective,
			...nextFields,
			updatedAt: this.nowIso(),
		};
		this.commit({
			type: "objective.updated",
			aggregateId: objective.objectiveId,
			actor: "kernel",
			payload: toJsonObject({ objective }),
		});
		return structuredClone(objective);
	}

	recordObjectiveEvidence(objectiveId: string, evidence: EvidenceContract): EvidenceContract {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		const existing = objective.evidence.find((candidate) => candidate.evidenceId === evidence.evidenceId);
		if (existing) {
			if (!isDeepStrictEqual(existing, evidence)) {
				throw new DurableTaskRuntimeError(`Objective evidence '${evidence.evidenceId}' has conflicting content.`);
			}
			return structuredClone(existing);
		}
		if (!evidence.evidenceId.trim() || !evidence.summary.trim() || !evidence.createdAt.trim()) {
			throw new DurableTaskRuntimeError("Objective evidence requires an id, summary, and creation time.");
		}
		if (
			evidence.criterionId &&
			!objective.objective.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)
		) {
			throw new DurableTaskRuntimeError(
				`Objective evidence references unknown acceptance criterion '${evidence.criterionId}'.`,
			);
		}
		this.commit({
			type: "objective.evidence_recorded",
			aggregateId: objectiveId,
			actor: "kernel",
			idempotencyKey: `objective-evidence-recorded:${objectiveId}:${evidence.evidenceId}`,
			payload: toJsonObject({ evidence }),
		});
		return structuredClone(evidence);
	}

	createTask(input: CreateTaskInput): TaskContract {
		this.refresh();
		assertRiskBudget(input.riskBudget, "task.riskBudget");
		const objectiveState = this.state.objectives[input.objectiveId];
		if (!objectiveState) throw new DurableTaskRuntimeError(`Unknown objective '${input.objectiveId}'.`);
		if (objectiveState.objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${input.objectiveId}' is not active.`);
		}
		const dependsOn = [...new Set(input.dependsOn ?? [])];
		const acceptanceCriterionIds = [...new Set(input.acceptanceCriterionIds ?? [])];
		const objectiveCriterionIds = new Set(
			objectiveState.objective.acceptanceCriteria.map((criterion) => criterion.id),
		);
		const unknownCriterionIds = acceptanceCriterionIds.filter(
			(criterionId) => !objectiveCriterionIds.has(criterionId),
		);
		if (unknownCriterionIds.length > 0) {
			throw new DurableTaskRuntimeError(
				`Task references unknown acceptance criteria: ${unknownCriterionIds.join(", ")}.`,
			);
		}
		for (const dependencyId of dependsOn) {
			const dependency = this.state.tasks[dependencyId];
			if (!dependency || dependency.task.objectiveId !== input.objectiveId) {
				throw new DurableTaskRuntimeError(
					`Task dependency '${dependencyId}' is not in objective '${input.objectiveId}'.`,
				);
			}
		}
		if (input.verificationOfTaskId) {
			const subject = this.state.tasks[input.verificationOfTaskId];
			if (!subject || subject.task.objectiveId !== input.objectiveId) {
				throw new DurableTaskRuntimeError(
					`Verification subject '${input.verificationOfTaskId}' is not in objective '${input.objectiveId}'.`,
				);
			}
			if (input.role !== "verifier") {
				throw new DurableTaskRuntimeError("Only verifier tasks may declare verificationOfTaskId.");
			}
			if (subject.task.role === "verifier") {
				throw new DurableTaskRuntimeError("A verifier task cannot independently verify another verifier task.");
			}
		}
		const now = this.nowIso();
		const task: TaskContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			taskId: input.taskId ?? `task-${this.createId()}`,
			objectiveId: input.objectiveId,
			title: input.title.trim(),
			description: input.description.trim(),
			role: input.role,
			status: dependsOn.length === 0 ? "ready" : "pending",
			dependsOn,
			requiredCapabilities: [...new Set(input.requiredCapabilities ?? [])],
			acceptanceCriterionIds,
			...(input.verificationOfTaskId ? { verificationOfTaskId: input.verificationOfTaskId } : {}),
			riskBudget: { ...(input.riskBudget ?? {}) },
			createdAt: now,
			updatedAt: now,
		};
		if (!task.title || !task.description)
			throw new DurableTaskRuntimeError("Task title and description are required.");
		if (this.state.tasks[task.taskId]) throw new DurableTaskRuntimeError(`Task '${task.taskId}' already exists.`);
		this.commit({
			type: "task.created",
			aggregateId: task.objectiveId,
			actor: "runtime",
			idempotencyKey: `task-created:${task.taskId}`,
			payload: toJsonObject({ task }),
		});
		return structuredClone(this.state.tasks[task.taskId]!.task);
	}

	queueAttempt(taskId: string, dispatch: OrchestrationDispatchRequest, grantId?: string): AttemptRuntimeState {
		this.refresh();
		const task = this.requireDispatchableTask(taskId);
		const pendingApproval = this.pendingApprovalForTask(taskId);
		if (pendingApproval) {
			throw new DurableTaskRuntimeError(
				`Task '${taskId}' is awaiting approval '${pendingApproval.request.approvalId}'.`,
			);
		}
		if (dispatch.taskId !== taskId) {
			throw new DurableTaskRuntimeError("Dispatch taskId does not match the queued task.");
		}
		if (!dispatch.profileId.trim() || !dispatch.instructions.trim()) {
			throw new DurableTaskRuntimeError("Dispatch profileId and instructions are required.");
		}
		const objective = this.state.objectives[task.task.objectiveId]!.objective;
		const attemptCeilings = [task.task.riskBudget.maxAttempts, objective.riskBudget.maxAttempts].filter(
			(value): value is number => value !== undefined,
		);
		const maxAttempts = attemptCeilings.length > 0 ? Math.min(...attemptCeilings) : undefined;
		if (maxAttempts !== undefined && task.attemptIds.length >= maxAttempts) {
			throw new DurableTaskRuntimeError(`Task '${taskId}' exhausted its ${maxAttempts} attempt budget.`);
		}
		const attemptId = `attempt-${this.createId()}`;
		this.commit({
			type: "attempt.queued",
			aggregateId: taskId,
			actor: "runtime",
			idempotencyKey: `attempt-queued:${attemptId}`,
			payload: toJsonObject({ attemptId, taskId, dispatch, ...(grantId ? { grantId } : {}) }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	bindAttemptGrant(attemptId: string, grantId: string): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		if (!["queued", "leased", "running"].includes(attempt.status)) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot bind a grant from '${attempt.status}'.`);
		}
		if (!grantId.trim()) throw new DurableTaskRuntimeError("Grant id is required.");
		const approval = this.approvalForAttempt(attemptId);
		if (approval?.status === "pending") {
			throw new DurableTaskRuntimeError(
				`Attempt '${attemptId}' is awaiting approval '${approval.request.approvalId}'.`,
			);
		}
		if (approval?.status === "rejected") {
			throw new DurableTaskRuntimeError(`Approval '${approval.request.approvalId}' was rejected.`);
		}
		if (attempt.grantId === grantId) return structuredClone(attempt);
		if (attempt.grantId) throw new DurableTaskRuntimeError(`Attempt '${attemptId}' already has a different grant.`);
		this.commit({
			type: "attempt.grant_bound",
			aggregateId: attemptId,
			actor: "policy",
			idempotencyKey: `attempt-grant-bound:${attemptId}:${grantId}`,
			payload: toJsonObject({ attemptId, grantId }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	leaseAttempt(attemptId: string, ownerId: string, ttlMs: number, agentId?: string): AttemptLease {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		if (attempt.status !== "queued") throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not queued.`);
		this.requireActiveObjectiveForAttempt(attempt);
		const approval = this.approvalForAttempt(attemptId);
		if (approval?.status === "pending") {
			throw new DurableTaskRuntimeError(
				`Attempt '${attemptId}' is awaiting approval '${approval.request.approvalId}'.`,
			);
		}
		if (!attempt.grantId) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' requires an execution grant before leasing.`);
		}
		if (agentId) {
			const agent = this.state.agents[agentId];
			if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
			if (agent.status !== "registered") throw new DurableTaskRuntimeError(`Agent '${agentId}' is not idle.`);
			const task = this.state.tasks[attempt.taskId];
			if (!task || task.task.role !== agent.role)
				throw new DurableTaskRuntimeError(`Agent '${agentId}' role does not match task.`);
		}
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new DurableTaskRuntimeError("Lease TTL must be positive.");
		const issuedAtMs = this.now();
		const lease: AttemptLease = {
			leaseId: `lease-${this.createId()}`,
			attemptId,
			ownerId,
			fencingToken: (attempt.lease?.fencingToken ?? 0) + 1,
			issuedAt: new Date(issuedAtMs).toISOString(),
			expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
		};
		this.commit({
			type: "attempt.leased",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-leased:${lease.leaseId}`,
			payload: toJsonObject({ lease, ...(agentId ? { agentId } : {}) }),
		});
		return structuredClone(lease);
	}

	startAttempt(attemptId: string, leaseId: string, fencingToken: number): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireLiveLease(attemptId, leaseId, fencingToken);
		this.requireActiveObjectiveForAttempt(attempt);
		if (attempt.status !== "leased") throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not leased.`);
		this.commit({
			type: "attempt.started",
			aggregateId: attemptId,
			actor: "worker",
			idempotencyKey: `attempt-started:${attemptId}:${fencingToken}`,
			payload: toJsonObject({ attemptId, leaseId, fencingToken }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	checkpointAttempt(args: {
		attemptId: string;
		leaseId: string;
		fencingToken: number;
		summary: string;
		artifactIds?: readonly string[];
		evidenceIds?: readonly string[];
	}): AttemptCheckpoint {
		this.refresh();
		const attempt = this.requireLiveLease(args.attemptId, args.leaseId, args.fencingToken);
		if (attempt.status !== "running")
			throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' is not running.`);
		const checkpoint: AttemptCheckpoint = {
			checkpointId: `checkpoint-${this.createId()}`,
			attemptId: args.attemptId,
			fencingToken: args.fencingToken,
			summary: args.summary.trim(),
			artifactIds: [...(args.artifactIds ?? [])],
			evidenceIds: [...(args.evidenceIds ?? [])],
			createdAt: this.nowIso(),
		};
		if (!checkpoint.summary) throw new DurableTaskRuntimeError("Checkpoint summary is required.");
		this.commit({
			type: "attempt.checkpointed",
			aggregateId: args.attemptId,
			actor: "worker",
			idempotencyKey: `attempt-checkpointed:${checkpoint.checkpointId}`,
			payload: toJsonObject({ checkpoint, leaseId: args.leaseId }),
		});
		return structuredClone(checkpoint);
	}

	finishAttempt(result: WorkerResultContract): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireLiveLease(result.attemptId, result.leaseId, result.fencingToken);
		if (attempt.status !== "running" && attempt.status !== "leased") {
			throw new DurableTaskRuntimeError(`Attempt '${result.attemptId}' cannot finish from '${attempt.status}'.`);
		}
		if (attempt.taskId !== result.taskId)
			throw new DurableTaskRuntimeError("Worker result taskId does not match attempt.");
		const task = this.state.tasks[attempt.taskId];
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
		this.commit({
			type: "attempt.finished",
			aggregateId: result.attemptId,
			actor: "worker",
			idempotencyKey: `attempt-finished:${result.resultId}`,
			payload: toJsonObject({ result }),
		});
		return structuredClone(this.state.attempts[result.attemptId]!);
	}

	finishVerification(args: {
		taskId: string;
		verifierTaskId: string;
		verifierAttemptId: string;
		verdict: "accepted" | "rejected" | "inconclusive";
		reasonCode: string;
	}): TaskRuntimeState {
		this.refresh();
		const subject = this.state.tasks[args.taskId];
		const verifierTask = this.state.tasks[args.verifierTaskId];
		const verifierAttempt = this.state.attempts[args.verifierAttemptId];
		if (!subject) throw new DurableTaskRuntimeError(`Unknown verification subject '${args.taskId}'.`);
		if (!verifierTask || verifierTask.task.verificationOfTaskId !== args.taskId) {
			throw new DurableTaskRuntimeError(`Task '${args.verifierTaskId}' is not the verifier for '${args.taskId}'.`);
		}
		if (!verifierAttempt || verifierAttempt.taskId !== args.verifierTaskId) {
			throw new DurableTaskRuntimeError(`Unknown verifier attempt '${args.verifierAttemptId}'.`);
		}
		if (args.verdict === "inconclusive") {
			if (
				verifierAttempt.status === "queued" ||
				verifierAttempt.status === "leased" ||
				verifierAttempt.status === "running"
			) {
				throw new DurableTaskRuntimeError(`Verifier attempt '${args.verifierAttemptId}' is not terminal.`);
			}
		} else if (verifierAttempt.status !== "completed" || !verifierAttempt.result) {
			throw new DurableTaskRuntimeError(`Verifier attempt '${args.verifierAttemptId}' is not completed.`);
		}
		if (subject.task.status !== "blocked") {
			throw new DurableTaskRuntimeError(
				`Verification subject '${args.taskId}' cannot reconcile from '${subject.task.status}'.`,
			);
		}
		if (!args.reasonCode.trim()) throw new DurableTaskRuntimeError("Verification reason code is required.");
		if (
			args.verdict === "accepted" &&
			!verifierAttempt.result?.evidence.some(
				(evidence) =>
					evidence.trusted && evidence.kind === "review" && evidence.metadata?.subjectTaskId === args.taskId,
			)
		) {
			throw new DurableTaskRuntimeError(
				"Accepted verification requires trusted review evidence for the subject task.",
			);
		}
		this.commit({
			type: "task.verification_finished",
			aggregateId: args.taskId,
			actor: "runtime",
			idempotencyKey: `task-verification-finished:${args.taskId}:${args.verifierAttemptId}`,
			payload: toJsonObject({ ...args, reasonCode: args.reasonCode.trim() }),
		});
		return structuredClone(this.state.tasks[args.taskId]!);
	}

	cancelAttempt(attemptId: string, reasonCode: string): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		if (terminalAttemptStatus(attempt.status)) return structuredClone(attempt);
		if (!reasonCode.trim()) throw new DurableTaskRuntimeError("Cancellation reason is required.");
		this.commit({
			type: "attempt.cancelled",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-cancelled:${attemptId}`,
			payload: toJsonObject({ attemptId, reasonCode: reasonCode.trim() }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	failTask(taskId: string, reasonCode: string): TaskContract {
		this.refresh();
		const task = this.state.tasks[taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
		if (["completed", "failed", "cancelled"].includes(task.task.status)) return structuredClone(task.task);
		if (!reasonCode.trim()) throw new DurableTaskRuntimeError("Task failure reason is required.");
		this.commit({
			type: "task.failed",
			aggregateId: taskId,
			actor: "runtime",
			idempotencyKey: `task-failed:${taskId}:${reasonCode.trim()}`,
			payload: toJsonObject({ taskId, reasonCode: reasonCode.trim() }),
		});
		return structuredClone(this.state.tasks[taskId]!.task);
	}

	/**
	 * Recover unbound in-process work after a process restart. A completion has no resumable model
	 * transcript, so its old lease is fenced and the task becomes dispatchable for a fresh attempt.
	 * Agent-bound attempts are intentionally excluded: those must wake the same logical agent.
	 */
	recoverInterruptedUnboundAttempts(): string[] {
		this.refresh();
		const recovered: string[] = [];
		for (const attempt of Object.values(this.state.attempts)) {
			if ((attempt.status !== "leased" && attempt.status !== "running") || attempt.agentId) continue;
			this.commit({
				type: "attempt.lease_expired",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				idempotencyKey: `attempt-process-interrupted:${attempt.attemptId}:${attempt.lease?.leaseId ?? "none"}`,
				payload: toJsonObject({
					attemptId: attempt.attemptId,
					...(attempt.lease ? { leaseId: attempt.lease.leaseId, fencingToken: attempt.lease.fencingToken } : {}),
					reasonCode: "worker_process_interrupted",
				}),
			});
			recovered.push(attempt.attemptId);
		}
		return recovered;
	}

	expireLeases(at = this.now()): string[] {
		this.refresh();
		const expired: string[] = [];
		for (const attempt of Object.values(this.state.attempts)) {
			if ((attempt.status !== "leased" && attempt.status !== "running") || !attempt.lease) continue;
			if (Date.parse(attempt.lease.expiresAt) > at) continue;
			this.commit({
				type: attempt.agentId ? "attempt.suspended" : "attempt.lease_expired",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				idempotencyKey: `attempt-lease-expired:${attempt.lease.leaseId}`,
				payload: toJsonObject({
					attemptId: attempt.attemptId,
					leaseId: attempt.lease.leaseId,
					fencingToken: attempt.lease.fencingToken,
				}),
			});
			expired.push(attempt.attemptId);
		}
		return expired;
	}

	requestAgentResume(agentId: string): AgentBindingContract {
		this.refresh();
		const agent = this.state.agents[agentId];
		if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
		if (agent.status !== "suspended") throw new DurableTaskRuntimeError(`Agent '${agentId}' is not suspended.`);
		this.commit({
			type: "agent.resume_requested",
			aggregateId: agentId,
			actor: "runtime",
			idempotencyKey: `agent-resume-requested:${agentId}:${this.state.lastOrdinal}`,
			payload: toJsonObject({ agentId }),
		});
		return structuredClone(this.state.agents[agentId]!);
	}

	resumeAttempt(attemptId: string, agentId: string, ttlMs: number): AttemptLease {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		const agent = this.state.agents[agentId];
		if (attempt.status !== "suspended" || attempt.agentId !== agentId) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not suspended for agent '${agentId}'.`);
		}
		if (!agent || agent.status !== "resuming")
			throw new DurableTaskRuntimeError(`Agent '${agentId}' is not resuming.`);
		this.requireActiveObjectiveForAttempt(attempt);
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new DurableTaskRuntimeError("Lease TTL must be positive.");
		const issuedAtMs = this.now();
		const lease: AttemptLease = {
			leaseId: `lease-${this.createId()}`,
			attemptId,
			ownerId: agentId,
			fencingToken: (attempt.lease?.fencingToken ?? 0) + 1,
			issuedAt: new Date(issuedAtMs).toISOString(),
			expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
		};
		this.commit({
			type: "attempt.resumed",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-resumed:${lease.leaseId}`,
			payload: toJsonObject({ agentId, lease }),
		});
		return structuredClone(lease);
	}

	pauseObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.paused", "paused");
	}

	resumeObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.resumed", "active");
	}

	cancelObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.cancelled", "cancelled");
	}

	completeObjective(objectiveId: string): void {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		const incomplete = objective.taskIds.filter((taskId) => this.state.tasks[taskId]?.task.status !== "completed");
		if (incomplete.length > 0) {
			throw new DurableTaskRuntimeError(
				`Objective '${objectiveId}' has incomplete tasks: ${incomplete.join(", ")}.`,
			);
		}
		const requiredCriterionIds = objective.objective.acceptanceCriteria
			.filter((criterion) => criterion.required)
			.map((criterion) => criterion.id);
		const evidence = [
			...objective.evidence,
			...objective.taskIds.flatMap((taskId) => {
				const task = this.state.tasks[taskId];
				return (
					task?.attemptIds.flatMap((attemptId) => this.state.attempts[attemptId]?.result?.evidence ?? []) ?? []
				);
			}),
		];
		const provenCriterionIds = new Set(
			evidence.flatMap((item) => (item.trusted && item.criterionId ? [item.criterionId] : [])),
		);
		const unproven = requiredCriterionIds.filter((criterionId) => !provenCriterionIds.has(criterionId));
		if (unproven.length > 0) {
			throw new DurableTaskRuntimeError(
				`Objective '${objectiveId}' lacks trusted evidence for required criteria: ${unproven.join(", ")}.`,
			);
		}
		this.transitionObjective(objectiveId, "objective.completed", "completed");
	}

	completeObjectiveFromOwner(objectiveId: string, acceptanceOverride: boolean): void {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		if (objective.objective.status === "completed") return;
		if (objective.objective.status === "cancelled") {
			throw new DurableTaskRuntimeError(`Objective '${objectiveId}' is terminal.`);
		}
		if (!acceptanceOverride) {
			const provenCriterionIds = new Set(
				objective.evidence.flatMap((evidence) =>
					evidence.trusted && evidence.criterionId ? [evidence.criterionId] : [],
				),
			);
			const unproven = objective.objective.acceptanceCriteria
				.filter((criterion) => criterion.required && !provenCriterionIds.has(criterion.id))
				.map((criterion) => criterion.id);
			if (unproven.length > 0) {
				throw new DurableTaskRuntimeError(
					`Objective '${objectiveId}' lacks trusted owner evidence for required criteria: ${unproven.join(", ")}.`,
				);
			}
		}
		this.transitionObjective(objectiveId, "objective.completed", "completed");
	}

	requestApproval(approval: ApprovalRequestContract): ApprovalRuntimeState {
		this.refresh();
		const normalized = approvalFromPayload(toJsonObject({ approval }));
		const existing = this.state.approvals[normalized.approvalId];
		if (existing) {
			if (!isDeepStrictEqual(existing.request, normalized)) {
				throw new DurableTaskRuntimeError(`Approval id '${normalized.approvalId}' has conflicting content.`);
			}
			return structuredClone(existing);
		}
		this.validateApprovalRequest(normalized);
		const pendingForTarget = Object.values(this.state.approvals).find(
			(candidate) =>
				candidate.status === "pending" &&
				candidate.request.objectiveId === normalized.objectiveId &&
				candidate.request.taskId === normalized.taskId &&
				candidate.request.attemptId === normalized.attemptId,
		);
		if (pendingForTarget) {
			throw new DurableTaskRuntimeError(`Target already awaits approval '${pendingForTarget.request.approvalId}'.`);
		}
		this.commit({
			type: "approval.requested",
			aggregateId: normalized.attemptId ?? normalized.taskId ?? normalized.objectiveId,
			actor: "policy",
			idempotencyKey: `approval-requested:${normalized.approvalId}`,
			payload: toJsonObject({ approval: normalized }),
		});
		return structuredClone(this.state.approvals[normalized.approvalId]!);
	}

	resolveApproval(approvalId: string, outcome: ApprovalOutcome, reasonCode: string): ApprovalRuntimeState {
		this.refresh();
		const approval = this.state.approvals[approvalId];
		if (!approval) throw new DurableTaskRuntimeError(`Unknown approval '${approvalId}'.`);
		if (approval.status !== "pending") {
			if (approval.status === outcome) return structuredClone(approval);
			throw new DurableTaskRuntimeError(`Approval '${approvalId}' was already ${approval.status}.`);
		}
		if (outcome !== "approved" && outcome !== "rejected") {
			throw new DurableTaskRuntimeError(`Unknown approval outcome '${String(outcome)}'.`);
		}
		if (!reasonCode.trim()) throw new DurableTaskRuntimeError("Approval resolution reason is required.");
		const resolution: ApprovalResolutionContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			approvalId,
			outcome,
			reasonCode: reasonCode.trim(),
			resolvedAt: this.nowIso(),
		};
		this.commit({
			type: "approval.resolved",
			aggregateId: approval.request.attemptId ?? approval.request.taskId ?? approval.request.objectiveId,
			actor: "human",
			idempotencyKey: `approval-resolved:${approvalId}`,
			payload: toJsonObject({ resolution }),
		});
		return structuredClone(this.state.approvals[approvalId]!);
	}

	enqueueNotification(args: {
		notificationId?: string;
		objectiveId: string;
		attemptId?: string;
		message: string;
	}): NotificationRuntimeState {
		this.refresh();
		this.requireObjective(args.objectiveId);
		const notificationId = args.notificationId ?? `notification-${this.createId()}`;
		const existing = this.state.notifications[notificationId];
		if (existing) return structuredClone(existing);
		this.commit({
			type: "notification.enqueued",
			aggregateId: args.objectiveId,
			actor: "runtime",
			idempotencyKey: `notification-enqueued:${notificationId}`,
			payload: toJsonObject({ ...args, notificationId }),
		});
		return structuredClone(this.state.notifications[notificationId]!);
	}

	markNotificationDelivered(notificationId: string): NotificationRuntimeState {
		this.refresh();
		const notification = this.state.notifications[notificationId];
		if (!notification) throw new DurableTaskRuntimeError(`Unknown notification '${notificationId}'.`);
		if (notification.status === "delivered") return structuredClone(notification);
		this.commit({
			type: "notification.delivered",
			aggregateId: notification.objectiveId,
			actor: "runtime",
			idempotencyKey: `notification-delivered:${notificationId}`,
			payload: toJsonObject({ notificationId }),
		});
		return structuredClone(this.state.notifications[notificationId]!);
	}

	private transitionObjective(
		objectiveId: string,
		type: "objective.paused" | "objective.resumed" | "objective.cancelled" | "objective.completed",
		target: ObjectiveStatus,
	): void {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		if (objective.objective.status === target) return;
		if (["completed", "cancelled"].includes(objective.objective.status)) {
			throw new DurableTaskRuntimeError(`Objective '${objectiveId}' is terminal.`);
		}
		this.commit({
			type,
			aggregateId: objectiveId,
			actor: "human",
			idempotencyKey: `${type}:${objectiveId}:${this.state.lastOrdinal}`,
			payload: {},
		});
	}

	private requireObjective(objectiveId: string): ObjectiveRuntimeState {
		const objective = this.state.objectives[objectiveId];
		if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
		return objective;
	}

	private requireDispatchableTask(taskId: string): TaskRuntimeState {
		const task = this.state.tasks[taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
		const objective = this.requireObjective(task.task.objectiveId);
		if (objective.objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${objective.objective.objectiveId}' is not active.`);
		}
		if (!["ready", "blocked", "failed"].includes(task.task.status)) {
			throw new DurableTaskRuntimeError(`Task '${taskId}' is not dispatchable from '${task.task.status}'.`);
		}
		return task;
	}

	private requireAttempt(attemptId: string): AttemptRuntimeState {
		const attempt = this.state.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		return attempt;
	}

	private approvalForAttempt(attemptId: string): ApprovalRuntimeState | undefined {
		return Object.values(this.state.approvals).find((approval) => approval.request.attemptId === attemptId);
	}

	private pendingApprovalForTask(taskId: string): ApprovalRuntimeState | undefined {
		const task = this.state.tasks[taskId];
		if (!task) return undefined;
		return Object.values(this.state.approvals).find(
			(approval) =>
				approval.status === "pending" &&
				approval.request.attemptId === undefined &&
				approval.request.objectiveId === task.task.objectiveId &&
				(approval.request.taskId === undefined || approval.request.taskId === taskId),
		);
	}

	private requireActiveObjectiveForAttempt(attempt: AttemptRuntimeState): void {
		const task = this.state.tasks[attempt.taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
		const objective = this.requireObjective(task.task.objectiveId).objective;
		if (objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' is not active.`);
		}
	}

	private validateApprovalRequest(approval: ApprovalRequestContract): void {
		const objective = this.requireObjective(approval.objectiveId).objective;
		if (objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${approval.objectiveId}' is not active.`);
		}
		if (approval.attemptId && !approval.taskId) {
			throw new DurableTaskRuntimeError("Attempt-scoped approval requires a taskId.");
		}
		if (approval.taskId) {
			const task = this.state.tasks[approval.taskId];
			if (!task || task.task.objectiveId !== approval.objectiveId) {
				throw new DurableTaskRuntimeError(`Approval task '${approval.taskId}' does not belong to its objective.`);
			}
		}
		if (approval.attemptId) {
			const attempt = this.state.attempts[approval.attemptId];
			if (!attempt || attempt.taskId !== approval.taskId) {
				throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' does not belong to its task.`);
			}
			if (attempt.status !== "queued" || attempt.grantId) {
				throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' is not awaiting policy.`);
			}
		}
	}

	private requireLiveLease(attemptId: string, leaseId: string, fencingToken: number): AttemptRuntimeState {
		const attempt = this.requireAttempt(attemptId);
		if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
		}
		if (Date.parse(attempt.lease.expiresAt) <= this.now()) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease expired.`);
		}
		return attempt;
	}

	private refresh(): void {
		for (const event of this.store.readAfter(this.state.lastOrdinal)) {
			this.state = reduceOrchestrationEvent(this.state, event);
		}
	}

	private commit(input: AppendOrchestrationEventInput): void {
		const event = this.store.append(input, { expectedLastOrdinal: this.state.lastOrdinal });
		if (event.ordinal > this.state.lastOrdinal) this.state = reduceOrchestrationEvent(this.state, event);
	}

	private nowIso(): string {
		return new Date(this.now()).toISOString();
	}
}
