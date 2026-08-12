import type { JsonObject, JsonValue } from "../autonomy/contracts.ts";
import { HARNESS_CAPABILITIES, type HarnessCapability } from "../capability-contract.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { WorkerContextForkReference } from "./worker-context-fork-reference.ts";

export { HARNESS_CAPABILITIES, type HarnessCapability } from "../capability-contract.ts";

/**
 * Versioned control-plane contracts. These records are the durable truth exchanged between the
 * deterministic kernel/runtime and replaceable execution-plane workers. They deliberately do not
 * contain callbacks, provider objects, tool implementations, or transcript messages.
 */

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;

/** Shared durable-control bounds. Keep persisted orchestration records small enough to replay safely. */
export const MAX_ORCHESTRATION_IDENTIFIER_LENGTH = 512;
export const MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH = 128;
export const MAX_ORCHESTRATION_MODEL_ID_LENGTH = 512;
export const MAX_ORCHESTRATION_DESCRIPTION_LENGTH = 4 * 1024;
export const MAX_ORCHESTRATION_COLLECTION_LENGTH = 64;
export const MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH = 16 * 1024;
/**
 * Lifetime ceilings for the retained hot projection. Terminal records are intentionally retained,
 * so these limits match the durable worker-fleet ceiling rather than only counting active work.
 */
export const MAX_ORCHESTRATION_AGENT_BINDINGS = 256;
export const MAX_ORCHESTRATION_OBJECTIVES = 256;
export const MAX_ORCHESTRATION_TASKS = 256;
export const MAX_ORCHESTRATION_ATTEMPTS = 256;
export const MAX_ORCHESTRATION_CHECKPOINTS = 4_096;
export const MAX_ORCHESTRATION_APPROVALS = 256;
/** Approval prompts and terminal handoffs may each retain one notification per attempt. */
export const MAX_ORCHESTRATION_NOTIFICATIONS = 512;
/** Source goal state admits at most 512 evidence entries for one objective. */
export const MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE = 512;
export const MAX_ORCHESTRATION_EVIDENCE = 4_096;
export const MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH = 4 * 1024;
/** Absolute durable lineage bound enforced even when a profile requests broader recursion. */
export const MAX_ORCHESTRATION_AGENT_DEPTH = 8;
/** Retained direct-child identity bound enforced even when a profile requests broader fan-out. */
export const MAX_ORCHESTRATION_DIRECT_CHILDREN = 64;
/** One changed retained map value; aggregate projection accounting remains the authoritative ceiling. */
export const MAX_ORCHESTRATION_RETAINED_RECORD_BYTES = 1024 * 1024;
/** Leaves room for bounded idempotency evidence and the snapshot envelope below the on-disk ceiling. */
export const MAX_ORCHESTRATION_PROJECTION_BYTES = 24 * 1024 * 1024;
export const MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES = 4 * 1024 * 1024;
export const MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Matches the bounded worker/process result contract retained by the execution plane. */
export const MAX_ORCHESTRATION_PROCESS_OUTPUT_BYTES = 512 * 1024;
export const MAX_WORKER_AUTHORITY_PATHS = 64;
export const MAX_WORKER_AUTHORITY_PATH_LENGTH = 4 * 1024;
export const MAX_WORKER_SOUL_LENGTH = 16 * 1024;

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

export const ORCHESTRATION_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;
export type OrchestrationThinkingLevel = (typeof ORCHESTRATION_THINKING_LEVELS)[number];

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

