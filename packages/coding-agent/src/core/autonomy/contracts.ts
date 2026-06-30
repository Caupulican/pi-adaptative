export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject {
	[key: string]: JsonValue;
}

export type ModelTier = "cheap" | "medium" | "expensive" | "learning";

export type RouteRisk = "read-only" | "scoped-write" | "high-impact" | "approval-required";

export type OperationRisk = "read-only" | "scoped-write" | "high-impact" | "approval-required";

export interface RiskAssessmentInput {
	operation: string;
	toolName?: string;
	command?: string;
	paths?: readonly string[];
	capabilities?: readonly CapabilityName[];
}

export interface RiskAssessment {
	risk: OperationRisk;
	reasonCode: string;
	reasons: readonly string[];
	requiresApproval: boolean;
}

export type PathScopeDecisionKind = "inside" | "outside" | "denied" | "missing";

export interface PathScope {
	root: string;
	allowedPaths?: readonly string[];
	deniedPaths?: readonly string[];
	followSymlinks?: boolean;
}

export interface PathScopeDecision {
	kind: PathScopeDecisionKind;
	path: string;
	resolvedPath?: string;
	matchedRule?: string;
	reasonCode: string;
}

export interface RouteDecision {
	tier: ModelTier;
	model?: string;
	risk: RouteRisk;
	confidence: number;
	reasonCode: string;
	reasons: readonly string[];
	fallbackFrom?: ModelTier;
	createdAt?: string;
}

export type CapabilityName =
	| "read_files"
	| "write_files"
	| "run_shell"
	| "network"
	| "memory_read"
	| "memory_write"
	| "settings_read"
	| "settings_write"
	| "skill_read"
	| "skill_write"
	| "source_read"
	| "source_write"
	| "research"
	| "delegate"
	| "publish"
	| "auth_change";

export interface CapabilityEnvelope {
	id: string;
	profileId?: string;
	capabilities: readonly CapabilityName[];
	allowedTools?: readonly string[];
	deniedTools?: readonly string[];
	allowedPaths?: readonly string[];
	deniedPaths?: readonly string[];
	maxEstimatedUsd?: number;
	createdAt?: string;
}

export type GateOutcomeKind = "allow" | "downgrade" | "escalate" | "ask-user" | "block";

export interface GateOutcome {
	outcome: GateOutcomeKind;
	gate: string;
	reasonCode: string;
	message?: string;
	reversible?: boolean;
	details?: JsonObject;
}

export interface ApprovalRequest {
	id: string;
	operation: string;
	target: string;
	reversible: boolean;
	capabilities: readonly CapabilityName[];
	reasonCode: string;
	createdAt?: string;
}

export type EvidenceSourceKind = "workspace" | "transcript" | "automata" | "web" | "user" | "tool";

export interface EvidenceRef {
	id: string;
	kind: EvidenceSourceKind;
	title?: string;
	uri?: string;
	trusted: boolean;
	excerpt?: string;
	metadata?: JsonObject;
}

export interface Finding {
	id: string;
	summary: string;
	evidenceIds: readonly string[];
	confidence?: number;
}

export interface EvidenceBundle {
	query: string;
	sources: readonly EvidenceRef[];
	findings: readonly Finding[];
	createdAt?: string;
}

export interface WorkerRequest {
	id: string;
	instructions: string;
	route: RouteDecision;
	envelope: CapabilityEnvelope;
	evidence?: EvidenceBundle;
	maxEstimatedUsd?: number;
	createdAt?: string;
}

export type WorkerResultStatus = "completed" | "blocked" | "failed" | "cancelled";

export interface WorkerResult {
	requestId: string;
	status: WorkerResultStatus;
	summary: string;
	evidence?: EvidenceBundle;
	changedFiles: readonly string[];
	blockers?: readonly string[];
	usageReportId?: string;
	createdAt?: string;
}

export type LearningDecisionKind = "no-op" | "proposal" | "apply";

export interface LearningDecision {
	kind: LearningDecisionKind;
	reasonCode: string;
	confidence: number;
	summary: string;
	requiresApproval: boolean;
	createdAt?: string;
}
