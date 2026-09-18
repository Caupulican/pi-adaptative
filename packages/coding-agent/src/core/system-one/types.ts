/**
 * Pi Adaptive System One types.
 * Pure erasable TypeScript definitions representing the authoritative ExecutionState,
 * worker turns, question packs, validation decisions, and policy structures.
 * Normative reference: URN urn:pi-adaptive:system-one:execution-state:1.0
 */

export type Phase =
	| "init"
	| "discovery"
	| "planning"
	| "executing"
	| "verifying"
	| "replan_required"
	| "rollback_required"
	| "blocked_external"
	| "completion_candidate"
	| "complete"
	| "aborted";

export type ToolImpact = "read_only" | "local_reversible" | "repo_mutation" | "external_side_effect" | "destructive";

export type SourceTrust = "authoritative" | "repository_untrusted_text" | "external_untrusted_text";

export type SourceKind =
	| "file"
	| "symbol"
	| "tool_output"
	| "test"
	| "build"
	| "log"
	| "user"
	| "external_doc"
	| "repo_metadata";

export interface SourceRef {
	kind: SourceKind;
	locator: string;
	content_hash: string;
	revision?: string | null;
	line_start?: number | null;
	line_end?: number | null;
	trust: SourceTrust;
}

export type AcceptanceCriterionStatus = "unverified" | "satisfied" | "failed" | "waived";

export interface SystemOneAcceptanceCriterion {
	id: string;
	text: string;
	required: boolean;
	status: AcceptanceCriterionStatus;
	evidence_ids: string[];
	waiver_id?: string | null;
}

export type AcceptanceCriterion = SystemOneAcceptanceCriterion;

export type ConstraintSeverity = "hard" | "soft";
export type ConstraintSource = "user" | "repo_policy" | "harness" | "security" | "derived";

export interface Constraint {
	id: string;
	text: string;
	severity: ConstraintSeverity;
	source: ConstraintSource;
	verified: boolean;
}

export interface Objective {
	request: string;
	normalized_goal: string;
	acceptance_criteria: AcceptanceCriterion[];
	constraints: Constraint[];
	non_goals: string[];
}

export interface RepoState {
	root: string;
	baseline_revision: string;
	current_revision: string;
	dirty_at_start: boolean;
	allowed_paths: string[];
	protected_paths: string[];
	languages?: string[];
}

export type ObservationFreshness = "fresh" | "stale" | "invalidated";
export type ObservationStatus = "observed" | "superseded";

export interface Observation {
	id: string;
	text: string;
	source: SourceRef;
	freshness: ObservationFreshness;
	status: ObservationStatus;
	tags?: string[];
}

export type ClaimMateriality = "informational" | "material" | "completion_critical";
export type ClaimStatus = "proposed" | "supported" | "partially_supported" | "contradicted" | "unverified" | "retired";

export interface Claim {
	id: string;
	text: string;
	materiality: ClaimMateriality;
	status: ClaimStatus;
	evidence_ids: string[];
	decision_ids?: string[];
}

export type HypothesisStatus = "candidate" | "investigating" | "supported" | "rejected" | "superseded";

export interface Hypothesis {
	id: string;
	text: string;
	status: HypothesisStatus;
	supporting_evidence: string[];
	contradicting_evidence: string[];
	next_discriminator?: string | null;
	parent_hypothesis_id?: string | null;
}

export type PlanActionClass =
	| "inspect"
	| "retrieve"
	| "reason"
	| "edit"
	| "build"
	| "test"
	| "verify"
	| "replan"
	| "report";

export type PlanStepStatus = "pending" | "ready" | "active" | "done" | "failed" | "skipped" | "blocked";

export interface PlanStep {
	id: string;
	goal: string;
	status: PlanStepStatus;
	action_class: PlanActionClass;
	dependencies: string[];
	allowed_paths?: string[];
	required_evidence?: string[];
	proof_obligations: string[];
}

export interface Plan {
	version: number;
	rationale_ref?: string | null;
	steps: PlanStep[];
}

export type ToolEventStatus = "requested" | "allowed" | "denied" | "running" | "succeeded" | "failed";

