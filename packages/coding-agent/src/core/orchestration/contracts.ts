import type { JsonObject, JsonValue } from "../autonomy/contracts.ts";

/**
 * Versioned control-plane contracts. These records are the durable truth exchanged between the
 * deterministic kernel/runtime and replaceable execution-plane workers. They deliberately do not
 * contain callbacks, provider objects, tool implementations, or transcript messages.
 */

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;

export const HARNESS_CAPABILITIES = [
	"filesystem.read",
	"filesystem.write",
	"process.exec",
	"network.http",
	"service.mcp",
	"credentials.use",
	"tests.execute",
	"worktree.read",
	"worktree.mutate",
	"memory.query",
	"memory.mutate",
	"workflow.plan",
	"workflow.delegate",
	"policy.modify",
	"learning.propose",
] as const;

export type HarnessCapability = (typeof HARNESS_CAPABILITIES)[number];

export const WORKER_ROLES = [
	"orchestrator",
	"planner",
	"explorer",
	"implementer",
	"operator",
	"verifier",
	"database",
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export type OrchestrationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface OrchestrationModelBinding {
	provider: string;
	modelId: string;
	thinkingLevel: OrchestrationThinkingLevel;
}

export interface OrchestrationModelPolicy {
	mode: "fixed" | "ordered-fallback";
	candidates: readonly OrchestrationModelBinding[];
}

/** Constrained direct-argv launcher policy. This is allowlisting, not OS/container isolation. */
export interface OrchestrationExecutionPolicy {
	allowedExecutables: readonly string[];
	allowedEnvironmentVariables: readonly string[];
	maxOutputBytes: number;
}

export const OBJECTIVE_STATUSES = ["active", "paused", "completed", "cancelled"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const TASK_STATUSES = ["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type OrchestrationTaskStatus = (typeof TASK_STATUSES)[number];

export const ATTEMPT_STATUSES = [
	"queued",
	"leased",
	"running",
	"suspended",
	"completed",
	"partial",
	"blocked",
	"failed",
	"cancelled",
	"expired",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const WORKER_RESULT_STATUSES = ["completed", "partial", "blocked", "failed", "cancelled"] as const;
export type WorkerResultContractStatus = (typeof WORKER_RESULT_STATUSES)[number];

export type AgentBindingStatus = "registered" | "active" | "suspended" | "resuming" | "retired";

export interface AgentResumeContext {
	provider: "pi" | "external";
	sessionId: string;
	sessionDir?: string;
	sessionFile?: string;
	cwd: string;
	worktreeLaneKey?: string;
	orchestrationProfileId?: string;
	resourceProfileNames: readonly string[];
	modelRef?: string;
	contextPointers: readonly ResourcePointer[];
	latestCheckpointId?: string;
}

/** Durable logical identity. A replacement OS process resumes this same binding after interruption. */
export interface AgentBindingContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	agentId: string;
	role: WorkerRole;
	status: AgentBindingStatus;
	resumeContext: AgentResumeContext;
	activeAttemptId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RiskBudget {
	maxTokens?: number;
	maxWallClockMs?: number;
	maxCostUsd?: number;
	maxAttempts?: number;
	maxToolCalls?: number;
	requireApprovalAboveCostUsd?: number;
}

export interface AcceptanceCriterion {
	id: string;
	description: string;
	required: boolean;
	evaluator?: string;
}

export interface ObjectiveContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	objectiveId: string;
	title: string;
	description: string;
	status: ObjectiveStatus;
	constraints: readonly string[];
	acceptanceCriteria: readonly AcceptanceCriterion[];
	riskBudget: RiskBudget;
	createdAt: string;
	updatedAt: string;
}

export interface TaskContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	taskId: string;
	objectiveId: string;
	title: string;
	description: string;
	role: WorkerRole;
	status: OrchestrationTaskStatus;
	dependsOn: readonly string[];
	requiredCapabilities: readonly HarnessCapability[];
	acceptanceCriterionIds: readonly string[];
	/** Implementer task this verifier task must independently reconcile. */
	verificationOfTaskId?: string;
	riskBudget: RiskBudget;
	createdAt: string;
	updatedAt: string;
}

export type ResourcePointerKind =
	| "repository"
	| "worktree"
	| "artifact"
	| "evidence"
	| "memory-query"
	| "skill"
	| "prompt"
	| "service";

export interface ResourcePointer {
	id: string;
	kind: ResourcePointerKind;
	uri: string;
	readOnly: boolean;
	digest?: string;
	metadata?: JsonObject;
}

/** Lightweight metadata catalogued without importing the executable tool module. */
export interface ToolCapabilityManifest {
	toolName: string;
	moduleSpecifier: string;
	capabilities: readonly HarnessCapability[];
	roles: readonly WorkerRole[];
	enforcements: readonly CapabilityEnforcementKind[];
	sourcePath?: string;
}

export interface OrchestrationProfile {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	profileId: string;
	description: string;
	role: WorkerRole;
	modelPolicy: OrchestrationModelPolicy;
	capabilityCeiling: readonly HarnessCapability[];
	toolNames: readonly string[];
	resourceProfileNames: readonly string[];
	/** Worker profiles this orchestrator may dispatch. Empty for non-orchestrator profiles. */
	dispatchProfileIds: readonly string[];
	executionPolicy?: OrchestrationExecutionPolicy;
	budget: RiskBudget;
	maxConcurrent: number;
	leaseTtlMs: number;
	requireIndependentVerification: boolean;
	/** Owner-pinned verifier profile. Required when independent verification is enabled. */
	verificationProfileId?: string;
	/** Resolved origin retained for controlled improvements; omitted from authored JSON. */
	sourcePath?: string;
	createdAt: string;
	updatedAt: string;
}

/** The orchestrator may select only a profile and task; model/thinking fields are intentionally absent. */
export interface OrchestrationDispatchRequest {
	taskId: string;
	profileId: string;
	instructions: string;
	resourcePointerIds: readonly string[];
}

export type CapabilityEnforcementKind =
	| "path-scope"
	| "process-launcher"
	| "service-proxy"
	| "memory-broker"
	| "control-plane";

export interface CapabilityDecision {
	capability: HarnessCapability;
	outcome: "allow" | "deny";
	reasonCode: string;
	source: string;
}

export interface ExecutionGrant {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	grantId: string;
	objectiveId: string;
	taskId: string;
	attemptId: string;
	subjectId: string;
	role: WorkerRole;
	capabilities: readonly HarnessCapability[];
	allowedTools: readonly string[];
	resources: readonly ResourcePointer[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	deniedPaths: readonly string[];
	budget: RiskBudget;
	policyVersion: string;
	decisionTrace: readonly CapabilityDecision[];
	issuedAt: string;
	expiresAt?: string;
}

export interface AttemptLease {
	leaseId: string;
	attemptId: string;
	ownerId: string;
	fencingToken: number;
	issuedAt: string;
	expiresAt: string;
}

export interface AttemptCheckpoint {
	checkpointId: string;
	attemptId: string;
	fencingToken: number;
	summary: string;
	artifactIds: readonly string[];
	evidenceIds: readonly string[];
	createdAt: string;
}

export interface ArtifactContract {
	artifactId: string;
	kind: "diff" | "file" | "report" | "test-result" | "log" | "structured-data";
	uri: string;
	digest?: string;
	sizeBytes?: number;
	createdAt: string;
	metadata?: JsonObject;
}

export interface EvidenceContract {
	evidenceId: string;
	criterionId?: string;
	kind: "observation" | "command" | "test" | "review" | "external";
	summary: string;
	artifactIds: readonly string[];
	trusted: boolean;
	createdAt: string;
	metadata?: JsonObject;
}

export interface WorkerErrorContract {
	code: string;
	message: string;
	retryable: boolean;
	details?: JsonObject;
}

export interface WorkerUsageContract {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	wallClockMs: number;
	toolCalls: number;
}

export interface WorkerResultContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	resultId: string;
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
	status: WorkerResultContractStatus;
	reasonCode: string;
	summary: string;
	artifacts: readonly ArtifactContract[];
	evidence: readonly EvidenceContract[];
	errors: readonly WorkerErrorContract[];
	nextAction?: string;
	usage: WorkerUsageContract;
	createdAt: string;
}

export interface ApprovalRequestContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	approvalId: string;
	objectiveId: string;
	taskId?: string;
	attemptId?: string;
	reasonCode: string;
	summary: string;
	requestedCapabilities: readonly HarnessCapability[];
	requestedBudget?: RiskBudget;
	reversible: boolean;
	createdAt: string;
}

export const APPROVAL_OUTCOMES = ["approved", "rejected"] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** Human decision only. Approval is not an execution grant; policy must compile a new grant afterward. */
export interface ApprovalResolutionContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	approvalId: string;
	outcome: ApprovalOutcome;
	reasonCode: string;
	resolvedAt: string;
}

