import type { HarnessCapability } from "../capability-contract.ts";

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
	capabilities?: readonly HarnessCapability[];
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

export interface CapabilityEnvelope {
	id: string;
	profileId?: string;
	capabilities: readonly HarnessCapability[];
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
	capabilities: readonly HarnessCapability[];
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

export type WorkerClaimStatus = "completed" | "blocked" | "failed" | "cancelled";

export type WorkerClaimOutputFormat = "structured" | "plain_text";

export interface WorkerClaimVerificationDecision {
	subjectTaskId: string;
	verdict: "accepted" | "rejected";
	reasonCodes: readonly string[];
}

/** Untrusted worker-authored report. Only host adjudication can turn this into a durable result. */
export interface WorkerClaim {
	requestId: string;
	/** Host-stamped durable attempt identity for replay-safe claim persistence. */
	terminalAttemptId?: string;
	status: WorkerClaimStatus;
	summary: string;
	outputFormat?: WorkerClaimOutputFormat;
	evidence?: EvidenceBundle;
	changedFiles: readonly string[];
	blockers?: readonly string[];
	usageReportId?: string;
	createdAt?: string;
	/** Stamped at persistence time when validateWorkerClaim's gate flagged this claim
	 * "ask-user"/"parent_review_required" (mutated files or blockers on an otherwise-completed run).
	 * Undefined when not computable because an externally managed lane had no WorkerRequest —
	 * distinct from `false`, which means the gate explicitly cleared it. */
	parentReviewRequired?: boolean;
	/** ISO 8601 timestamp set once the parent explicitly acknowledges an unreviewed mutation via
	 * delegate_status's "review" action. Presence means reviewed; absence keeps the notice sticky.
	 * The ack is durable — re-derived from the latest persisted snapshot, not session-local state. */
	parentReviewedAt?: string;
	/** Typed semantic verdict emitted only by a verifier-profile worker. */
	verification?: WorkerClaimVerificationDecision;
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