/** Outbound recursive delegation authority retained with an immutable worker profile snapshot. */
export interface OrchestrationDelegationLimits {
	/** Greatest absolute AgentBindingContract.depth that this worker may create. */
	maxDepth: number;
	/** Greatest number of retained direct child identities that this worker may create. */
	maxChildrenPerAgent: number;
	/** Greatest number of retained non-root identities across this durable session. */
	maxNestedAgentsPerSession?: number;
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

/** Provider-neutral logical identity shared by durable orchestration and process supervision. */
export interface AgentIdentityContract {
	agentId: string;
	resumeContext: AgentResumeContext;
}

/** Durable logical identity. A replacement OS process resumes this same binding after interruption. */
export interface AgentBindingContract extends AgentIdentityContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	/** Direct creator in the durable orchestration tree. Root agents omit this field. */
	parentAgentId?: string;
	/** Stable root identity retained across bounded recursive delegation depth. */
	rootAgentId: string;
	/** Durable lineage depth. Fleet admission enforces the host-configured depth ceiling. */
	depth: number;
	role: WorkerRole;
	status: AgentBindingStatus;
	activeAttemptId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RiskBudget {
	/**
	 * Budget-counted tokens, not raw provider totals: input/output/cache-write tokens charge at
	 * face value, prompt-cache reads at CACHE_READ_BUDGET_WEIGHT (see capability-gateway.ts).
	 * Charging cache reads fully would turn this into a request counter, since every request
	 * re-reads the fixed system prompt.
	 */
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

export const RESOURCE_POINTER_KINDS = [
	"repository",
	"worktree",
	"artifact",
	"evidence",
	"memory-query",
	"skill",
	"prompt",
	"service",
] as const;
export type ResourcePointerKind = (typeof RESOURCE_POINTER_KINDS)[number];

export function isResourcePointerKind(value: unknown): value is ResourcePointerKind {
	return RESOURCE_POINTER_KINDS.some((kind) => kind === value);
}

export interface ResourcePointer {
	id: string;
	kind: ResourcePointerKind;
	uri: string;
	readOnly: boolean;
	digest?: string;
	metadata?: JsonObject;
}

/** Bounded metadata-only resources retained in one worker execution contract. */
export const MAX_WORKER_RESOURCE_POINTERS = 64;
export const MAX_WORKER_RESOURCE_PATH_LENGTH = 4096;
export const MAX_WORKER_RESOURCE_METADATA_NAME_LENGTH = 256;

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
	/** Optional preset-routing metadata retained for authored profiles; never an admission allowlist. */
	dispatchProfileIds: readonly string[];
	executionPolicy?: OrchestrationExecutionPolicy;
	/** Omitted authored profiles use the host ceiling; adaptive profiles carry a lean explicit limit. */
	delegationLimits?: OrchestrationDelegationLimits;
	budget: RiskBudget;
	/** Authored scheduling hint retained in the snapshot; the global scheduler owns actual concurrency. */
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

/** Admission-time worker profile materialization. Profile files are never consulted after this is persisted. */
export interface WorkerProfileExecutionContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	profile: OrchestrationProfile;
	modelBinding: OrchestrationModelBinding;
	authority: WorkerExecutionAuthorityContract;
	/** Metadata-only resources fixed at admission; their content remains lazy and non-durable. */
	resourcePointers: readonly ResourcePointer[];
	/** Resolved resource-profile identity text. Other worker resources are represented by profile tools. */
	soul?: string;
}

/** Effective authority admitted for one materialized worker profile. */
export interface WorkerExecutionAuthorityContract {
	capabilities: readonly HarnessCapability[];
	toolNames: readonly string[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	deniedPaths: readonly string[];
	budget: RiskBudget;
}

/** Immutable execution contract owned by the runtime, including any mandatory verifier. */
export interface WorkerExecutionContract {
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	worker: WorkerProfileExecutionContract;
	verifier?: WorkerProfileExecutionContract;
}

/** Durable dispatch metadata. Model/tool choices are retained in the runtime-owned executionContract. */
export interface OrchestrationDispatchRequest {
	taskId: string;
	profileId: string;
	instructions: string;
	resourcePointerIds: readonly string[];
	/** Direct logical-agent creator for recursively delegated in-process work. */
	parentAgentId?: string;
	/** Runtime-owned goal/task correlation. Omitted by legacy records and normalized to an empty list. */
	requirementIds?: readonly string[];
	/** Execution owner. Omitted on legacy records and normalized to in-process. */
	executionKind?: "in-process" | "managed-process";
	/** Stable external lane identity shared by successive managed-process turns. */
	logicalLaneId?: string;
	/** Monotonic dispatch sequence within a managed-process logical lane. */
	dispatchSequence?: number;
	/** Durable mailbox message whose task-bearing intent owns this logical-agent turn. */
	controlMessageId?: string;
	/** External provider identity retained for routing and diagnostics. */
	provider?: string;
	/** Owner approval or standing-grant record that authorized an external launch. */
	authorizationId?: string;
	/** Worktree-sync lane claimed by the external dispatcher. */
	worktreeLaneKey?: string;
	/** Immutable sanitized parent context captured for this persistent logical worker at birth. */
	birthContextForkReference?: WorkerContextForkReference;
	/** Runtime-owned immutable worker materialization. Never accepted from a model tool call. */
	executionContract?: WorkerExecutionContract;
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

/** Restart-durable host retry ladder state for one resumable worker attempt. */
export interface AttemptRetryState {
	/** Scheduled retries already consumed; the initial execution is not included. */
	retriesUsed: number;
	/** Earliest instant at which the suspended attempt may receive a fresh lease. */
	notBefore: string;
}

/** Complete cumulative active usage for one execution attempt. Restart downtime is never included. */
export interface AttemptUsageSnapshot {
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Provider-authoritative total; detail categories are not assumed to be additive. */
	totalTokens: number;
	costUsd: number;
	activeWallClockMs: number;
}

export interface AttemptCheckpoint {
	checkpointId: string;
	attemptId: string;
	fencingToken: number;
	summary: string;
	artifactIds: readonly string[];
	evidenceIds: readonly string[];
	/** Omitted only by legacy checkpoints created before durable usage accounting existed. */
	usage?: AttemptUsageSnapshot;
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
	"objective.updated",
	"objective.evidence_recorded",
	"objective.paused",
	"objective.resumed",
	"objective.completed",
	"objective.cancelled",
	"task.created",
	"task.attempt_prepared",
	"task.ready",
	"task.failed",
	"task.verification_finished",
	"agent.registered",
	"agent.retired",
	"agent.suspended",
	"agent.resume_requested",
	"agent.resumed",
	"attempt.queued",
	"attempt.grant_bound",
	"attempt.leased",
	"attempt.started",
	"attempt.lease_renewed",
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