export const ORCHESTRATION_EVENT_TYPES = [
	"objective.created",
	"objective.paused",
	"objective.resumed",
	"objective.completed",
	"objective.cancelled",
	"task.created",
	"task.ready",
	"task.failed",
	"task.verification_finished",
	"agent.registered",
	"agent.suspended",
	"agent.resume_requested",
	"agent.resumed",
	"attempt.queued",
	"attempt.grant_bound",
	"attempt.leased",
	"attempt.started",
	"attempt.checkpointed",
	"attempt.suspended",
	"attempt.resumed",
	"attempt.cancelled",
	"attempt.finished",
	"attempt.lease_expired",
	"approval.requested",
	"approval.resolved",
	"notification.enqueued",
	"notification.delivered",
] as const;

export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];
export type OrchestrationActorKind = "human" | "kernel" | "runtime" | "policy" | "router" | "worker";

export interface OrchestrationEvent {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	ordinal: number;
	eventId: string;
	type: OrchestrationEventType;
	aggregateId: string;
	actor: OrchestrationActorKind;
	occurredAt: string;
	correlationId?: string;
	causationId?: string;
	idempotencyKey?: string;
	payload: JsonObject;
}

export interface AppendOrchestrationEventInput {
	type: OrchestrationEventType;
	aggregateId: string;
	actor: OrchestrationActorKind;
	correlationId?: string;
	causationId?: string;
	idempotencyKey?: string;
	payload: JsonObject;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > 30) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
	if (!isPlainRecord(value)) return false;
	return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

