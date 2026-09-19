/**
 * Pi Harness Mixture of Experts (H-MoE) — Expert Routing Contracts.
 * Conforms to schemas in core/expert-routing/schemas/ and MASTER_SPEC.md.
 */

export const EXPERT_ROUTING_SCHEMA_VERSION = "1.0" as const;

export type ExpertSelectionMode =
	| "single"
	| "primary_critic"
	| "parallel_scouts"
	| "independent_verifier"
	| "committee";

export type ExpertIndependenceLevel =
	| "none"
	| "fresh_context"
	| "distinct_profile"
	| "distinct_model"
	| "distinct_family"
	| "distinct_provider";

export type ExpertRuntimeKind = "remote" | "local" | "managed-local";

export type ExpertPrivacyClass = "remote_allowed" | "local_preferred" | "local_only";

export type ExpertWorkClass =
	| "retrieve"
	| "investigate"
	| "implement"
	| "deterministic_test"
	| "verify"
	| "review"
	| "replan";

export type ExpertConsequence = "low" | "medium" | "high" | "critical";

export type ExpertSuccessClass =
	| "accepted"
	| "partial_useful"
	| "rejected"
	| "blocked_external"
	| "environment_failure"
	| "routing_failure"
	| "worker_contract_failure"
	| "cancelled";

export interface WorkerCapabilityRequest {
	schema_version: typeof EXPERT_ROUTING_SCHEMA_VERSION;
	request_id: string;
	objective_id: string;
	task_id: string;
	work_class: ExpertWorkClass;
	worker_role: string;
	consequence: ExpertConsequence;

	task_signature?: Record<string, unknown>;
	required_capabilities?: readonly string[];
	required_tools?: readonly string[];

	minimum_context_window?: number | null;
	fresh_context_required?: boolean;
	independence_level?: ExpertIndependenceLevel;

	excluded_expert_ids?: readonly string[];
	excluded_model_refs?: readonly string[];
	excluded_providers?: readonly string[];

	local_only?: boolean;
	remote_allowed?: boolean;
	max_cost_usd?: number | null;
	target_latency_ms?: number | null;

	capability_escalation_requested?: boolean;
	failure_signatures?: readonly string[];
}

export interface ExpertDescriptor {
	schema_version: typeof EXPERT_ROUTING_SCHEMA_VERSION;
	expert_id: string;
	provider: string;
	model_id: string;
	role: string;
	thinking_level: string;
	runtime_kind: ExpertRuntimeKind;

	capability_class?: string | null;
	capability_tier?: string | null;
	tool_names?: readonly string[];
	resource_profiles?: readonly string[];
	context_window?: number | null;
	privacy_class?: ExpertPrivacyClass;
	host_key?: string | null;
	identity_digest?: string;
}

export interface ExpertBinding {
	schema_version: typeof EXPERT_ROUTING_SCHEMA_VERSION;
	selection_id: string;
	request_id: string;
	expert_id: string;

	provider: string;
	model_id: string;
	thinking_level: string;

	role?: string;
	selection_trace_id: string;
	exploration?: boolean;
	expected_cost_usd?: number | null;
	expected_latency_ms?: number | null;
}

export interface CandidateAdmissionEvaluation {
	allowed: boolean;
	reasonCodes: readonly string[];
}

export interface ExpertCandidateState {
	authenticated: boolean;
	quotaExhausted: boolean;
	providerHealthy: boolean;
	hostLoad?: number;
	localRuntimeWarm?: boolean;
	localResourcesInsufficient?: boolean;
	estimatedLatencyMs?: number;
	estimatedCostUsd?: number;
	concurrencySlotsAvailable?: number;
}

export interface ExpertCandidate {
	descriptor: ExpertDescriptor;
	state: ExpertCandidateState;
}

export interface ExpertFeatureVector {
	// Ability
	capabilityFit: number;
	roleProbeFitness: number;
	taskOutcomeFitness: number;
	toolReliability: number;
	reasoningFit: number;
	contextFit: number;

	// Operational
	costUtility: number;
	latencyUtility: number;
	availability: number;
	quotaHeadroom: number;
	localResourceFit: number;

	// Reliability
	recentSuccessLowerBound: number;
	failurePenalty: number;
	repetitionPenalty: number;
	verifierRejectionPenalty: number;

	// Strategic
	diversityBonus: number;
	privacyBonus: number;
	explorationBonus: number;

	// Composite
	totalScore: number;
}

export interface ScoredExpertCandidate {
	candidate: ExpertCandidate;
	features: ExpertFeatureVector;
}

export interface ExpertCandidateRejection {
	candidate: ExpertCandidate;
	reasonCodes: readonly string[];
}

export interface ExpertSelectionPlan {
	primary: ExpertBinding;
	team: readonly ExpertBinding[];
	bindings: readonly ExpertBinding[];
	mode: ExpertSelectionMode;
	traceId: string;
	exploration: boolean;
	ownerPinApplied: boolean;
}

export interface ExpertSelectionTrace {
	schema_version: typeof EXPERT_ROUTING_SCHEMA_VERSION;
	trace_id: string;
	request_digest: string;
	policy_version: string;
	candidates: readonly Record<string, unknown>[];
	selected_expert_ids: readonly string[];
	selection_mode?: ExpertSelectionMode;
	owner_pin_applied?: boolean;
	exploration?: boolean;
	created_at?: string;
}

export interface ExpertOutcomeRecord {
	schema_version: typeof EXPERT_ROUTING_SCHEMA_VERSION;
	outcome_id: string;
	expert_id: string;
	request_digest: string;
	task_id: string;
	work_class: string;
	success_class: ExpertSuccessClass;
	failure_cause: string | null;

	external_failure?: boolean;
	semantic_progress?: number | null;
	repair_rounds_caused?: number;
	verification_passed?: boolean | null;
	verifier_rejected?: boolean;
	cost_usd?: number | null;
	latency_ms?: number | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	recorded_at?: string;
}

export class NoEligibleExpertError extends Error {
	readonly request: WorkerCapabilityRequest;
	readonly rejectedCandidates: readonly ExpertCandidateRejection[];

	constructor(request: WorkerCapabilityRequest, rejectedCandidates: readonly ExpertCandidateRejection[]) {
		const reasons = Array.from(new Set(rejectedCandidates.flatMap((r) => r.reasonCodes))).join(", ");
		super(
			`No eligible expert for request '${request.request_id}' (workClass: ${request.work_class}, role: ${request.worker_role}). Reasons: [${reasons}]`,
		);
		this.name = "NoEligibleExpertError";
		this.request = request;
		this.rejectedCandidates = rejectedCandidates;
	}
}
