/**
 * Steering types and interfaces.
 * Normative reference: URN urn:pi:steering:certificate:1.0 and URN urn:pi:steering:worker-mission:1.0
 */

export class SteeringProtocolError extends Error {
	readonly checkpointId: string;
	readonly details?: unknown;

	constructor(message: string, checkpointId: string, details?: unknown) {
		super(`[${checkpointId}] Steering protocol error: ${message}`);
		this.name = "SteeringProtocolError";
		this.checkpointId = checkpointId;
		this.details = details;
	}
}

export interface CertificateLookupQuery {
	readonly objectiveId: string;
	readonly checkpointId: string;
	readonly stateDigest: string;
	readonly evidenceRevision: number;
	readonly policyDigest?: string;
	readonly programDigest?: string;
	readonly provider?: string;
	readonly model?: string;
}

export type SteeringCheckpointId =
	| "JEV-001"
	| "JEV-002"
	| "JEV-003"
	| "JEV-004"
	| "JEV-005"
	| "JEV-006"
	| "JEV-007"
	| "JEV-008"
	| "JEV-009"
	| "JEV-010"
	| "JEV-011"
	| "JEV-012"
	| "JEV-013"
	| "JEV-014"
	| "JEV-015"
	| "JEV-016"
	| "JEV-017"
	| "JEV-018"
	| "JEV-019"
	| "JEV-020"
	| "JEV-021"
	| "JEV-022"
	| "JEV-023"
	| "JEV-024"
	| "JEV-025"
	| "JEV-026"
	| "JEV-027"
	| "JEV-028"
	| "JEV-029"
	| "JEV-030"
	| "JEV-031"
	| "JEV-032"
	| "JEV-033"
	| "JEV-034"
	| "JEV-035"
	| "JEV-036"
	| "JEV-037"
	| "JEV-038"
	| "JEV-039"
	| "JEV-040"
	| "JEV-041"
	| "JEV-042"
	| "JEV-043"
	| "JEV-044"
	| "JEV-045"
	| "JEV-WORKER-SUPERVISION";

export type SteeringDirectiveAction =
	| "continue_current_work"
	| "retrieve_more"
	| "investigate"
	| "implement"
	| "deterministic_verify"
	| "independent_review"
	| "replan"
	| "reroute_expert"
	| "resolve_capability"
	| "synthesize_capability"
	| "repair_capability"
	| "activate_capability"
	| "rollback_capability"
	| "completion_candidate"
	| "blocked_by_charter"
	| "blocked_external";

export interface SteeringDirective {
	readonly action: SteeringDirectiveAction;
	readonly reasonCodes: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export interface SteeringCheckpointRequest {
	readonly checkpointId: SteeringCheckpointId | string;
	readonly objectiveId?: string;
	readonly taskId?: string | null;
	readonly workUnitId?: string | null;
	readonly state: unknown;
	readonly evidenceRevision?: number;
	readonly consequence?: "low" | "medium" | "high" | "critical";
	readonly parentCertificateIds?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface SteeringCertificatePolicyRef {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface SteeringCertificateQuestionPackRef {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface SteeringCertificateEngineRef {
	readonly provider: string;
	readonly model: string;
}

export type SteeringSemanticOutcome = "pass" | "fail" | "gather_more" | "repair" | "replan" | "block";

export class SteeringSemanticFailedError extends Error {
	readonly checkpointId: string;
	readonly outcome: SteeringSemanticOutcome;
	readonly failedPredicates: readonly string[];

	constructor(checkpointId: string, outcome: SteeringSemanticOutcome, failedPredicates: readonly string[]) {
		super(
			`[${checkpointId}] Checkpoint semantic gate failed with outcome '${outcome}': ${failedPredicates.join(", ")}`,
		);
		this.name = "SteeringSemanticFailedError";
		this.checkpointId = checkpointId;
		this.outcome = outcome;
		this.failedPredicates = failedPredicates;
	}
}

export interface SteeringCertificate {
	readonly schema_version: "1.0";
	readonly certificate_id: string;
	readonly objective_id: string;
	readonly task_id?: string | null;
	readonly work_unit_id?: string | null;
	readonly checkpoint_id: string;
	readonly state_digest: string;
	readonly evidence_revision: number;
	readonly policy: SteeringCertificatePolicyRef;
	readonly question_pack: SteeringCertificateQuestionPackRef;
	readonly engine: SteeringCertificateEngineRef;
	readonly answers: Record<string, unknown>;
	readonly directive: string;
	readonly action_confidence?: number;
	readonly policy_result?: string | null;
	readonly semantic_outcome?: SteeringSemanticOutcome;
	readonly failed_semantic_predicates?: readonly string[];
	/** Predicates the model could not settle either way. Open doubts, not rejections. */
	readonly unsure_semantic_predicates?: readonly string[];
	readonly parent_certificate_ids?: readonly string[];
	readonly usage?: Record<string, unknown>;
	readonly created_at: string;
}

export type WorkerSteeringMissionWorkClass =
	| "investigate"
	| "implement"
	| "verify"
	| "review"
	| "replan"
	| "build_capability"
	| "repair_capability";

export interface WorkerSteeringMission {
	readonly schema_version: "1.0";
	readonly mission_id: string;
	readonly objective_id: string;
	readonly task_id: string;
	readonly attempt_id?: string | null;
	readonly work_class: WorkerSteeringMissionWorkClass;
	readonly steering_certificate_ids: readonly string[];
	readonly steering_state_digest: string;
	readonly requirement_ids?: readonly string[];
	readonly hypothesis_ids?: readonly string[];
	readonly proof_obligations: readonly string[];
	readonly capability_gap_id?: string | null;
	readonly capability_spec_id?: string | null;
	readonly failed_gate_ids?: readonly string[];
	readonly forbidden_strategy_fingerprints?: readonly string[];
	readonly verified_fact_refs?: readonly string[];
	readonly relevant_resource_pointer_ids?: readonly string[];
}

export interface SteeringResult {
	readonly certificate: SteeringCertificate;
	readonly directive: SteeringDirective;
}

export interface SteeringMissionContext {
	readonly missionId: string;
	readonly objectiveId: string;
	readonly taskId: string;
	readonly workClass: WorkerSteeringMissionWorkClass;
	readonly proofObligations: readonly string[];
	readonly certificateRefs: readonly string[];
	readonly stateDigest: string;
	readonly contextSubset?: Record<string, unknown>;
}

export interface SteeringMissionReference {
	readonly missionId: string;
	readonly digest: string;
	readonly steeringCertificateIds: readonly string[];
}
