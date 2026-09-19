/**
 * Adaptive runtime types and interfaces.
 * Normative reference: URN urn:pi:adaptive:* schemas.
 */

export type AdaptationNodeKind =
	| "strategy_change"
	| "expert_reroute"
	| "specialist_spec"
	| "capability_spec"
	| "runtime_patch"
	| "dedup_restructure";

export type AdaptationNodeStatus = "planned" | "active" | "satisfied" | "failed" | "discarded";

export interface AdaptationNode {
	readonly schema_version: "1.0";
	readonly node_id: string;
	readonly kind: AdaptationNodeKind;
	readonly fingerprint: string;
	readonly parent_ids?: readonly string[];
	readonly certificate_refs: readonly string[];
	readonly status: AdaptationNodeStatus;
	readonly created_at?: string | null;
}

export type SpecialistLifetime = "one_task" | "session" | "project" | "global";

export interface SpecialistCognitiveRequirements {
	readonly reasoning: "low" | "medium" | "high" | "critical";
	readonly vision: boolean;
	readonly long_context: boolean;
	readonly tool_calling: boolean;
}

export interface SpecialistContextPolicy {
	readonly mode: "fresh" | "forked";
	readonly requirement_ids: readonly string[];
	readonly evidence_ids: readonly string[];
}

export interface SpecialistSpec {
	readonly schema_version: "1.0";
	readonly specialist_id: string;
	readonly version: string;
	readonly objective_id: string;
	readonly task_id?: string | null;
	readonly purpose: string;
	readonly authority_role: string;
	readonly specialties: readonly string[];
	readonly mission: string;
	readonly cognitive_requirements: SpecialistCognitiveRequirements;
	readonly required_capabilities: readonly string[];
	readonly required_tools: readonly string[];
	readonly required_skills: readonly string[];
	readonly resource_profiles: readonly string[];
	readonly context_policy: SpecialistContextPolicy;
	readonly proof_obligations: readonly string[];
	readonly forbidden_strategies?: readonly string[];
	readonly independence_level?: string | null;
	readonly lifetime: SpecialistLifetime;
	readonly retention_criteria?: readonly string[];
}

export type SpecialistRecordState =
	| "candidate"
	| "materialized_task"
	| "active_task"
	| "retained_session"
	| "retained_project"
	| "retained_global"
	| "repair_required"
	| "demoted"
	| "retired"
	| "discarded";

export interface SpecialistRecord {
	readonly schema_version: "1.0";
	readonly specialist_id: string;
	readonly spec_version: string;
	readonly state: SpecialistRecordState;
	readonly profile_ids: readonly string[];
	readonly certificate_refs: readonly string[];
	readonly attempt_ids?: readonly string[];
	readonly success_count?: number;
	readonly failure_count?: number;
	readonly created_at: string;
	readonly updated_at?: string | null;
}

export type WorkerAdaptationNeedKind =
	| "specialist"
	| "capability"
	| "context"
	| "expert_reroute"
	| "strategy"
	| "runtime"
	| "dedup_restructure";

export interface WorkerAdaptationSignal {
	readonly schema_version: "1.0";
	readonly signal_id: string;
	readonly attempt_id: string;
	readonly need_kind: WorkerAdaptationNeedKind;
	readonly description: string;
	readonly suggested_specialties?: readonly string[];
	readonly evidence_refs: readonly string[];
	readonly blocking?: boolean;
}

export type CapabilityReuseExpectation = "one_shot" | "session" | "project" | "global" | "unknown";

export interface CapabilityGap {
	readonly schema_version: "1.0";
	readonly gap_id: string;
	readonly objective_id: string;
	readonly task_id?: string | null;
	readonly required_outcome: string;
	readonly required_inputs: readonly string[];
	readonly required_outputs: readonly string[];
	readonly side_effects?: readonly string[];
	readonly authority_needs?: readonly string[];
	readonly proof_obligations: readonly string[];
	readonly expected_reuse?: CapabilityReuseExpectation;
	readonly failure_evidence_ids?: readonly string[];
	readonly existing_candidates_rejected: readonly Record<string, unknown>[];
}

export type CapabilityKind =
	| "composition"
	| "ephemeral_script"
	| "toolkit_script"
	| "tool"
	| "skill"
	| "extension"
	| "integration"
	| "provider_adapter"
	| "runtime_patch";

export type CapabilityLifetime = "one_shot" | "session" | "project" | "global";

export interface CapabilitySpecProof {
	readonly deterministic_tests: readonly string[];
	readonly task_specific_test: string;
}

export interface CapabilitySpec {
	readonly schema_version: "1.0";
	readonly capability_id: string;
	readonly version: string;
	readonly kind: CapabilityKind;
	readonly lifetime: CapabilityLifetime;
	readonly purpose: string;
	readonly interface: Record<string, unknown>;
	readonly preconditions?: readonly string[];
	readonly side_effects: readonly string[];
	readonly denied_behavior: readonly string[];
	readonly authority_requirements?: readonly string[];
	readonly proof: CapabilitySpecProof;
	readonly activation: Record<string, unknown>;
	readonly rollback: Record<string, unknown>;
}

export type CapabilityRecordState =
	| "candidate"
	| "verified"
	| "active_ephemeral"
	| "active_session"
	| "active_project"
	| "active_global"
	| "repair_required"
	| "demoted"
	| "retired"
	| "discarded";

export interface CapabilityRecord {
	readonly schema_version: "1.0";
	readonly capability_id: string;
	readonly version: string;
	readonly kind: string;
	readonly state: CapabilityRecordState;
	readonly artifact_uri?: string | null;
	readonly artifact_digest: string;
	readonly certificate_refs: readonly string[];
	readonly usage_count?: number;
	readonly success_count?: number;
	readonly failure_count?: number;
	readonly created_at: string;
	readonly updated_at?: string | null;
}

export interface CapabilityLevel {
	readonly id: string;
	readonly rank: number;
}

export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = [
	{ id: "existing", rank: 0 },
	{ id: "compose", rank: 1 },
	{ id: "ephemeral_script", rank: 2 },
	{ id: "toolkit_script", rank: 3 },
	{ id: "extension_or_tool", rank: 4 },
	{ id: "skill", rank: 5 },
	{ id: "integration_or_adapter", rank: 6 },
	{ id: "runtime_patch", rank: 7 },
] as const;

export interface EstablishedCapability {
	readonly capabilityId: string;
	readonly kind: CapabilityKind;
	readonly lifetime: CapabilityLifetime;
	readonly spec: CapabilitySpec;
	readonly record: CapabilityRecord;
	readonly isExisting: boolean;
	readonly activation?: {
		readonly active: boolean;
		readonly method: string;
		readonly projection?: Record<string, unknown>;
	};
}

export interface MaterializedSpecialist {
	readonly specialistId?: string;
	readonly spec: SpecialistSpec;
	readonly expert: {
		readonly providerId: string;
		readonly modelId: string;
		readonly routingBand: string;
		readonly capabilityTier: string;
	};
	readonly profileId: string;
	readonly executionContract: Record<string, unknown>;
	readonly isExisting: boolean;
}
