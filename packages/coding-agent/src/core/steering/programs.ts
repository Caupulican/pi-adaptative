/**
 * Steering decision programs and question packs for JEV-001 through JEV-045.
 * Normative reference: STEERING_DECISION_PROGRAMS.md and MANDATORY_JEV_CHECKPOINTS.md
 */

import { createHash } from "node:crypto";
import type { SteeringCertificateQuestionPackRef } from "./types.ts";

export type QuestionKind = "noul" | "choice" | "score";

export interface SteeringQuestionDef {
	readonly id: string;
	readonly kind: QuestionKind;
	readonly description: string;
	readonly options?: readonly string[];
}

export interface SteeringQuestionPack {
	readonly id: string;
	readonly version: string;
	readonly checkpointIds: readonly string[];
	readonly questions: readonly SteeringQuestionDef[];
}

export const STEERING_QUESTION_PACKS: Record<string, SteeringQuestionPack> = {
	objective_intake: {
		id: "pi:steering:pack:objective_intake:1.0",
		version: "1.0",
		checkpointIds: ["JEV-001", "JEV-002", "JEV-003"],
		questions: [
			{ id: "objective_coherent", kind: "noul", description: "Is the objective clear and coherent?" },
			{
				id: "acceptance_complete",
				kind: "noul",
				description: "Are all requested behaviors covered in acceptance criteria?",
			},
			{
				id: "ambiguity_severity",
				kind: "score",
				description: "How severe is remaining ambiguity (0=none, 3=fatal)?",
			},
			{ id: "missing_information", kind: "noul", description: "Is critical information missing?" },
			{
				id: "requested_delivery_class",
				kind: "choice",
				description: "Target deliverable class",
				options: ["code_fix", "new_feature", "refactor", "investigation", "release", "full_system"],
			},
			{ id: "capability_sensitive", kind: "noul", description: "Does this require special tools or capabilities?" },
		],
	},
	objective_route: {
		id: "pi:steering:pack:objective_route:1.0",
		version: "1.0",
		checkpointIds: ["JEV-004", "JEV-005", "JEV-006", "JEV-024"],
		questions: [
			{ id: "work_remaining", kind: "noul", description: "Is there material work remaining to reach completion?" },
			{
				id: "missing_work_class",
				kind: "choice",
				description: "Class of remaining work",
				options: [
					"investigate",
					"implement",
					"deterministic_verify",
					"independent_review",
					"replan",
					"resolve_capability",
					"completion_candidate",
				],
			},
			{
				id: "evidence_sufficient",
				kind: "noul",
				description: "Is fresh evidence sufficient for the next transition?",
			},
			{
				id: "semantic_progress",
				kind: "score",
				description: "Semantic progress score (0=none, 1=minor, 2=good, 3=significant)",
			},
			{
				id: "strategy_repetition",
				kind: "noul",
				description: "Is the current failed strategy repeating without fresh evidence?",
			},
			{ id: "context_stale", kind: "noul", description: "Has the working context drifted or become stale?" },
			{
				id: "independent_worker_required",
				kind: "noul",
				description: "Is an independent worker or verifier required?",
			},
			{
				id: "capability_escalation_required",
				kind: "noul",
				description: "Does the task need capability escalation?",
			},
			{ id: "capability_gap_suspected", kind: "noul", description: "Is a missing capability gap suspected?" },
			{
				id: "completion_plausible",
				kind: "noul",
				description: "Is the objective plausibly complete and ready for final gating?",
			},
		],
	},
	capability_resolution_wide: {
		id: "pi:steering:pack:capability_resolution_wide:1.0",
		version: "1.0",
		checkpointIds: ["JEV-007"],
		questions: [
			{ id: "needs_capability", kind: "noul", description: "Is an external tool, script, or capability required?" },
			{ id: "adaptation_likely", kind: "noul", description: "Can an existing capability be adapted?" },
			{ id: "composition_likely", kind: "noul", description: "Can existing capabilities be composed?" },
			{ id: "new_capability_likely", kind: "noul", description: "Is a completely new capability required?" },
		],
	},
	capability_resolution_deep: {
		id: "pi:steering:pack:capability_resolution_deep:1.0",
		version: "1.0",
		checkpointIds: ["JEV-008"],
		questions: [
			{ id: "composition_sufficient", kind: "noul", description: "Is composing existing tools sufficient?" },
			{
				id: "gap_remains",
				kind: "noul",
				description: "Does an unresolved capability gap remain after shortlist review?",
			},
		],
	},
	capability_synthesis: {
		id: "pi:steering:pack:capability_synthesis:1.0",
		version: "1.0",
		checkpointIds: ["JEV-009", "JEV-010", "JEV-011", "JEV-012"],
		questions: [
			{
				id: "gap_valid",
				kind: "noul",
				description: "Is the capability gap genuine and unclosed by existing tools?",
			},
			{
				id: "adaptation_class",
				kind: "choice",
				description: "Smallest adequate capability adaptation level",
				options: [
					"compose",
					"ephemeral_script",
					"toolkit_script",
					"extension_or_tool",
					"skill",
					"integration_or_adapter",
					"runtime_patch",
				],
			},
			{
				id: "spec_complete",
				kind: "noul",
				description: "Is the CapabilitySpec complete with inputs, outputs, and proof?",
			},
			{
				id: "synthesis_plan_fits",
				kind: "noul",
				description: "Does the synthesis plan fit within authority boundaries?",
			},
		],
	},
	capability_candidate_pre_activation: {
		id: "pi:steering:pack:capability_candidate_pre_activation:1.0",
		version: "1.0",
		checkpointIds: ["JEV-013", "JEV-014"],
		questions: [
			{ id: "spec_fulfilled", kind: "noul", description: "Does the candidate artifact fulfill the CapabilitySpec?" },
			{ id: "missing_required_behavior", kind: "noul", description: "Is any required behavior missing?" },
			{
				id: "scope_overreach",
				kind: "noul",
				description: "Does the candidate attempt unauthorized or overreaching changes?",
			},
			{
				id: "security_boundary_fit",
				kind: "noul",
				description: "Does the candidate respect security and isolation boundaries?",
			},
			{
				id: "deterministic_tests_relevant",
				kind: "noul",
				description: "Do mechanical tests test the intended gap behavior?",
			},
			{ id: "activation_risk", kind: "score", description: "Activation risk (0=safe, 3=destructive)" },
			{
				id: "runtime_modification_scope_in_bounds",
				kind: "noul",
				description: "For runtime patch, is change minimal and in-scope?",
			},
		],
	},
	post_activation: {
		id: "pi:steering:pack:post_activation:1.0",
		version: "1.0",
		checkpointIds: ["JEV-015", "JEV-016"],
		questions: [
			{
				id: "capability_available",
				kind: "noul",
				description: "Is the capability verified live and usable after activation?",
			},
			{ id: "interface_matches_spec", kind: "noul", description: "Does the live interface match the spec?" },
			{
				id: "unexpected_runtime_change",
				kind: "noul",
				description: "Were there unexpected side-effects during activation?",
			},
			{
				id: "original_gap_closed",
				kind: "noul",
				description: "Does the capability solve the original missing ability with task proof?",
			},
		],
	},
	worker_postflight: {
		id: "pi:steering:pack:worker_postflight:1.0",
		version: "1.0",
		checkpointIds: ["JEV-017", "JEV-018", "JEV-019", "JEV-020", "JEV-021", "JEV-022", "JEV-023"],
		questions: [
			{ id: "claims_supported", kind: "noul", description: "Do worker claims match fresh verified host evidence?" },
			{
				id: "patch_requirement_fit",
				kind: "noul",
				description: "Does the patch directly address the linked requirement?",
			},
			{
				id: "bug_causality_supported",
				kind: "noul",
				description: "Does the patch fix the supported causal mechanism for the bug?",
			},
			{ id: "architecture_fit", kind: "noul", description: "Is ownership and architecture boundary appropriate?" },
			{
				id: "duplicate_semantics_detected",
				kind: "noul",
				description: "Does the change duplicate existing responsibility?",
			},
			{
				id: "verification_relevance",
				kind: "noul",
				description: "Do verification probes test the required behavior?",
			},
			{ id: "repair_adequacy", kind: "noul", description: "Does the repair address the true failure cause?" },
		],
	},
	completion: {
		id: "pi:steering:pack:completion:1.0",
		version: "1.0",
		checkpointIds: ["JEV-025"],
		questions: [
			{
				id: "all_promised_behavior_supported",
				kind: "noul",
				description: "Is all requested and promised behavior supported by evidence?",
			},
			{
				id: "unresolved_material_gap",
				kind: "noul",
				description: "Does any material requirement or gap remain unresolved?",
			},
			{
				id: "tests_support_completion",
				kind: "noul",
				description: "Do deterministic test results genuinely support completion?",
			},
			{ id: "known_limitations_complete", kind: "noul", description: "Are known limitations accurately noted?" },
			{
				id: "architecture_consistent",
				kind: "noul",
				description: "Is repository architecture internally consistent?",
			},
		],
	},
	completion_challenge: {
		id: "pi:steering:pack:completion_challenge:1.0",
		version: "1.0",
		checkpointIds: ["JEV-026"],
		questions: [
			{
				id: "plausible_missing_requirement",
				kind: "noul",
				description: "Is there a plausible missing requirement from the original goal?",
			},
			{
				id: "plausible_false_positive_test",
				kind: "noul",
				description: "Could any passing tests be false positives?",
			},
			{
				id: "plausible_hidden_regression",
				kind: "noul",
				description: "Is there an unverified plausible hidden regression?",
			},
			{
				id: "plausible_stale_evidence",
				kind: "noul",
				description: "Could any supporting evidence be stale or invalidated?",
			},
			{
				id: "plausible_unverified_user_path",
				kind: "noul",
				description: "Is an essential user path left untested?",
			},
			{
				id: "plausible_capability_side_effect",
				kind: "noul",
				description: "Did any synthesized capability introduce unintended side-effects?",
			},
		],
	},
	delivery: {
		id: "pi:steering:pack:delivery:1.0",
		version: "1.0",
		checkpointIds: ["JEV-027", "JEV-028"],
		questions: [
			{
				id: "delivery_claims_true",
				kind: "noul",
				description: "Do public delivery claims match actual verified proof?",
			},
			{
				id: "publish_deploy_readiness",
				kind: "noul",
				description: "Is the artifact ready for publication and deployment?",
			},
		],
	},
	capability_lifecycle: {
		id: "pi:steering:pack:capability_lifecycle:1.0",
		version: "1.0",
		checkpointIds: ["JEV-029", "JEV-030"],
		questions: [
			{
				id: "reusable_beyond_current_task",
				kind: "noul",
				description: "Is the capability reusable beyond the current task?",
			},
			{
				id: "generic_enough_to_retain",
				kind: "noul",
				description: "Is the capability generic enough to retain across sessions?",
			},
			{
				id: "reliability_sufficient",
				kind: "noul",
				description: "Has the capability shown sufficient reliability?",
			},
			{
				id: "lifecycle_action",
				kind: "choice",
				description: "Lifecycle action for synthesized capability",
				options: ["discard", "session", "project", "global", "repair", "retire"],
			},
		],
	},
	adaptive_resolution: {
		id: "pi:steering:pack:adaptive_resolution:1.0",
		version: "1.0",
		checkpointIds: ["JEV-040"],
		questions: [
			{ id: "current_strategy_adequate", kind: "noul", description: "Is the current execution strategy adequate?" },
			{ id: "current_expert_adequate", kind: "noul", description: "Is the currently assigned expert adequate?" },
			{
				id: "specialist_gap_present",
				kind: "noul",
				description: "Is a specialized role/expertise materially required?",
			},
			{ id: "capability_gap_present", kind: "noul", description: "Is a tooling/capability gap present?" },
			{
				id: "runtime_gap_present",
				kind: "noul",
				description: "Is a core runtime gap present requiring runtime modification?",
			},
			{
				id: "semantic_duplication_risk_present",
				kind: "noul",
				description: "Is there a risk of duplicate responsibility?",
			},
			{
				id: "lowest_adequate_adaptation",
				kind: "choice",
				description: "Lowest adequate adaptation dimension",
				options: ["strategy", "expert_reroute", "specialist", "capability", "runtime"],
			},
		],
	},
	specialist_resolution_wide: {
		id: "pi:steering:pack:specialist_resolution_wide:1.0",
		version: "1.0",
		checkpointIds: ["JEV-031"],
		questions: [
			{
				id: "specialist_needed",
				kind: "noul",
				description: "Is a specialist materially required beyond generic workers?",
			},
			{ id: "reuse_likely", kind: "noul", description: "Can an existing specialist be reused?" },
			{ id: "synthesize_likely", kind: "noul", description: "Must a new specialist be synthesized?" },
		],
	},
	specialist_resolution_deep: {
		id: "pi:steering:pack:specialist_resolution_deep:1.0",
		version: "1.0",
		checkpointIds: ["JEV-032"],
		questions: [
			{
				id: "existing_specialist_fits",
				kind: "noul",
				description: "Does an existing specialist adequately fit the required specialty?",
			},
			{
				id: "dependency_gap_present",
				kind: "noul",
				description: "Does the specialist require missing tools/skills?",
			},
			{ id: "new_specialist_required", kind: "noul", description: "Is a fresh SpecialistSpec required?" },
		],
	},
	specialist_spec: {
		id: "pi:steering:pack:specialist_spec:1.0",
		version: "1.0",
		checkpointIds: ["JEV-033", "JEV-034", "JEV-035"],
		questions: [
			{
				id: "spec_complete",
				kind: "noul",
				description: "Does SpecialistSpec capture purpose, mission, context, and proof obligations?",
			},
			{
				id: "authority_role_fit",
				kind: "noul",
				description: "Does authority role fit without mutating kernel roles?",
			},
			{
				id: "dependencies_complete",
				kind: "noul",
				description: "Are all required tools, capabilities, and skills available?",
			},
			{
				id: "materialization_fit",
				kind: "noul",
				description: "Does the materialized task profile and contract faithfully realize the spec?",
			},
			{
				id: "overprivileged",
				kind: "noul",
				description: "Does the specialist exceed authorized base profile permissions?",
			},
		],
	},
	specialist_effectiveness: {
		id: "pi:steering:pack:specialist_effectiveness:1.0",
		version: "1.0",
		checkpointIds: ["JEV-036", "JEV-037"],
		questions: [
			{ id: "mission_fulfilled", kind: "noul", description: "Did the specialist fulfill the specialty mission?" },
			{
				id: "specialty_value_added",
				kind: "noul",
				description: "Did the specialist add material domain value over a generic worker?",
			},
			{
				id: "specialist_misconfigured",
				kind: "noul",
				description: "Was the specialist misconfigured or lacking tools?",
			},
			{ id: "repair_addresses_cause", kind: "noul", description: "Does the proposed repair fix the root cause?" },
		],
	},
	specialist_lifecycle: {
		id: "pi:steering:pack:specialist_lifecycle:1.0",
		version: "1.0",
		checkpointIds: ["JEV-038", "JEV-039"],
		questions: [
			{ id: "reusable_specialist", kind: "noul", description: "Is the specialist useful across subsequent tasks?" },
			{
				id: "promotion_justified",
				kind: "noul",
				description: "Is promotion to project or global catalog justified?",
			},
			{
				id: "lifecycle_action",
				kind: "choice",
				description: "Specialist retention action",
				options: ["discard", "task", "session", "project", "global", "repair", "retire"],
			},
		],
	},
	semantic_responsibility_preflight: {
		id: "pi:steering:pack:semantic_responsibility_preflight:1.0",
		version: "1.0",
		checkpointIds: ["JEV-041", "JEV-042"],
		questions: [
			{
				id: "already_owned",
				kind: "noul",
				description: "Is the proposed responsibility already owned by existing code?",
			},
			{
				id: "same_responsibility",
				kind: "noul",
				description: "Does any candidate share the exact semantic domain responsibility?",
			},
			{
				id: "recommended_disposition",
				kind: "choice",
				description: "Recommended architectural disposition",
				options: [
					"unique",
					"reuse_existing",
					"extend_existing",
					"extract_shared",
					"separate_required",
					"insufficient_evidence",
				],
			},
			{
				id: "semantic_drift_risk",
				kind: "score",
				description: "Risk of semantic drift if duplicate is created (0=none, 3=severe)",
			},
		],
	},
	semantic_responsibility_pair: {
		id: "pi:steering:pack:semantic_responsibility_pair:1.0",
		version: "1.0",
		checkpointIds: ["JEV-021"],
		questions: [
			{
				id: "same_responsibility",
				kind: "noul",
				description: "Do the two implementations own materially the same behavior?",
			},
			{ id: "partial_overlap", kind: "noul", description: "Is there partial overlap in responsibility?" },
			{
				id: "ownership_relationship",
				kind: "choice",
				description: "Ownership relationship between implementations",
				options: [
					"same_owner_should_reuse",
					"existing_owner_should_extend",
					"shared_abstraction_should_extract",
					"separate_required",
					"unrelated",
					"insufficient_evidence",
				],
			},
			{
				id: "duplication_cost",
				kind: "score",
				description: "Cost/danger of duplication (0=none, 3=competing owners)",
			},
		],
	},
	semantic_responsibility_postflight: {
		id: "pi:steering:pack:semantic_responsibility_postflight:1.0",
		version: "1.0",
		checkpointIds: ["JEV-043"],
		questions: [
			{
				id: "duplicate_responsibility_introduced",
				kind: "noul",
				description: "Did this mutation introduce an unintentional duplicate responsibility?",
			},
			{
				id: "existing_owner_should_absorb_change",
				kind: "noul",
				description: "Should an existing owner have absorbed this change instead?",
			},
			{
				id: "shared_extraction_required",
				kind: "noul",
				description: "Is extraction of a shared abstraction required?",
			},
			{
				id: "intentional_waiver_applies",
				kind: "noul",
				description: "Does an explicit intentional duplication waiver apply to this exact change?",
			},
		],
	},
	final_semantic_dedup: {
		id: "pi:steering:pack:final_semantic_dedup:1.0",
		version: "1.0",
		checkpointIds: ["JEV-044"],
		questions: [
			{
				id: "unintentional_duplicate_remaining",
				kind: "noul",
				description: "Does any unintentional duplicate responsibility remain in the repository?",
			},
			{
				id: "uniqueness_certificates_current",
				kind: "noul",
				description: "Are all material responsibility uniqueness certificates current?",
			},
			{
				id: "intentional_duplication_waiver_valid",
				kind: "noul",
				description: "Are all intentional duplicate instances covered by valid waivers?",
			},
		],
	},
	intentional_duplication_waiver: {
		id: "pi:steering:pack:intentional_duplication_waiver:1.0",
		version: "1.0",
		checkpointIds: ["JEV-045"],
		questions: [
			{
				id: "waiver_valid_for_scope",
				kind: "noul",
				description: "Does the waiver explicitly cover this responsibility scope and location?",
			},
			{
				id: "waiver_authorized_by_source",
				kind: "noul",
				description: "Was the waiver explicitly authorized by user objective or owner policy?",
			},
			{
				id: "architectural_justification_valid",
				kind: "noul",
				description: "Is the architectural justification valid?",
			},
		],
	},
};

export function findPackForCheckpoint(checkpointId: string): SteeringQuestionPack | undefined {
	for (const pack of Object.values(STEERING_QUESTION_PACKS)) {
		if (pack.checkpointIds.includes(checkpointId)) {
			return pack;
		}
	}
	return undefined;
}

export function computeQuestionPackDigest(pack: SteeringQuestionPack): string {
	return createHash("sha256").update(JSON.stringify(pack.questions)).digest("hex");
}

export function getQuestionPackRef(pack: SteeringQuestionPack): SteeringCertificateQuestionPackRef {
	return {
		id: pack.id,
		version: pack.version,
		digest: computeQuestionPackDigest(pack),
	};
}