export interface ToolEvent {
	id: string;
	tool: string;
	intent: string;
	status: ToolEventStatus;
	timestamp: string;
	impact: ToolImpact;
	input_hash?: string | null;
	output_hash?: string | null;
	observation_ids?: string[];
}

export type ChangeKind = "create" | "modify" | "delete" | "rename";
export type ChangeStatus = "proposed" | "applied" | "reverted";
export type ChangeOwnership = "worker" | "preexisting_user_change" | "unknown";

export interface Change {
	id: string;
	path: string;
	kind: ChangeKind;
	status: ChangeStatus;
	ownership: ChangeOwnership;
	diff_hash?: string | null;
	related_claim_ids?: string[];
	related_step_ids?: string[];
}

export type VerificationKind =
	| "compile"
	| "unit_test"
	| "integration_test"
	| "lint"
	| "static_analysis"
	| "semantic_check"
	| "manual_check"
	| "repo_search"
	| "duplicate_logic_check";

export type VerificationStatus = "passed" | "failed" | "inconclusive" | "skipped" | "unavailable";

export interface VerificationRun {
	id: string;
	kind: VerificationKind;
	status: VerificationStatus;
	timestamp: string;
	command?: string | null;
	artifact_ref?: string | null;
	covers_acceptance_ids?: string[];
	observation_ids?: string[];
}

export type ValidationStage =
	| "intake"
	| "preflight"
	| "tool_gate"
	| "postflight"
	| "evidence_check"
	| "drift_check"
	| "drift_loop"
	| "duplicate_logic"
	| "patch_review"
	| "completion"
	| "completion_challenge";

export interface ValidationDecision {
	id: string;
	stage: ValidationStage;
	model: string;
	question_catalog_version: string;
	questions_hash: string;
	state_hash: string;
	answers: Record<string, unknown>;
	policy_result: string;
	timestamp: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	latency_ms?: number;
}

export type RiskSeverity = "low" | "medium" | "high" | "critical";
export type RiskStatus = "open" | "mitigated" | "accepted" | "closed";

export interface Risk {
	id: string;
	text: string;
	severity: RiskSeverity;
	status: RiskStatus;
	mitigation?: string | null;
}

export type CompletionGateKind = "deterministic" | "semantic" | "evidence" | "authorization";
export type CompletionGateStatus = "pending" | "passed" | "failed" | "waived";

export interface CompletionGate {
	id: string;
	kind: CompletionGateKind;
	required: boolean;
	status: CompletionGateStatus;
	evidence_ids?: string[];
	waiver_id?: string | null;
	details?: string | null;
}

export type TerminalStatus = "none" | "complete" | "blocked_external" | "aborted";

export interface CompletionState {
	requested: boolean;
	requested_at?: string | null;
	attempt: number;
	gates: CompletionGate[];
	final_summary_ref?: string | null;
	terminal_status?: TerminalStatus;
}

export interface ExecutionState {
	run_id: string;
	schema_version: "1.0";
	created_at?: string;
	updated_at?: string;
	phase: Phase;
	objective: Objective;
	repo: RepoState;
	observations: Observation[];
	claims: Claim[];
	hypotheses: Hypothesis[];
	plan: Plan;
	tool_events: ToolEvent[];
	changes: Change[];
	verification: VerificationRun[];
	decisions: ValidationDecision[];
	risks: Risk[];
	completion: CompletionState;
}

export interface WorkerClaimInput {
	text: string;
	materiality: ClaimMateriality;
	evidence_refs: string[];
}

export interface WorkerHypothesisUpdate {
	hypothesis_id: string;
	status: HypothesisStatus;
	evidence_refs?: string[];
	next_discriminator?: string | null;
}

export interface WorkerToolRequest {
	tool: string;
	intent: string;
	impact: ToolImpact;
	arguments?: Record<string, unknown>;
}

export interface WorkerTurnResult {
	run_id: string;
	step_id: string;
	requested_action: "inspect" | "retrieve" | "edit" | "build" | "test" | "verify" | "replan" | "report" | "none";
	decision_summary?: string;
	claims: WorkerClaimInput[];
	hypothesis_updates: WorkerHypothesisUpdate[];
	requested_tools: WorkerToolRequest[];
	completion_candidate: boolean;
	known_limitations?: string[];
}
