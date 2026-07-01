/**
 * Pure policy-engine contracts (Phase 0.6). No behavior change: nothing here is wired
 * into prompt construction, model routing, or validation yet. See
 * docs/context-management-rework/policy-engine-spec.md for the design this mirrors.
 */

import type { ContextArtifactRef, ContextEvidenceRef, ContextRetentionClass } from "./context-item.ts";

export type PolicyMode = "off" | "shadow" | "enforce_safe" | "enforce_all";

export type PolicyDecisionKind =
	| "context_retention"
	| "artifact_retrieval"
	| "tool_rerun"
	| "model_route"
	| "validation"
	| "goal_continuation";

export type PolicyAction =
	| "keep_raw"
	| "pack_to_artifact"
	| "summarize"
	| "drop_from_prompt"
	| "retrieve_artifact_slice"
	| "rerun_narrowed_tool"
	| "route_cheap"
	| "route_medium"
	| "route_expensive"
	| "run_validation"
	| "skip_optional_validation"
	| "continue_goal"
	| "stop_and_ask";

/**
 * Fixed, closed set of hard-constraint reason codes. The policy engine never invents a
 * new code at runtime: every hard rejection maps to one of these.
 */
export type PolicyHardConstraintCode =
	| "pinned_user_instruction"
	| "approval_or_denial"
	| "safety_constraint"
	| "open_requirement"
	| "active_blocker"
	| "latest_unresolved_failure"
	| "current_diff_summary"
	| "current_validation_result"
	| "missing_retrieval_path"
	| "path_or_tool_scope"
	| "unknown_risk";

export interface PolicyFeatures {
	turnIndex: number;
	expectedRemainingTurns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	artifactBytes: number;
	charEstimate: number;
	calibratedTokenEstimate: number;
	promptSection: "stable_prefix" | "volatile_tail" | "artifact" | "memory";
	retentionClass?: ContextRetentionClass;
	isReproducible: boolean;
	isDecisionBearing: boolean;
	isPinned: boolean;
	isOpenRequirement: boolean;
	isLatestFailure: boolean;
	isCurrentDiff: boolean;
	cacheHitProbability?: number;
	cacheMissCostTokens?: number;
	probabilityNeededAgain: number;
	probabilityErrorIfDropped: number;
	retrievalCostTokens: number;
	packCostTokens: number;
	retryCostTokens: number;
	failureCostTokens: number;
	validationCostTokens: number;
	modelTier?: "cheap" | "medium" | "expensive" | "learning";
	taskRisk?: "low" | "medium" | "high" | "unknown";
}

export interface PolicyCandidateScore {
	action: PolicyAction;
	expectedCostTokens: number;
	expectedSavingsTokens: number;
	expectedReliabilityRisk: number;
	cacheImpactTokens: number;
	reworkRiskTokens: number;
	confidence: "low" | "medium" | "high";
	reasonCodes: string[];
}

export interface PolicyDecision {
	kind: PolicyDecisionKind;
	selectedAction: PolicyAction;
	mode: PolicyMode;
	applied: boolean;
	hardConstraints: PolicyHardConstraintCode[];
	candidates: PolicyCandidateScore[];
	selectedReasonCodes: string[];
	estimatedCostTokens: number;
	estimatedSavingsTokens: number;
	estimatedReliabilityRisk: number;
	cacheImpactTokens: number;
	reworkRiskTokens: number;
	artifactRefs: ContextArtifactRef[];
	evidenceRefs: ContextEvidenceRef[];
}

/**
 * Flags a caller supplies alongside `PolicyFeatures` so the hard-constraint evaluator can
 * distinguish reason codes `PolicyFeatures` alone does not carry (e.g. approvals/denials
 * and safety constraints are not modeled as separate `PolicyFeatures` booleans).
 */
export interface HardConstraintFlags {
	isApprovalOrDenial: boolean;
	isSafetyConstraint: boolean;
	isActiveBlocker: boolean;
	isCurrentValidationResult: boolean;
	isPathOrToolScope: boolean;
	/**
	 * True only if the item's existing ref is currently resolvable, not merely present.
	 * An artifact ref is resolvable only if the artifact store/payload is available; a
	 * transcript/memory/runtime ref is resolvable independent of the artifact store. Callers
	 * must compute this by checking the concrete ref kind against its backing store, not by
	 * treating "some ref is attached" as sufficient.
	 */
	hasAvailableRetrievalPath: boolean;
	artifactStoreAvailable: boolean;
	/** Only relevant when the candidate action is "summarize" on decision-bearing content. */
	hasEvidenceRefForSummary: boolean;
	/** Only relevant for model-routing candidates ("route_cheap"). */
	pathOrToolBoundariesEnforced: boolean;
	/** Only relevant for model-routing candidates ("route_cheap"). */
	validationAvailableAndStrong: boolean;
	/** Only relevant for model-routing candidates ("route_cheap"). */
	priorAttemptFailedForReasoningOrArchitecture: boolean;
	/** Only relevant for model-routing candidates ("route_cheap"). */
	isHighImpactOrBroadMultiFileEdit: boolean;
}
