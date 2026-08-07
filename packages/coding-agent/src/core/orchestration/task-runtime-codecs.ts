import type { JsonObject } from "../autonomy/contracts.ts";
import { createAgentIdentity } from "./agent-resume.ts";
import { validateAttemptUsageSnapshot } from "./attempt-usage.ts";
import {
	type AcceptanceCriterion,
	type AgentBindingContract,
	type AgentResumeContext,
	type ApprovalRequestContract,
	type ApprovalResolutionContract,
	ATTEMPT_STATUSES,
	type AttemptCheckpoint,
	type AttemptLease,
	type AttemptRetryState,
	type AttemptStatus,
	type EvidenceContract,
	type ExecutionGrant,
	isHarnessCapability,
	isResourcePointerKind,
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_APPROVALS,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH,
	MAX_ORCHESTRATION_CHECKPOINTS,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	MAX_ORCHESTRATION_NOTIFICATIONS,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_TASKS,
	MAX_WORKER_RESOURCE_PATH_LENGTH,
	MAX_WORKER_RESOURCE_POINTERS,
	OBJECTIVE_STATUSES,
	type ObjectiveContract,
	type ObjectiveStatus,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationDispatchRequest,
	type OrchestrationTaskStatus,
	type ResourcePointer,
	type RiskBudget,
	TASK_STATUSES,
	type TaskContract,
	toJsonObject,
	WORKER_RESULT_STATUSES,
	WORKER_ROLES,
	type WorkerExecutionContract,
	type WorkerResultContract,
} from "./contracts.ts";
import { validateRiskBudget } from "./risk-budget.ts";
import {
	assertRecordWithinLimit,
	assertRetainedProjectionNestedCollections,
	exactRecord,
	PROJECTION_RECORD_FIELDS,
	type ProjectionRecordField,
	projectionSerializedBytes,
	record,
	retainedIdentifierArray,
} from "./task-runtime-projection.ts";
import {
	type ApprovalRuntimeState,
	type AttemptRuntimeState,
	DurableTaskRuntimeError,
	missingTrustedCriteria,
	type NotificationRuntimeState,
	type ObjectiveRuntimeState,
	type TaskRuntimeProjection,
	type TaskRuntimeState,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";
import { normalizeWorkerContextForkReference } from "./worker-context-fork-reference.ts";
import { parseWorkerExecutionContract } from "./worker-execution-contract.ts";

export const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export function projectionFromSnapshot(projection: JsonObject, throughOrdinal: number): TaskRuntimeProjection {
	const label = "orchestration projection snapshot";
	const candidate = exactRecord(projection, label, ["lastOrdinal", ...PROJECTION_RECORD_FIELDS]);
	if (
		!Number.isSafeInteger(candidate.lastOrdinal) ||
		Number(candidate.lastOrdinal) < 0 ||
		candidate.lastOrdinal !== throughOrdinal
	) {
		throw new DurableTaskRuntimeError("Orchestration projection snapshot ordinal does not match its baseline.");
	}
	const snapshotRecords = {} as Record<ProjectionRecordField, Record<string, unknown>>;
	for (const field of PROJECTION_RECORD_FIELDS) {
		snapshotRecords[field] = record(candidate[field], `${label}.${field}`);
	}
	assertRecordWithinLimit(snapshotRecords.agents, MAX_ORCHESTRATION_AGENT_BINDINGS, "agent binding");
	assertRecordWithinLimit(snapshotRecords.objectives, MAX_ORCHESTRATION_OBJECTIVES, "objective");
	assertRecordWithinLimit(snapshotRecords.tasks, MAX_ORCHESTRATION_TASKS, "task");
	assertRecordWithinLimit(snapshotRecords.attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
	assertRecordWithinLimit(snapshotRecords.checkpoints, MAX_ORCHESTRATION_CHECKPOINTS, "checkpoint");
	assertRecordWithinLimit(snapshotRecords.approvals, MAX_ORCHESTRATION_APPROVALS, "approval");
	assertRecordWithinLimit(snapshotRecords.notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
	assertRetainedProjectionNestedCollections(
		snapshotRecords.objectives,
		snapshotRecords.tasks,
		snapshotRecords.attempts,
		snapshotRecords.checkpoints,
		label,
	);
	projectionSerializedBytes(candidate as unknown as TaskRuntimeProjection);
	const normalized: TaskRuntimeProjection = {
		lastOrdinal: throughOrdinal,
		agents: Object.fromEntries(
			Object.entries(snapshotRecords.agents).map(([agentId, value]) => [
				agentId,
				normalizeAgentBinding(value, `${label}.agents.${agentId}`),
			]),
		),
		objectives: Object.fromEntries(
			Object.entries(snapshotRecords.objectives).map(([objectiveId, value]) => [
				objectiveId,
				objectiveRuntimeStateFromValue(value, `${label}.objectives.${objectiveId}`),
			]),
		),
		tasks: Object.fromEntries(
			Object.entries(snapshotRecords.tasks).map(([taskId, value]) => [
				taskId,
				taskRuntimeStateFromValue(value, `${label}.tasks.${taskId}`),
			]),
		),
		attempts: Object.fromEntries(
			Object.entries(snapshotRecords.attempts).map(([attemptId, value]) => [
				attemptId,
				attemptRuntimeStateFromValue(value, `${label}.attempts.${attemptId}`),
			]),
		),
		checkpoints: Object.fromEntries(
			Object.entries(snapshotRecords.checkpoints).map(([checkpointId, value]) => [
				checkpointId,
				checkpointFromValue(value, `${label}.checkpoints.${checkpointId}`),
			]),
		),
		approvals: Object.fromEntries(
			Object.entries(snapshotRecords.approvals).map(([approvalId, value]) => [
				approvalId,
				approvalRuntimeStateFromValue(value, `${label}.approvals.${approvalId}`),
			]),
		),
		notifications: Object.fromEntries(
			Object.entries(snapshotRecords.notifications).map(([notificationId, value]) => [
				notificationId,
				notificationRuntimeStateFromValue(value, `${label}.notifications.${notificationId}`),
			]),
		),
	};
	validateSnapshotTaskGraph(normalized);
	projectionSerializedBytes(normalized);
	return normalized;
}

export function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new DurableTaskRuntimeError(`${label} is required.`);
	return value;
}

export function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

export function assertRiskBudget(budget: RiskBudget | undefined, label: string): void {
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

export function dispatchIdentifier(value: unknown, label: string): string {
	const identifier = string(value, label);
	if (identifier.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	}
	return identifier;
}

function isoDate(value: unknown, label: string): string {
	const date = dispatchIdentifier(value, label);
	const epochMs = Date.parse(date);
	if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_DATE_EPOCH_MS || new Date(epochMs).toISOString() !== date) {
		throw new DurableTaskRuntimeError(`${label} is invalid.`);
	}
	return date;
}

function optionalDispatchIdentifier(
	value: unknown,
	label: string,
	maxLength = MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
): string | undefined {
	if (value === undefined) return undefined;
	const identifier = string(value, label);
	if (identifier.length > maxLength) throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	return identifier;
}

function dispatchInstructions(value: unknown, label: string): string {
	const instructions = string(value, label);
	if (instructions.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	}
	return instructions;
}

function retainedDescription(value: unknown, label: string): string {
	const description = string(value, label).trim();
	if (!description) throw new DurableTaskRuntimeError(`${label} is required.`);
	if (description.length > MAX_ORCHESTRATION_DESCRIPTION_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	}
	return description;
}

export function checkpointSummary(value: unknown, label: string): string {
	const summary = string(value, label).trim();
	if (!summary) throw new DurableTaskRuntimeError(`${label} is required.`);
	if (summary.length > MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	}
	return summary;
}

export function dispatchIdentifierArray(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		!value.every(
			(entry) =>
				typeof entry === "string" && entry.length > 0 && entry.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		)
	) {
		throw new DurableTaskRuntimeError(`${label} must be a bounded identifier array.`);
	}
	if (new Set(value).size !== value.length) {
		throw new DurableTaskRuntimeError(`${label} contains duplicates.`);
	}
	return [...value];
}

/** Validate dependency identity and ownership before any durable task event is appended. */
export function validateTaskDependencyIds(
	tasks: TaskRuntimeProjection["tasks"],
	objectiveId: string,
	value: readonly string[] | undefined,
): string[] {
	const dependencyIds = dispatchIdentifierArray(value ?? [], "task.dependsOn");
	for (const dependencyId of dependencyIds) {
		const dependency = tasks[dependencyId];
		if (!dependency || dependency.task.objectiveId !== objectiveId) {
			throw new DurableTaskRuntimeError(`Task dependency '${dependencyId}' is not in objective '${objectiveId}'.`);
		}
	}
	return dependencyIds;
}

const DISPATCH_FIELDS = new Set([
	"taskId",
	"profileId",
	"instructions",
	"resourcePointerIds",
	"parentAgentId",
	"requirementIds",
	"executionKind",
	"logicalLaneId",
	"dispatchSequence",
	"controlMessageId",
	"provider",
	"authorizationId",
	"worktreeLaneKey",
	"birthContextForkReference",
	"executionContract",
]);

export function dispatchFromValue(value: unknown, label: string): OrchestrationDispatchRequest {
	const dispatch = record(value, label);
	const unsupportedField = Object.keys(dispatch).find((field) => !DISPATCH_FIELDS.has(field));
	if (unsupportedField) throw new DurableTaskRuntimeError(`${label}.${unsupportedField} is unsupported.`);
	const executionKind = dispatch.executionKind;
	if (executionKind !== undefined && executionKind !== "in-process" && executionKind !== "managed-process") {
		throw new DurableTaskRuntimeError(`${label}.executionKind is invalid.`);
	}
	const logicalLaneId = optionalDispatchIdentifier(dispatch.logicalLaneId, `${label}.logicalLaneId`);
	const controlMessageId = optionalDispatchIdentifier(dispatch.controlMessageId, `${label}.controlMessageId`);
	const parentAgentId = optionalDispatchIdentifier(dispatch.parentAgentId, `${label}.parentAgentId`);
	const provider = optionalDispatchIdentifier(
		dispatch.provider,
		`${label}.provider`,
		MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	);
	const authorizationId = optionalDispatchIdentifier(dispatch.authorizationId, `${label}.authorizationId`);
	const worktreeLaneKey = optionalDispatchIdentifier(dispatch.worktreeLaneKey, `${label}.worktreeLaneKey`);
	if (
		dispatch.dispatchSequence !== undefined &&
		(!Number.isSafeInteger(dispatch.dispatchSequence) || Number(dispatch.dispatchSequence) < 1)
	) {
		throw new DurableTaskRuntimeError(`${label}.dispatchSequence is invalid.`);
	}
	let executionContract: WorkerExecutionContract | undefined;
	let birthContextForkReference: OrchestrationDispatchRequest["birthContextForkReference"];
	try {
		executionContract =
			dispatch.executionContract === undefined
				? undefined
				: parseWorkerExecutionContract(dispatch.executionContract);
		birthContextForkReference =
			dispatch.birthContextForkReference === undefined
				? undefined
				: normalizeWorkerContextForkReference(dispatch.birthContextForkReference);
	} catch (error) {
		throw new DurableTaskRuntimeError(
			`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (executionContract && executionKind === "managed-process") {
		throw new DurableTaskRuntimeError(`${label} cannot combine a worker execution contract with managed execution.`);
	}
	return {
		taskId: dispatchIdentifier(dispatch.taskId, `${label}.taskId`),
		profileId: dispatchIdentifier(dispatch.profileId, `${label}.profileId`),
		instructions: dispatchInstructions(dispatch.instructions, `${label}.instructions`),
		resourcePointerIds: dispatchIdentifierArray(dispatch.resourcePointerIds, `${label}.resourcePointerIds`),
		...(parentAgentId ? { parentAgentId } : {}),
		requirementIds:
			dispatch.requirementIds === undefined
				? []
				: dispatchIdentifierArray(dispatch.requirementIds, `${label}.requirementIds`),
		...(executionKind ? { executionKind } : {}),
		...(logicalLaneId ? { logicalLaneId } : {}),
		...(typeof dispatch.dispatchSequence === "number" ? { dispatchSequence: dispatch.dispatchSequence } : {}),
		...(controlMessageId ? { controlMessageId } : {}),
		...(provider ? { provider } : {}),
		...(authorizationId ? { authorizationId } : {}),
		...(worktreeLaneKey ? { worktreeLaneKey } : {}),
		...(birthContextForkReference ? { birthContextForkReference } : {}),
		...(executionContract ? { executionContract } : {}),
	};
}

export function objectiveFromPayload(payload: JsonObject): ObjectiveContract {
	return objectiveFromValue(payload.objective, "objective");
}

export function evidenceFromPayload(payload: JsonObject): EvidenceContract {
	return evidenceFromValue(payload.evidence, "evidence");
}

function objectiveFromValue(value: unknown, label: string): ObjectiveContract {
	const objective = exactRecord(value, label, [
		"schemaVersion",
		"objectiveId",
		"title",
		"description",
		"status",
		"constraints",
		"acceptanceCriteria",
		"riskBudget",
		"createdAt",
		"updatedAt",
	]);
	if (objective.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const status = string(objective.status, `${label}.status`);
	if (!OBJECTIVE_STATUSES.some((candidate) => candidate === status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const constraints = stringArray(objective.constraints, `${label}.constraints`);
	if (
		constraints.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		constraints.some((constraint) => !constraint.trim() || constraint.length > MAX_ORCHESTRATION_DESCRIPTION_LENGTH)
	) {
		throw new DurableTaskRuntimeError(`${label}.constraints must be a bounded description array.`);
	}
	if (!Array.isArray(objective.acceptanceCriteria)) {
		throw new DurableTaskRuntimeError(`${label}.acceptanceCriteria must be an array.`);
	}
	if (objective.acceptanceCriteria.length > MAX_ORCHESTRATION_COLLECTION_LENGTH) {
		throw new DurableTaskRuntimeError(`${label}.acceptanceCriteria exceeds its collection limit.`);
	}
	const acceptanceCriteria = objective.acceptanceCriteria.map((value, index): AcceptanceCriterion => {
		const criterion = exactRecord(value, `${label}.acceptanceCriteria[${index}]`, [
			"id",
			"description",
			"required",
			"evaluator",
		]);
		return {
			id: dispatchIdentifier(criterion.id, `${label}.acceptanceCriteria[${index}].id`),
			description: retainedDescription(criterion.description, `${label}.acceptanceCriteria[${index}].description`),
			required: boolean(criterion.required, `${label}.acceptanceCriteria[${index}].required`),
			...(criterion.evaluator === undefined
				? {}
				: {
						evaluator: dispatchIdentifier(criterion.evaluator, `${label}.acceptanceCriteria[${index}].evaluator`),
					}),
		};
	});
	assertAcceptanceCriteria(acceptanceCriteria);
	const riskBudget = structuredClone(record(objective.riskBudget, `${label}.riskBudget`)) as RiskBudget;
	assertRiskBudget(riskBudget, `${label}.riskBudget`);
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		objectiveId: dispatchIdentifier(objective.objectiveId, `${label}.objectiveId`),
		title: retainedDescription(objective.title, `${label}.title`),
		description: retainedDescription(objective.description, `${label}.description`),
		status: status as ObjectiveStatus,
		constraints,
		acceptanceCriteria,
		riskBudget,
		createdAt: isoDate(objective.createdAt, `${label}.createdAt`),
		updatedAt: isoDate(objective.updatedAt, `${label}.updatedAt`),
	};
}

function evidenceFromValue(value: unknown, label: string): EvidenceContract {
	const evidence = exactRecord(value, label, [
		"evidenceId",
		"criterionId",
		"kind",
		"summary",
		"artifactIds",
		"trusted",
		"createdAt",
		"metadata",
	]);
	const kind = string(evidence.kind, `${label}.kind`);
	if (!["observation", "command", "test", "review", "external"].includes(kind)) {
		throw new DurableTaskRuntimeError(`${label}.kind is invalid.`);
	}
	const metadata =
		evidence.metadata === undefined ? undefined : structuredClone(record(evidence.metadata, `${label}.metadata`));
	return {
		evidenceId: dispatchIdentifier(evidence.evidenceId, `${label}.evidenceId`),
		...(evidence.criterionId === undefined
			? {}
			: { criterionId: dispatchIdentifier(evidence.criterionId, `${label}.criterionId`) }),
		kind: kind as EvidenceContract["kind"],
		summary: retainedDescription(evidence.summary, `${label}.summary`),
		artifactIds: dispatchIdentifierArray(evidence.artifactIds, `${label}.artifactIds`),
		trusted: boolean(evidence.trusted, `${label}.trusted`),
		createdAt: isoDate(evidence.createdAt, `${label}.createdAt`),
		...(metadata ? { metadata: metadata as JsonObject } : {}),
	};
}

function objectiveRuntimeStateFromValue(value: unknown, label: string): ObjectiveRuntimeState {
	const state = exactRecord(value, label, ["objective", "taskIds", "evidence"]);
	const objective = objectiveFromValue(state.objective, `${label}.objective`);
	if (!Array.isArray(state.evidence) || state.evidence.length > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE) {
		throw new DurableTaskRuntimeError(
			`${label}.evidence exceeds its retained collection limit (${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE}).`,
		);
	}
	const evidence = state.evidence.map((item, index) => evidenceFromValue(item, `${label}.evidence[${index}]`));
	const evidenceIds = new Set<string>();
	for (const item of evidence) {
		if (evidenceIds.has(item.evidenceId)) {
			throw new DurableTaskRuntimeError(`${label}.evidence contains duplicate id '${item.evidenceId}'.`);
		}
		evidenceIds.add(item.evidenceId);
		if (item.criterionId && !objective.acceptanceCriteria.some((criterion) => criterion.id === item.criterionId)) {
			throw new DurableTaskRuntimeError(
				`${label}.evidence references unknown acceptance criterion '${item.criterionId}'.`,
			);
		}
	}
	return {
		objective,
		taskIds: retainedIdentifierArray(state.taskIds, MAX_ORCHESTRATION_TASKS, `${label}.taskIds`),
		evidence,
	};
}

export function assertAcceptanceCriteria(criteria: readonly AcceptanceCriterion[]): void {
	const criterionIds = criteria.map((criterion) => criterion.id);
	if (
		criterionIds.some((id) => !id.trim()) ||
		new Set(criterionIds).size !== criterionIds.length ||
		criteria.some((criterion) => !criterion.description.trim())
	) {
		throw new DurableTaskRuntimeError("Objective acceptance criteria require unique ids and descriptions.");
	}
}

export function assertReferencedAcceptanceCriteriaRetained(
	tasks: TaskRuntimeProjection["tasks"],
	current: ObjectiveRuntimeState,
	acceptanceCriteria: readonly AcceptanceCriterion[],
): void {
	const retainedCriterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
	const referencedRemovedIds = current.taskIds.flatMap((taskId) =>
		(tasks[taskId]?.task.acceptanceCriterionIds ?? []).filter(
			(criterionId) => !retainedCriterionIds.has(criterionId),
		),
	);
	if (referencedRemovedIds.length > 0) {
		throw new DurableTaskRuntimeError(
			`Cannot remove acceptance criteria referenced by tasks: ${[...new Set(referencedRemovedIds)].join(", ")}.`,
		);
	}
}

export function taskFromValue(value: unknown, label: string): TaskContract {
	const task = exactRecord(value, label, [
		"schemaVersion",
		"taskId",
		"objectiveId",
		"title",
		"description",
		"role",
		"status",
		"dependsOn",
		"requiredCapabilities",
		"acceptanceCriterionIds",
		"verificationOfTaskId",
		"riskBudget",
		"createdAt",
		"updatedAt",
	]);
	if (task.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const role = string(task.role, `${label}.role`);
	if (!WORKER_ROLES.some((candidate) => candidate === role)) {
		throw new DurableTaskRuntimeError(`${label}.role is invalid.`);
	}
	const status = string(task.status, `${label}.status`);
	if (!TASK_STATUSES.some((candidate) => candidate === status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const requiredCapabilities = stringArray(task.requiredCapabilities, `${label}.requiredCapabilities`);
	if (
		requiredCapabilities.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		new Set(requiredCapabilities).size !== requiredCapabilities.length ||
		!requiredCapabilities.every(isHarnessCapability)
	) {
		throw new DurableTaskRuntimeError(`${label}.requiredCapabilities must be a bounded capability array.`);
	}
	const riskBudget = structuredClone(record(task.riskBudget, `${label}.riskBudget`)) as RiskBudget;
	assertRiskBudget(riskBudget, `${label}.riskBudget`);
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		taskId: dispatchIdentifier(task.taskId, `${label}.taskId`),
		objectiveId: dispatchIdentifier(task.objectiveId, `${label}.objectiveId`),
		title: retainedDescription(task.title, `${label}.title`),
		description: retainedDescription(task.description, `${label}.description`),
		role: role as TaskContract["role"],
		status: status as OrchestrationTaskStatus,
		dependsOn: dispatchIdentifierArray(task.dependsOn, `${label}.dependsOn`),
		requiredCapabilities: requiredCapabilities as TaskContract["requiredCapabilities"],
		acceptanceCriterionIds: dispatchIdentifierArray(task.acceptanceCriterionIds, `${label}.acceptanceCriterionIds`),
		...(task.verificationOfTaskId === undefined
			? {}
			: {
					verificationOfTaskId: dispatchIdentifier(task.verificationOfTaskId, `${label}.verificationOfTaskId`),
				}),
		riskBudget,
		createdAt: isoDate(task.createdAt, `${label}.createdAt`),
		updatedAt: isoDate(task.updatedAt, `${label}.updatedAt`),
	};
}

export function taskFromPayload(payload: JsonObject): TaskContract {
	return taskFromValue(payload.task, "task");
}

function taskRuntimeStateFromValue(value: unknown, label: string): TaskRuntimeState {
	const state = exactRecord(value, label, ["task", "attemptIds", "verification"]);
	let verification: TaskRuntimeState["verification"];
	if (state.verification !== undefined) {
		const record = exactRecord(state.verification, `${label}.verification`, [
			"verifierTaskId",
			"verifierAttemptId",
			"verdict",
			"reasonCode",
			"completedAt",
		]);
		const verdict = string(record.verdict, `${label}.verification.verdict`);
		if (verdict !== "accepted" && verdict !== "rejected" && verdict !== "inconclusive") {
			throw new DurableTaskRuntimeError(`${label}.verification.verdict is invalid.`);
		}
		verification = {
			verifierTaskId: dispatchIdentifier(record.verifierTaskId, `${label}.verification.verifierTaskId`),
			verifierAttemptId: dispatchIdentifier(record.verifierAttemptId, `${label}.verification.verifierAttemptId`),
			verdict,
			reasonCode: dispatchIdentifier(record.reasonCode, `${label}.verification.reasonCode`),
			completedAt: dispatchIdentifier(record.completedAt, `${label}.verification.completedAt`),
		};
	}
	return {
		task: taskFromValue(state.task, `${label}.task`),
		attemptIds: retainedIdentifierArray(state.attemptIds, MAX_ORCHESTRATION_ATTEMPTS, `${label}.attemptIds`),
		...(verification ? { verification } : {}),
	};
}

function resourcePointerFromValue(value: unknown, label: string): ResourcePointer {
	const pointer = exactRecord(value, label, ["id", "kind", "uri", "readOnly", "digest", "metadata"]);
	const kind = string(pointer.kind, `${label}.kind`);
	if (!isResourcePointerKind(kind)) throw new DurableTaskRuntimeError(`${label}.kind is invalid.`);
	const uri = string(pointer.uri, `${label}.uri`);
	if (!uri.trim() || uri.length > MAX_WORKER_RESOURCE_PATH_LENGTH) {
		throw new DurableTaskRuntimeError(`${label}.uri exceeds its durable size bound.`);
	}
	const metadata =
		pointer.metadata === undefined
			? undefined
			: (structuredClone(record(pointer.metadata, `${label}.metadata`)) as JsonObject);
	return {
		id: dispatchIdentifier(pointer.id, `${label}.id`),
		kind,
		uri,
		readOnly: boolean(pointer.readOnly, `${label}.readOnly`),
		...(pointer.digest === undefined ? {} : { digest: dispatchIdentifier(pointer.digest, `${label}.digest`) }),
		...(metadata ? { metadata } : {}),
	};
}

function resourcePointersFromValue(value: unknown, label: string): ResourcePointer[] {
	if (!Array.isArray(value) || value.length > MAX_WORKER_RESOURCE_POINTERS) {
		throw new DurableTaskRuntimeError(`${label} exceeds its retained collection limit.`);
	}
	const pointers = value.map((pointer, index) => resourcePointerFromValue(pointer, `${label}[${index}]`));
	if (new Set(pointers.map((pointer) => pointer.id)).size !== pointers.length) {
		throw new DurableTaskRuntimeError(`${label} contains duplicate ids.`);
	}
	return pointers;
}

export function executionGrantFromValue(value: unknown, label: string): ExecutionGrant {
	const grant = exactRecord(value, label, [
		"schemaVersion",
		"grantId",
		"objectiveId",
		"taskId",
		"attemptId",
		"subjectId",
		"role",
		"capabilities",
		"allowedTools",
		"resources",
		"readPaths",
		"writePaths",
		"deniedPaths",
		"budget",
		"policyVersion",
		"decisionTrace",
		"issuedAt",
		"expiresAt",
	]);
	if (grant.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const role = string(grant.role, `${label}.role`);
	if (!WORKER_ROLES.some((candidate) => candidate === role)) {
		throw new DurableTaskRuntimeError(`${label}.role is invalid.`);
	}
	const capabilities = stringArray(grant.capabilities, `${label}.capabilities`);
	if (
		capabilities.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		new Set(capabilities).size !== capabilities.length ||
		!capabilities.every(isHarnessCapability)
	) {
		throw new DurableTaskRuntimeError(`${label}.capabilities is invalid.`);
	}
	const boundedStrings = (field: "allowedTools" | "readPaths" | "writePaths" | "deniedPaths"): string[] => {
		const values = stringArray(grant[field], `${label}.${field}`);
		if (
			values.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
			new Set(values).size !== values.length ||
			values.some((item) => !item || item.length > MAX_ORCHESTRATION_DESCRIPTION_LENGTH)
		) {
			throw new DurableTaskRuntimeError(`${label}.${field} is invalid.`);
		}
		return values;
	};
	if (!Array.isArray(grant.decisionTrace) || grant.decisionTrace.length > MAX_ORCHESTRATION_COLLECTION_LENGTH) {
		throw new DurableTaskRuntimeError(`${label}.decisionTrace is invalid.`);
	}
	const resources = resourcePointersFromValue(grant.resources, `${label}.resources`);
	const decisionTrace: ExecutionGrant["decisionTrace"] = grant.decisionTrace.map((value, index) => {
		const decision = exactRecord(value, `${label}.decisionTrace[${index}]`, [
			"capability",
			"outcome",
			"reasonCode",
			"source",
		]);
		const capability = string(decision.capability, `${label}.decisionTrace[${index}].capability`);
		if (!isHarnessCapability(capability)) {
			throw new DurableTaskRuntimeError(`${label}.decisionTrace[${index}].capability is invalid.`);
		}
		const outcome = string(decision.outcome, `${label}.decisionTrace[${index}].outcome`);
		if (outcome !== "allow" && outcome !== "deny") {
			throw new DurableTaskRuntimeError(`${label}.decisionTrace[${index}].outcome is invalid.`);
		}
		return {
			capability,
			outcome,
			reasonCode: dispatchIdentifier(decision.reasonCode, `${label}.decisionTrace[${index}].reasonCode`),
			source: retainedDescription(decision.source, `${label}.decisionTrace[${index}].source`),
		};
	});
	const budget = structuredClone(record(grant.budget, `${label}.budget`)) as RiskBudget;
	assertRiskBudget(budget, `${label}.budget`);
	const issuedAt = isoDate(grant.issuedAt, `${label}.issuedAt`);
	const expiresAt = grant.expiresAt === undefined ? undefined : isoDate(grant.expiresAt, `${label}.expiresAt`);
	if (expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
		throw new DurableTaskRuntimeError(`${label}.expiresAt must be after issuedAt.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		grantId: dispatchIdentifier(grant.grantId, `${label}.grantId`),
		objectiveId: dispatchIdentifier(grant.objectiveId, `${label}.objectiveId`),
		taskId: dispatchIdentifier(grant.taskId, `${label}.taskId`),
		attemptId: dispatchIdentifier(grant.attemptId, `${label}.attemptId`),
		subjectId: dispatchIdentifier(grant.subjectId, `${label}.subjectId`),
		role: role as ExecutionGrant["role"],
		capabilities: capabilities as ExecutionGrant["capabilities"],
		allowedTools: boundedStrings("allowedTools"),
		resources,
		readPaths: boundedStrings("readPaths"),
		writePaths: boundedStrings("writePaths"),
		deniedPaths: boundedStrings("deniedPaths"),
		budget,
		policyVersion: dispatchIdentifier(grant.policyVersion, `${label}.policyVersion`),
		decisionTrace,
		issuedAt,
		...(expiresAt ? { expiresAt } : {}),
	};
}

function attemptRuntimeStateFromValue(value: unknown, label: string): AttemptRuntimeState {
	const attempt = exactRecord(value, label, [
		"attemptId",
		"taskId",
		"dispatch",
		"status",
		"reasonCode",
		"grantId",
		"grant",
		"agentId",
		"lease",
		"retry",
		"checkpointIds",
		"result",
		"createdAt",
		"updatedAt",
	]);
	const status = string(attempt.status, `${label}.status`);
	if (!ATTEMPT_STATUSES.some((candidate) => candidate === status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const grant = attempt.grant === undefined ? undefined : executionGrantFromValue(attempt.grant, `${label}.grant`);
	const createdAt = isoDate(attempt.createdAt, `${label}.createdAt`);
	const updatedAt = isoDate(attempt.updatedAt, `${label}.updatedAt`);
	if (Date.parse(updatedAt) < Date.parse(createdAt)) {
		throw new DurableTaskRuntimeError(`${label}.updatedAt is before createdAt.`);
	}
	return {
		attemptId: dispatchIdentifier(attempt.attemptId, `${label}.attemptId`),
		taskId: dispatchIdentifier(attempt.taskId, `${label}.taskId`),
		dispatch: dispatchFromValue(attempt.dispatch, `${label}.dispatch`),
		status: status as AttemptStatus,
		...(attempt.reasonCode === undefined
			? {}
			: { reasonCode: dispatchIdentifier(attempt.reasonCode, `${label}.reasonCode`) }),
		...(attempt.grantId === undefined ? {} : { grantId: dispatchIdentifier(attempt.grantId, `${label}.grantId`) }),
		...(grant ? { grant } : {}),
		...(attempt.agentId === undefined ? {} : { agentId: dispatchIdentifier(attempt.agentId, `${label}.agentId`) }),
		...(attempt.lease === undefined ? {} : { lease: leaseFromPayload(toJsonObject({ lease: attempt.lease })) }),
		...(attempt.retry === undefined ? {} : { retry: retryStateFromValue(attempt.retry, `${label}.retry`) }),
		checkpointIds: retainedIdentifierArray(
			attempt.checkpointIds,
			MAX_ORCHESTRATION_CHECKPOINTS,
			`${label}.checkpointIds`,
		),
		...(attempt.result === undefined ? {} : { result: resultFromValue(attempt.result, `${label}.result`) }),
		createdAt,
		updatedAt,
	};
}

export function leaseFromPayload(payload: JsonObject): AttemptLease {
	return leaseFromValue(payload.lease, "lease");
}

function leaseFromValue(value: unknown, label: string): AttemptLease {
	const lease = exactRecord(value, label, [
		"leaseId",
		"attemptId",
		"ownerId",
		"fencingToken",
		"issuedAt",
		"expiresAt",
	]);
	const fencingToken = number(lease.fencingToken, `${label}.fencingToken`);
	if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
		throw new DurableTaskRuntimeError(`${label}.fencingToken must be a positive safe integer.`);
	}
	const issuedAt = isoDate(lease.issuedAt, `${label}.issuedAt`);
	const expiresAt = isoDate(lease.expiresAt, `${label}.expiresAt`);
	if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
		throw new DurableTaskRuntimeError(`${label}.expiresAt must be after issuedAt.`);
	}
	return {
		leaseId: dispatchIdentifier(lease.leaseId, `${label}.leaseId`),
		attemptId: dispatchIdentifier(lease.attemptId, `${label}.attemptId`),
		ownerId: dispatchIdentifier(lease.ownerId, `${label}.ownerId`),
		fencingToken,
		issuedAt,
		expiresAt,
	};
}

export function retryStateFromValue(value: unknown, label: string): AttemptRetryState {
	const retry = record(value, label);
	const unsupportedField = Object.keys(retry).find((field) => field !== "retriesUsed" && field !== "notBefore");
	if (unsupportedField) throw new DurableTaskRuntimeError(`${label}.${unsupportedField} is unsupported.`);
	const retriesUsed = number(retry.retriesUsed, `${label}.retriesUsed`);
	if (!Number.isSafeInteger(retriesUsed) || retriesUsed < 1) {
		throw new DurableTaskRuntimeError(`${label}.retriesUsed must be a positive safe integer.`);
	}
	const notBefore = string(retry.notBefore, `${label}.notBefore`);
	const notBeforeMs = Date.parse(notBefore);
	if (
		!Number.isFinite(notBeforeMs) ||
		Math.abs(notBeforeMs) > MAX_DATE_EPOCH_MS ||
		new Date(notBeforeMs).toISOString() !== notBefore
	) {
		throw new DurableTaskRuntimeError(`${label}.notBefore is invalid.`);
	}
	return { retriesUsed, notBefore };
}

export function checkpointFromPayload(payload: JsonObject): AttemptCheckpoint {
	return checkpointFromValue(payload.checkpoint, "checkpoint");
}

function checkpointFromValue(value: unknown, label: string): AttemptCheckpoint {
	const checkpoint = exactRecord(value, label, [
		"checkpointId",
		"attemptId",
		"fencingToken",
		"summary",
		"artifactIds",
		"evidenceIds",
		"usage",
		"createdAt",
	]);
	const usage = checkpoint.usage === undefined ? undefined : usageFromPayload(checkpoint.usage, `${label}.usage`);
	const fencingToken = number(checkpoint.fencingToken, `${label}.fencingToken`);
	if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
		throw new DurableTaskRuntimeError(`${label}.fencingToken must be a positive safe integer.`);
	}
	return {
		checkpointId: dispatchIdentifier(checkpoint.checkpointId, `${label}.checkpointId`),
		attemptId: dispatchIdentifier(checkpoint.attemptId, `${label}.attemptId`),
		fencingToken,
		summary: checkpointSummary(checkpoint.summary, `${label}.summary`),
		artifactIds: dispatchIdentifierArray(checkpoint.artifactIds, `${label}.artifactIds`),
		evidenceIds: dispatchIdentifierArray(checkpoint.evidenceIds, `${label}.evidenceIds`),
		...(usage ? { usage } : {}),
		createdAt: isoDate(checkpoint.createdAt, `${label}.createdAt`),
	};
}

export function usageFromPayload(value: unknown, label: string): AttemptCheckpoint["usage"] {
	const usage = record(value, label);
	const expectedFields = [
		"toolCalls",
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"totalTokens",
		"costUsd",
		"activeWallClockMs",
	];
	const unexpected = Object.keys(usage).find((field) => !expectedFields.includes(field));
	if (unexpected) throw new DurableTaskRuntimeError(`${label}.${unexpected} is unsupported.`);
	try {
		return validateAttemptUsageSnapshot(
			{
				toolCalls: number(usage.toolCalls, `${label}.toolCalls`),
				inputTokens: number(usage.inputTokens, `${label}.inputTokens`),
				outputTokens: number(usage.outputTokens, `${label}.outputTokens`),
				cacheReadTokens: number(usage.cacheReadTokens, `${label}.cacheReadTokens`),
				cacheWriteTokens: number(usage.cacheWriteTokens, `${label}.cacheWriteTokens`),
				totalTokens: number(usage.totalTokens, `${label}.totalTokens`),
				costUsd: number(usage.costUsd, `${label}.costUsd`),
				activeWallClockMs: number(usage.activeWallClockMs, `${label}.activeWallClockMs`),
			},
			label,
		);
	} catch (error) {
		throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
	}
}

export function resultFromPayload(payload: JsonObject): WorkerResultContract {
	return resultFromValue(payload.result, "result");
}

function resultFromValue(value: unknown, label: string): WorkerResultContract {
	const result = exactRecord(value, label, [
		"schemaVersion",
		"resultId",
		"objectiveId",
		"taskId",
		"attemptId",
		"leaseId",
		"fencingToken",
		"status",
		"reasonCode",
		"summary",
		"artifacts",
		"evidence",
		"errors",
		"nextAction",
		"usage",
		"createdAt",
	]);
	if (result.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const status = string(result.status, `${label}.status`);
	if (!WORKER_RESULT_STATUSES.some((candidate) => candidate === status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	if (!Array.isArray(result.artifacts) || !Array.isArray(result.evidence) || !Array.isArray(result.errors)) {
		throw new DurableTaskRuntimeError(`${label} collections are invalid.`);
	}
	if (
		result.artifacts.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		result.evidence.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		result.errors.length > MAX_ORCHESTRATION_COLLECTION_LENGTH
	) {
		throw new DurableTaskRuntimeError(`${label} exceeds its collection limit.`);
	}
	const artifacts = result.artifacts.map((value, index) => {
		const artifact = exactRecord(value, `${label}.artifacts[${index}]`, [
			"artifactId",
			"kind",
			"uri",
			"digest",
			"sizeBytes",
			"createdAt",
			"metadata",
		]);
		const kind = string(artifact.kind, `${label}.artifacts[${index}].kind`);
		if (!["diff", "file", "report", "test-result", "log", "structured-data"].includes(kind)) {
			throw new DurableTaskRuntimeError(`${label}.artifacts[${index}].kind is invalid.`);
		}
		if (
			artifact.sizeBytes !== undefined &&
			(!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0)
		) {
			throw new DurableTaskRuntimeError(`${label}.artifacts[${index}].sizeBytes is invalid.`);
		}
		return {
			artifactId: dispatchIdentifier(artifact.artifactId, `${label}.artifacts[${index}].artifactId`),
			kind,
			uri: retainedDescription(artifact.uri, `${label}.artifacts[${index}].uri`),
			...(artifact.digest === undefined
				? {}
				: { digest: dispatchIdentifier(artifact.digest, `${label}.artifacts[${index}].digest`) }),
			...(typeof artifact.sizeBytes === "number" ? { sizeBytes: artifact.sizeBytes } : {}),
			createdAt: dispatchIdentifier(artifact.createdAt, `${label}.artifacts[${index}].createdAt`),
			...(artifact.metadata === undefined
				? {}
				: { metadata: structuredClone(record(artifact.metadata, `${label}.artifacts[${index}].metadata`)) }),
		};
	});
	const errors = result.errors.map((value, index) => {
		const error = exactRecord(value, `${label}.errors[${index}]`, ["code", "message", "retryable", "details"]);
		return {
			code: dispatchIdentifier(error.code, `${label}.errors[${index}].code`),
			message: retainedDescription(error.message, `${label}.errors[${index}].message`),
			retryable: boolean(error.retryable, `${label}.errors[${index}].retryable`),
			...(error.details === undefined
				? {}
				: { details: structuredClone(record(error.details, `${label}.errors[${index}].details`)) }),
		};
	});
	const usage = exactRecord(result.usage, `${label}.usage`, [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"wallClockMs",
		"toolCalls",
	]);
	for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
		if (usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0)) {
			throw new DurableTaskRuntimeError(`${label}.usage.${field} is invalid.`);
		}
	}
	if (!Number.isSafeInteger(usage.toolCalls) || Number(usage.toolCalls) < 0) {
		throw new DurableTaskRuntimeError(`${label}.usage.toolCalls is invalid.`);
	}
	if (
		usage.costUsd !== undefined &&
		(typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)
	) {
		throw new DurableTaskRuntimeError(`${label}.usage.costUsd is invalid.`);
	}
	if (typeof usage.wallClockMs !== "number" || !Number.isFinite(usage.wallClockMs) || usage.wallClockMs < 0) {
		throw new DurableTaskRuntimeError(`${label}.usage.wallClockMs is invalid.`);
	}
	const fencingToken = number(result.fencingToken, `${label}.fencingToken`);
	if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
		throw new DurableTaskRuntimeError(`${label}.fencingToken is invalid.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: dispatchIdentifier(result.resultId, `${label}.resultId`),
		objectiveId: dispatchIdentifier(result.objectiveId, `${label}.objectiveId`),
		taskId: dispatchIdentifier(result.taskId, `${label}.taskId`),
		attemptId: dispatchIdentifier(result.attemptId, `${label}.attemptId`),
		leaseId: dispatchIdentifier(result.leaseId, `${label}.leaseId`),
		fencingToken,
		status: status as WorkerResultContract["status"],
		reasonCode: dispatchIdentifier(result.reasonCode, `${label}.reasonCode`),
		summary: retainedDescription(result.summary, `${label}.summary`),
		artifacts: artifacts as WorkerResultContract["artifacts"],
		evidence: result.evidence.map((item, index) => evidenceFromValue(item, `${label}.evidence[${index}]`)),
		errors: errors as WorkerResultContract["errors"],
		...(result.nextAction === undefined
			? {}
			: { nextAction: retainedDescription(result.nextAction, `${label}.nextAction`) }),
		usage: {
			...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
			...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
			...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
			...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
			wallClockMs: usage.wallClockMs as number,
			toolCalls: usage.toolCalls as number,
		},
		createdAt: isoDate(result.createdAt, `${label}.createdAt`),
	};
}

function normalizeAgentBinding(value: unknown, label: string): AgentBindingContract {
	const agent = exactRecord(value, label, [
		"schemaVersion",
		"agentId",
		"resumeContext",
		"parentAgentId",
		"rootAgentId",
		"depth",
		"role",
		"status",
		"activeAttemptId",
		"createdAt",
		"updatedAt",
	]);
	if (agent.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const agentId = dispatchIdentifier(agent.agentId, `${label}.agentId`);
	const parentAgentId = optionalDispatchIdentifier(agent.parentAgentId, `${label}.parentAgentId`);
	const rootAgentId = dispatchIdentifier(agent.rootAgentId, `${label}.rootAgentId`);
	const depth = number(agent.depth, `${label}.depth`);
	if (!Number.isSafeInteger(depth) || depth < 0) {
		throw new DurableTaskRuntimeError(`${label} lineage is invalid.`);
	}
	if (parentAgentId && depth === 0) throw new DurableTaskRuntimeError(`${label} child lineage depth is invalid.`);
	const role = string(agent.role, `${label}.role`);
	if (!WORKER_ROLES.some((candidate) => candidate === role)) {
		throw new DurableTaskRuntimeError(`${label}.role is invalid.`);
	}
	const status = string(agent.status, `${label}.status`);
	if (!["registered", "active", "suspended", "resuming", "retired"].includes(status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const context = exactRecord(agent.resumeContext, `${label}.resumeContext`, [
		"provider",
		"sessionId",
		"sessionDir",
		"sessionFile",
		"cwd",
		"worktreeLaneKey",
		"orchestrationProfileId",
		"resourceProfileNames",
		"modelRef",
		"contextPointers",
		"latestCheckpointId",
	]);
	const provider = string(context.provider, `${label}.resumeContext.provider`);
	if (provider !== "pi" && provider !== "external") {
		throw new DurableTaskRuntimeError(`${label}.resumeContext.provider is invalid.`);
	}
	const optionalPath = (field: "sessionDir" | "sessionFile"): string | undefined => {
		const candidate = context[field];
		if (candidate === undefined) return undefined;
		const path = string(candidate, `${label}.resumeContext.${field}`);
		if (!path.trim() || path.length > MAX_WORKER_RESOURCE_PATH_LENGTH) {
			throw new DurableTaskRuntimeError(`${label}.resumeContext.${field} exceeds its durable size bound.`);
		}
		return path;
	};
	const cwd = string(context.cwd, `${label}.resumeContext.cwd`);
	if (!cwd.trim() || cwd.length > MAX_WORKER_RESOURCE_PATH_LENGTH) {
		throw new DurableTaskRuntimeError(`${label}.resumeContext.cwd exceeds its durable size bound.`);
	}
	const sessionDir = optionalPath("sessionDir");
	const sessionFile = optionalPath("sessionFile");
	const resumeContext: AgentResumeContext = {
		provider,
		sessionId: dispatchIdentifier(context.sessionId, `${label}.resumeContext.sessionId`),
		...(sessionDir ? { sessionDir } : {}),
		...(sessionFile ? { sessionFile } : {}),
		cwd,
		...(context.worktreeLaneKey === undefined
			? {}
			: {
					worktreeLaneKey: dispatchIdentifier(context.worktreeLaneKey, `${label}.resumeContext.worktreeLaneKey`),
				}),
		...(context.orchestrationProfileId === undefined
			? {}
			: {
					orchestrationProfileId: dispatchIdentifier(
						context.orchestrationProfileId,
						`${label}.resumeContext.orchestrationProfileId`,
					),
				}),
		resourceProfileNames: dispatchIdentifierArray(
			context.resourceProfileNames,
			`${label}.resumeContext.resourceProfileNames`,
		),
		...(context.modelRef === undefined
			? {}
			: { modelRef: dispatchIdentifier(context.modelRef, `${label}.resumeContext.modelRef`) }),
		contextPointers: resourcePointersFromValue(context.contextPointers, `${label}.resumeContext.contextPointers`),
		...(context.latestCheckpointId === undefined
			? {}
			: {
					latestCheckpointId: dispatchIdentifier(
						context.latestCheckpointId,
						`${label}.resumeContext.latestCheckpointId`,
					),
				}),
	};
	try {
		createAgentIdentity(agentId, resumeContext);
	} catch (error) {
		throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
	}
	const createdAt = isoDate(agent.createdAt, `${label}.createdAt`);
	const updatedAt = isoDate(agent.updatedAt, `${label}.updatedAt`);
	if (Date.parse(updatedAt) < Date.parse(createdAt)) {
		throw new DurableTaskRuntimeError(`${label}.updatedAt is before createdAt.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		agentId,
		resumeContext,
		...(parentAgentId ? { parentAgentId } : {}),
		rootAgentId,
		depth,
		role: role as AgentBindingContract["role"],
		status: status as AgentBindingContract["status"],
		...(agent.activeAttemptId === undefined
			? {}
			: { activeAttemptId: dispatchIdentifier(agent.activeAttemptId, `${label}.activeAttemptId`) }),
		createdAt,
		updatedAt,
	};
}

export function agentFromPayload(payload: JsonObject): AgentBindingContract {
	return normalizeAgentBinding(payload.agent, "agent");
}

export function approvalFromPayload(payload: JsonObject): ApprovalRequestContract {
	return approvalFromValue(payload.approval, "approval");
}

function approvalFromValue(value: unknown, label: string): ApprovalRequestContract {
	const approval = exactRecord(value, label, [
		"schemaVersion",
		"approvalId",
		"objectiveId",
		"taskId",
		"attemptId",
		"reasonCode",
		"summary",
		"requestedCapabilities",
		"requestedBudget",
		"reversible",
		"createdAt",
	]);
	const capabilities = stringArray(approval.requestedCapabilities, `${label}.requestedCapabilities`);
	if (
		capabilities.length > MAX_ORCHESTRATION_COLLECTION_LENGTH ||
		new Set(capabilities).size !== capabilities.length ||
		!capabilities.every(isHarnessCapability)
	) {
		throw new DurableTaskRuntimeError(`${label} contains invalid capabilities.`);
	}
	const requestedBudget =
		approval.requestedBudget !== undefined
			? (structuredClone(record(approval.requestedBudget, `${label}.requestedBudget`)) as RiskBudget)
			: undefined;
	assertRiskBudget(requestedBudget, `${label}.requestedBudget`);
	if (capabilities.length === 0 && !requestedBudget) {
		throw new DurableTaskRuntimeError(`${label} must request capabilities or budget.`);
	}
	if (approval.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		approvalId: dispatchIdentifier(approval.approvalId, `${label}.approvalId`),
		objectiveId: dispatchIdentifier(approval.objectiveId, `${label}.objectiveId`),
		...(approval.taskId !== undefined ? { taskId: dispatchIdentifier(approval.taskId, `${label}.taskId`) } : {}),
		...(approval.attemptId !== undefined
			? { attemptId: dispatchIdentifier(approval.attemptId, `${label}.attemptId`) }
			: {}),
		reasonCode: dispatchIdentifier(approval.reasonCode, `${label}.reasonCode`),
		summary: retainedDescription(approval.summary, `${label}.summary`),
		requestedCapabilities: capabilities,
		...(requestedBudget ? { requestedBudget } : {}),
		reversible: boolean(approval.reversible, `${label}.reversible`),
		createdAt: isoDate(approval.createdAt, `${label}.createdAt`),
	};
}

export function approvalResolutionFromPayload(payload: JsonObject): ApprovalResolutionContract {
	return approvalResolutionFromValue(payload.resolution, "resolution");
}

function approvalResolutionFromValue(value: unknown, label: string): ApprovalResolutionContract {
	const resolution = exactRecord(value, label, ["schemaVersion", "approvalId", "outcome", "reasonCode", "resolvedAt"]);
	if (resolution.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new DurableTaskRuntimeError(`${label}.schemaVersion is invalid.`);
	}
	const outcome = string(resolution.outcome, `${label}.outcome`);
	if (outcome !== "approved" && outcome !== "rejected") {
		throw new DurableTaskRuntimeError(`Unknown approval outcome '${outcome}'.`);
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		approvalId: dispatchIdentifier(resolution.approvalId, `${label}.approvalId`),
		outcome,
		reasonCode: dispatchIdentifier(resolution.reasonCode, `${label}.reasonCode`),
		resolvedAt: isoDate(resolution.resolvedAt, `${label}.resolvedAt`),
	};
}

function approvalRuntimeStateFromValue(value: unknown, label: string): ApprovalRuntimeState {
	const state = exactRecord(value, label, ["request", "status", "resolution"]);
	const request = approvalFromValue(state.request, `${label}.request`);
	const status = string(state.status, `${label}.status`);
	if (status !== "pending" && status !== "approved" && status !== "rejected") {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const resolution =
		state.resolution === undefined ? undefined : approvalResolutionFromValue(state.resolution, `${label}.resolution`);
	if (status === "pending" && resolution) {
		throw new DurableTaskRuntimeError(`${label} pending approval cannot have a resolution.`);
	}
	if (
		status !== "pending" &&
		(!resolution || resolution.approvalId !== request.approvalId || resolution.outcome !== status)
	) {
		throw new DurableTaskRuntimeError(`${label} resolution does not match its approval state.`);
	}
	if (resolution && Date.parse(resolution.resolvedAt) < Date.parse(request.createdAt)) {
		throw new DurableTaskRuntimeError(`${label} resolution predates its request.`);
	}
	return { request, status, ...(resolution ? { resolution } : {}) };
}

function notificationRuntimeStateFromValue(value: unknown, label: string): NotificationRuntimeState {
	const notification = exactRecord(value, label, [
		"notificationId",
		"objectiveId",
		"attemptId",
		"status",
		"message",
		"createdAt",
		"deliveredAt",
	]);
	const status = string(notification.status, `${label}.status`);
	if (status !== "pending" && status !== "delivered") {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	const createdAt = isoDate(notification.createdAt, `${label}.createdAt`);
	const deliveredAt =
		notification.deliveredAt === undefined ? undefined : isoDate(notification.deliveredAt, `${label}.deliveredAt`);
	if ((status === "delivered") !== Boolean(deliveredAt)) {
		throw new DurableTaskRuntimeError(`${label} delivery status is inconsistent.`);
	}
	if (deliveredAt && Date.parse(deliveredAt) < Date.parse(createdAt)) {
		throw new DurableTaskRuntimeError(`${label}.deliveredAt predates createdAt.`);
	}
	return {
		notificationId: dispatchIdentifier(notification.notificationId, `${label}.notificationId`),
		objectiveId: dispatchIdentifier(notification.objectiveId, `${label}.objectiveId`),
		...(notification.attemptId === undefined
			? {}
			: { attemptId: dispatchIdentifier(notification.attemptId, `${label}.attemptId`) }),
		status,
		message: retainedDescription(notification.message, `${label}.message`),
		createdAt,
		...(deliveredAt ? { deliveredAt } : {}),
	};
}

function taskDependencyReaches(
	tasks: TaskRuntimeProjection["tasks"],
	startTaskId: string,
	targetTaskId: string,
	visited = new Set<string>(),
): boolean {
	if (startTaskId === targetTaskId) return true;
	if (visited.has(startTaskId)) return false;
	visited.add(startTaskId);
	return (tasks[startTaskId]?.task.dependsOn ?? []).some((dependencyId) =>
		taskDependencyReaches(tasks, dependencyId, targetTaskId, visited),
	);
}

export function validateTaskContractForState(state: TaskRuntimeProjection, task: TaskContract, label: string): void {
	const objective = state.objectives[task.objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`${label} references an unknown objective.`);
	if (task.status !== (task.dependsOn.length === 0 ? "ready" : "pending")) {
		throw new DurableTaskRuntimeError(`${label} initial status does not match its dependencies.`);
	}
	for (const dependencyId of task.dependsOn) {
		if (dependencyId === task.taskId) {
			throw new DurableTaskRuntimeError(`${label} cannot depend on itself.`);
		}
		const dependency = state.tasks[dependencyId];
		if (!dependency || dependency.task.objectiveId !== task.objectiveId) {
			throw new DurableTaskRuntimeError(`${label} dependency '${dependencyId}' is not in its objective.`);
		}
		if (taskDependencyReaches(state.tasks, dependencyId, task.taskId)) {
			throw new DurableTaskRuntimeError(`${label} introduces a dependency cycle.`);
		}
	}
	const criterionIds = new Set(objective.acceptanceCriteria.map((criterion) => criterion.id));
	const unknownCriteria = task.acceptanceCriterionIds.filter((criterionId) => !criterionIds.has(criterionId));
	if (unknownCriteria.length > 0) {
		throw new DurableTaskRuntimeError(
			`${label} references unknown acceptance criteria: ${unknownCriteria.join(", ")}.`,
		);
	}
	if (task.verificationOfTaskId) {
		const subject = state.tasks[task.verificationOfTaskId];
		if (!subject || subject.task.objectiveId !== task.objectiveId) {
			throw new DurableTaskRuntimeError(`${label} verification subject is not in its objective.`);
		}
		if (task.role !== "verifier" || subject.task.role === "verifier") {
			throw new DurableTaskRuntimeError(`${label} has an invalid verification relationship.`);
		}
	}
}

function validateSnapshotTaskGraph(state: TaskRuntimeProjection): void {
	const label = "Orchestration projection snapshot";
	const taskObjectiveOwners = new Map<string, string>();
	for (const [objectiveId, objectiveState] of Object.entries(state.objectives)) {
		if (objectiveState.objective.objectiveId !== objectiveId) {
			throw new DurableTaskRuntimeError(`${label} objective '${objectiveId}' has a mismatched id.`);
		}
		if (Date.parse(objectiveState.objective.updatedAt) < Date.parse(objectiveState.objective.createdAt)) {
			throw new DurableTaskRuntimeError(`${label} objective '${objectiveId}' has invalid lifecycle dates.`);
		}
		for (const taskId of objectiveState.taskIds) {
			const existingOwner = taskObjectiveOwners.get(taskId);
			if (existingOwner) {
				throw new DurableTaskRuntimeError(`${label} task '${taskId}' is listed by multiple objectives.`);
			}
			const task = state.tasks[taskId];
			if (!task || task.task.objectiveId !== objectiveId) {
				throw new DurableTaskRuntimeError(
					`${label} objective '${objectiveId}' lists an unknown or cross-objective task '${taskId}'.`,
				);
			}
			taskObjectiveOwners.set(taskId, objectiveId);
		}
	}

	for (const [taskId, taskState] of Object.entries(state.tasks)) {
		if (taskState.task.taskId !== taskId) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' has a mismatched id.`);
		}
		const objectiveState = state.objectives[taskState.task.objectiveId];
		if (!objectiveState) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' has no objective.`);
		}
		if (taskObjectiveOwners.get(taskId) !== taskState.task.objectiveId) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' is missing from its objective task list.`);
		}
		if (Date.parse(taskState.task.updatedAt) < Date.parse(taskState.task.createdAt)) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' has invalid lifecycle dates.`);
		}
		const criterionIds = new Set(objectiveState.objective.acceptanceCriteria.map((criterion) => criterion.id));
		const unknownCriteria = taskState.task.acceptanceCriterionIds.filter(
			(criterionId) => !criterionIds.has(criterionId),
		);
		if (unknownCriteria.length > 0) {
			throw new DurableTaskRuntimeError(
				`${label} task '${taskId}' references unknown acceptance criteria: ${unknownCriteria.join(", ")}.`,
			);
		}
		for (const dependencyId of taskState.task.dependsOn) {
			if (dependencyId === taskId) {
				throw new DurableTaskRuntimeError(`${label} task graph contains a self-cycle.`);
			}
			const dependency = state.tasks[dependencyId];
			if (!dependency || dependency.task.objectiveId !== taskState.task.objectiveId) {
				throw new DurableTaskRuntimeError(`${label} task '${taskId}' dependency is not in its objective.`);
			}
			if (taskDependencyReaches(state.tasks, dependencyId, taskId)) {
				throw new DurableTaskRuntimeError(`${label} task graph contains a cycle.`);
			}
		}
		if (taskState.task.verificationOfTaskId) {
			const subject = state.tasks[taskState.task.verificationOfTaskId];
			if (
				!subject ||
				subject.task.objectiveId !== taskState.task.objectiveId ||
				taskState.task.role !== "verifier" ||
				subject.task.role === "verifier"
			) {
				throw new DurableTaskRuntimeError(`${label} task '${taskId}' has an invalid verification relationship.`);
			}
		}
	}

	const attemptTaskOwners = new Map<string, string>();
	for (const [taskId, taskState] of Object.entries(state.tasks)) {
		for (const attemptId of taskState.attemptIds) {
			const existingOwner = attemptTaskOwners.get(attemptId);
			if (existingOwner) {
				throw new DurableTaskRuntimeError(
					`Orchestration projection snapshot attempt '${attemptId}' is listed by multiple tasks.`,
				);
			}
			const attempt = state.attempts[attemptId];
			if (!attempt || attempt.taskId !== taskId || attempt.dispatch.taskId !== taskId) {
				throw new DurableTaskRuntimeError(
					`${label} task '${taskId}' lists an unknown or cross-task attempt '${attemptId}'.`,
				);
			}
			attemptTaskOwners.set(attemptId, taskId);
		}
	}
	for (const [attemptId, attempt] of Object.entries(state.attempts)) {
		if (attempt.attemptId !== attemptId) {
			throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' has a mismatched id.`);
		}
		if (attempt.dispatch.taskId !== attempt.taskId) {
			throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' dispatch references a different task.`);
		}
		const task = state.tasks[attempt.taskId];
		if (!task || attemptTaskOwners.get(attemptId) !== attempt.taskId) {
			throw new DurableTaskRuntimeError(
				`${label} attempt '${attemptId}' is missing from its owning task attempt list.`,
			);
		}
		if (attempt.dispatch.executionContract?.worker.profile.role !== undefined) {
			const contract = attempt.dispatch.executionContract;
			if (
				contract.worker.profile.profileId !== attempt.dispatch.profileId ||
				contract.worker.profile.role !== task.task.role
			) {
				throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' execution contract is inconsistent.`);
			}
		}
		if (attempt.lease?.attemptId !== undefined && attempt.lease.attemptId !== attemptId) {
			throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' has a cross-attempt lease.`);
		}
		if (attempt.grant) {
			if (
				attempt.grantId !== attempt.grant.grantId ||
				attempt.grant.attemptId !== attemptId ||
				attempt.grant.taskId !== attempt.taskId ||
				attempt.grant.objectiveId !== task.task.objectiveId ||
				attempt.grant.role !== task.task.role
			) {
				throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' has an inconsistent grant.`);
			}
		}
		if (["leased", "running", "suspended"].includes(attempt.status) && (!attempt.grantId || !attempt.lease)) {
			throw new DurableTaskRuntimeError(`${label} live attempt '${attemptId}' lacks a grant or lease.`);
		}
		if (
			attempt.status === "queued" &&
			(attempt.lease || attempt.agentId || attempt.result || attempt.checkpointIds.length)
		) {
			throw new DurableTaskRuntimeError(`${label} queued attempt '${attemptId}' contains live execution state.`);
		}
		if (
			attempt.retry &&
			(!["suspended", "leased", "running"].includes(attempt.status) || !attempt.agentId || !attempt.lease)
		) {
			throw new DurableTaskRuntimeError(
				`${label} attempt '${attemptId}' retains retry state outside the resumable agent lifecycle.`,
			);
		}
		if (attempt.agentId && !state.agents[attempt.agentId]) {
			throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' references an unknown agent.`);
		}
		if (attempt.result) {
			const result = attempt.result;
			if (
				attempt.status !== result.status ||
				result.attemptId !== attemptId ||
				result.taskId !== attempt.taskId ||
				result.objectiveId !== task.task.objectiveId ||
				!attempt.lease ||
				result.leaseId !== attempt.lease.leaseId ||
				result.fencingToken !== attempt.lease.fencingToken
			) {
				throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' has an inconsistent result.`);
			}
			if (
				result.status === "completed" &&
				missingTrustedCriteria(result, task.task.acceptanceCriterionIds).length > 0
			) {
				throw new DurableTaskRuntimeError(`${label} completed attempt '${attemptId}' lacks trusted evidence.`);
			}
		} else if (["completed", "partial", "failed"].includes(attempt.status)) {
			throw new DurableTaskRuntimeError(`${label} terminal attempt '${attemptId}' lacks its result.`);
		}
	}

	for (const [taskId, task] of Object.entries(state.tasks)) {
		const liveAttempts = task.attemptIds
			.map((attemptId) => state.attempts[attemptId]!)
			.filter((attempt) => !terminalAttemptStatus(attempt.status));
		if (liveAttempts.length > 1) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' owns multiple live attempts.`);
		}
		const liveAttempt = liveAttempts[0];
		if (liveAttempt && ["leased", "running", "suspended"].includes(liveAttempt.status)) {
			if (task.task.status !== "running") {
				throw new DurableTaskRuntimeError(`${label} task '${taskId}' does not reflect its live attempt.`);
			}
		} else if (liveAttempt?.status === "queued" && !["pending", "ready"].includes(task.task.status)) {
			throw new DurableTaskRuntimeError(`${label} queued task '${taskId}' has an invalid status.`);
		} else if (!liveAttempt && task.task.status === "running") {
			throw new DurableTaskRuntimeError(`${label} running task '${taskId}' has no live attempt.`);
		}
	}

	const checkpointAttemptOwners = new Map<string, string>();
	for (const [attemptId, attempt] of Object.entries(state.attempts)) {
		for (const checkpointId of attempt.checkpointIds) {
			if (checkpointAttemptOwners.has(checkpointId)) {
				throw new DurableTaskRuntimeError(`${label} checkpoint '${checkpointId}' is listed by multiple attempts.`);
			}
			const checkpoint = state.checkpoints[checkpointId];
			if (!checkpoint || checkpoint.attemptId !== attemptId) {
				throw new DurableTaskRuntimeError(`${label} attempt '${attemptId}' lists a cross-attempt checkpoint.`);
			}
			checkpointAttemptOwners.set(checkpointId, attemptId);
		}
	}
	for (const [checkpointId, checkpoint] of Object.entries(state.checkpoints)) {
		const attempt = state.attempts[checkpoint.attemptId];
		if (
			checkpoint.checkpointId !== checkpointId ||
			!attempt ||
			checkpointAttemptOwners.get(checkpointId) !== checkpoint.attemptId ||
			!attempt.lease ||
			checkpoint.fencingToken > attempt.lease.fencingToken ||
			Date.parse(checkpoint.createdAt) < Date.parse(attempt.createdAt)
		) {
			throw new DurableTaskRuntimeError(`${label} checkpoint '${checkpointId}' has invalid ownership.`);
		}
	}

	for (const [agentId, agent] of Object.entries(state.agents)) {
		if (agent.agentId !== agentId)
			throw new DurableTaskRuntimeError(`${label} agent '${agentId}' has a mismatched id.`);
		if (agent.parentAgentId) {
			const parent = state.agents[agent.parentAgentId];
			if (!parent || parent.rootAgentId !== agent.rootAgentId || agent.depth !== parent.depth + 1) {
				throw new DurableTaskRuntimeError(`${label} agent '${agentId}' has invalid lineage.`);
			}
		} else if (agent.rootAgentId !== agentId || agent.depth !== 0) {
			throw new DurableTaskRuntimeError(`${label} root agent '${agentId}' has invalid lineage.`);
		}
		const lineage = new Set<string>([agentId]);
		let ancestorId = agent.parentAgentId;
		while (ancestorId) {
			if (lineage.has(ancestorId)) throw new DurableTaskRuntimeError(`${label} agent lineage contains a cycle.`);
			lineage.add(ancestorId);
			ancestorId = state.agents[ancestorId]?.parentAgentId;
		}
		const activeAttempt = agent.activeAttemptId ? state.attempts[agent.activeAttemptId] : undefined;
		if (agent.status === "registered" || agent.status === "retired") {
			if (agent.activeAttemptId)
				throw new DurableTaskRuntimeError(`${label} idle agent '${agentId}' owns an attempt.`);
		} else if (!activeAttempt || activeAttempt.agentId !== agentId) {
			throw new DurableTaskRuntimeError(`${label} active agent '${agentId}' lacks its attempt.`);
		} else if (
			(agent.status === "active" && !["leased", "running"].includes(activeAttempt.status)) ||
			((agent.status === "suspended" || agent.status === "resuming") && activeAttempt.status !== "suspended")
		) {
			throw new DurableTaskRuntimeError(`${label} agent '${agentId}' status conflicts with its attempt.`);
		}
		if (agent.resumeContext.latestCheckpointId) {
			const checkpoint = state.checkpoints[agent.resumeContext.latestCheckpointId];
			const attempt = checkpoint ? state.attempts[checkpoint.attemptId] : undefined;
			if (!checkpoint || attempt?.agentId !== agentId) {
				throw new DurableTaskRuntimeError(`${label} agent '${agentId}' has an unrelated latest checkpoint.`);
			}
		}
	}
	for (const attempt of Object.values(state.attempts)) {
		if (!attempt.agentId || terminalAttemptStatus(attempt.status)) continue;
		const agent = state.agents[attempt.agentId];
		if (
			!agent ||
			agent.activeAttemptId !== attempt.attemptId ||
			(["leased", "running"].includes(attempt.status) && agent.status !== "active") ||
			(attempt.status === "suspended" && agent.status !== "suspended" && agent.status !== "resuming")
		) {
			throw new DurableTaskRuntimeError(
				`${label} attempt '${attempt.attemptId}' has an inconsistent agent binding.`,
			);
		}
	}

	for (const [approvalId, approval] of Object.entries(state.approvals)) {
		const request = approval.request;
		if (request.approvalId !== approvalId || !state.objectives[request.objectiveId]) {
			throw new DurableTaskRuntimeError(`${label} approval '${approvalId}' has invalid ownership.`);
		}
		const task = request.taskId ? state.tasks[request.taskId] : undefined;
		if (
			(request.taskId && task?.task.objectiveId !== request.objectiveId) ||
			(request.attemptId && !request.taskId)
		) {
			throw new DurableTaskRuntimeError(`${label} approval '${approvalId}' has a cross-objective task.`);
		}
		const attempt = request.attemptId ? state.attempts[request.attemptId] : undefined;
		if (request.attemptId && attempt?.taskId !== request.taskId) {
			throw new DurableTaskRuntimeError(`${label} approval '${approvalId}' has a cross-task attempt.`);
		}
		if (approval.status === "pending" && attempt && (attempt.status !== "queued" || attempt.grantId)) {
			throw new DurableTaskRuntimeError(`${label} pending approval '${approvalId}' no longer awaits policy.`);
		}
		const notification = state.notifications[`approval-requested:${approvalId}`];
		if (
			!notification ||
			notification.objectiveId !== request.objectiveId ||
			notification.attemptId !== request.attemptId ||
			notification.message !== request.summary
		) {
			throw new DurableTaskRuntimeError(`${label} approval '${approvalId}' lacks its notification.`);
		}
	}

	for (const [notificationId, notification] of Object.entries(state.notifications)) {
		if (notification.notificationId !== notificationId || !state.objectives[notification.objectiveId]) {
			throw new DurableTaskRuntimeError(`${label} notification '${notificationId}' has invalid ownership.`);
		}
		if (notification.attemptId) {
			const attempt = state.attempts[notification.attemptId];
			const task = attempt ? state.tasks[attempt.taskId] : undefined;
			if (!attempt || task?.task.objectiveId !== notification.objectiveId) {
				throw new DurableTaskRuntimeError(
					`${label} notification '${notificationId}' has a cross-objective attempt.`,
				);
			}
		}
	}

	for (const [taskId, subject] of Object.entries(state.tasks)) {
		const verification = subject.verification;
		if (!verification) continue;
		const verifierTask = state.tasks[verification.verifierTaskId];
		const verifierAttempt = state.attempts[verification.verifierAttemptId];
		if (
			!verifierTask ||
			verifierTask.task.verificationOfTaskId !== taskId ||
			!verifierAttempt ||
			verifierAttempt.taskId !== verification.verifierTaskId ||
			!terminalAttemptStatus(verifierAttempt.status)
		) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' has an invalid verification record.`);
		}
		if (verification.verdict === "accepted" && subject.task.status !== "completed") {
			throw new DurableTaskRuntimeError(`${label} accepted verification for '${taskId}' is not completed.`);
		}
		if (
			verification.verdict !== "inconclusive" &&
			!verifierAttempt.result?.evidence.some(
				(evidence) =>
					evidence.trusted &&
					evidence.kind === "review" &&
					evidence.metadata?.subjectTaskId === taskId &&
					evidence.metadata.verdict === verification.verdict,
			)
		) {
			throw new DurableTaskRuntimeError(`${label} task '${taskId}' verification lacks matching evidence.`);
		}
	}
}