function includesString<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
	return typeof value === "string" && values.includes(value);
}

export function isHarnessCapability(value: unknown): value is HarnessCapability {
	return includesString(HARNESS_CAPABILITIES, value);
}

/** Clone a runtime value into the persisted JSON domain, rejecting unsupported or over-deep data. */
export function toJsonObject(value: unknown): JsonObject {
	if (!isPlainRecord(value) || !isJsonValue(value)) {
		throw new TypeError("Value is not a valid orchestration JSON object.");
	}
	return structuredClone(value);
}

export function isOrchestrationEvent(value: unknown): value is OrchestrationEvent {
	if (!isPlainRecord(value)) return false;
	return (
		value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION &&
		Number.isSafeInteger(value.ordinal) &&
		Number(value.ordinal) > 0 &&
		isNonEmptyString(value.eventId) &&
		includesString(ORCHESTRATION_EVENT_TYPES, value.type) &&
		isNonEmptyString(value.aggregateId) &&
		includesString(["human", "kernel", "runtime", "policy", "router", "worker"] as const, value.actor) &&
		isNonEmptyString(value.occurredAt) &&
		(value.correlationId === undefined || isNonEmptyString(value.correlationId)) &&
		(value.causationId === undefined || isNonEmptyString(value.causationId)) &&
		(value.idempotencyKey === undefined || isNonEmptyString(value.idempotencyKey)) &&
		isPlainRecord(value.payload) &&
		isJsonValue(value.payload)
	);
}
