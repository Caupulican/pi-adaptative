/**
 * Pure policy-engine primitives (Phase 0.6): a hard-constraint evaluator, break-even
 * scoring helpers, and reason-code formatting. No provider calls, no I/O, no wiring into
 * prompt construction, model routing, or validation yet.
 *
 * The one invariant every helper here must uphold: a hard constraint can never be
 * overridden by a positive expected saving. Scoring only runs for candidates that already
 * cleared the hard-constraint layer.
 */

import type {
	HardConstraintFlags,
	PolicyAction,
	PolicyCandidateScore,
	PolicyFeatures,
	PolicyHardConstraintCode,
} from "./policy-types.ts";

const AGGRESSIVE_CONTEXT_ACTIONS: ReadonlySet<PolicyAction> = new Set([
	"summarize",
	"drop_from_prompt",
	"pack_to_artifact",
]);

function pushUnique(codes: PolicyHardConstraintCode[], code: PolicyHardConstraintCode): void {
	if (!codes.includes(code)) codes.push(code);
}

/**
 * Evaluate hard constraints for a single candidate action. Returns the (possibly empty)
 * list of violated constraint codes; any non-empty result means the action must be
 * rejected outright, never merely down-weighted by scoring.
 */
export function evaluateHardConstraints(
	action: PolicyAction,
	features: PolicyFeatures,
	flags: HardConstraintFlags,
): PolicyHardConstraintCode[] {
	const codes: PolicyHardConstraintCode[] = [];

	if (AGGRESSIVE_CONTEXT_ACTIONS.has(action)) {
		if (features.isPinned) pushUnique(codes, "pinned_user_instruction");
		if (flags.isApprovalOrDenial) pushUnique(codes, "approval_or_denial");
		if (flags.isSafetyConstraint) pushUnique(codes, "safety_constraint");
		if (features.isOpenRequirement) pushUnique(codes, "open_requirement");
		if (flags.isActiveBlocker) pushUnique(codes, "active_blocker");
		if (features.isLatestFailure) pushUnique(codes, "latest_unresolved_failure");
		if (features.isCurrentDiff) pushUnique(codes, "current_diff_summary");
		if (flags.isCurrentValidationResult) pushUnique(codes, "current_validation_result");
		if (flags.isPathOrToolScope) pushUnique(codes, "path_or_tool_scope");
	}

	// drop_from_prompt discards content outright, so it requires a retrieval path that
	// already exists. pack_to_artifact is the first-capture operation that *creates* the
	// retrieval path (tool-output-artifacts.md: measure -> digest/preview/artifact -> prompt
	// item), so it must not be rejected merely for lacking one; it only needs a working
	// artifact store to write into.
	if (action === "drop_from_prompt" && !flags.hasAvailableRetrievalPath) {
		pushUnique(codes, "missing_retrieval_path");
	}
	if (action === "pack_to_artifact" && !flags.artifactStoreAvailable) {
		pushUnique(codes, "missing_retrieval_path");
	}

	if (action === "summarize" && features.isDecisionBearing && !flags.hasEvidenceRefForSummary) {
		pushUnique(codes, "missing_retrieval_path");
	}

	if (action === "route_cheap") {
		if (features.taskRisk === "high" || features.taskRisk === "unknown" || features.taskRisk === undefined) {
			pushUnique(codes, "unknown_risk");
		}
		if (flags.isHighImpactOrBroadMultiFileEdit) pushUnique(codes, "unknown_risk");
		if (flags.priorAttemptFailedForReasoningOrArchitecture) pushUnique(codes, "unknown_risk");
		if (!flags.validationAvailableAndStrong) pushUnique(codes, "unknown_risk");
		if (!flags.pathOrToolBoundariesEnforced) pushUnique(codes, "path_or_tool_scope");
	}

	return codes;
}

/**
 * Inputs to the context-retention break-even formula from decision-math-and-research.md:
 * saving(i) = N_remaining * (T_raw - T_digest) * C_token - C_pack - P_need*C_retrieve
 *             - P_error*C_error - C_cache
 */
export interface ContextRetentionSavingInputs {
	rawTokens: number;
	compactTokens: number;
	expectedRemainingTurns: number;
	marginalInputTokenCost: number;
	packCostTokens: number;
	probabilityNeededAgain: number;
	retrievalCostTokens: number;
	probabilityErrorIfDropped: number;
	errorCostTokens: number;
	cacheImpactTokens: number;
}

export function computeContextRetentionSaving(inputs: ContextRetentionSavingInputs): number {
	const rawCost = inputs.expectedRemainingTurns * inputs.rawTokens * inputs.marginalInputTokenCost;
	const compactCost = inputs.expectedRemainingTurns * inputs.compactTokens * inputs.marginalInputTokenCost;
	const oneTimeCost =
		inputs.packCostTokens +
		inputs.probabilityNeededAgain * inputs.retrievalCostTokens +
		inputs.probabilityErrorIfDropped * inputs.errorCostTokens +
		inputs.cacheImpactTokens;
	return rawCost - compactCost - oneTimeCost;
}

/**
 * N_break_even(i) from decision-math-and-research.md: the number of remaining turns at
 * which packing/summarizing first becomes worthwhile. Returns +Infinity when the raw vs.
 * compact token gap never pays for itself (per-turn saving is zero or negative).
 */
export function computeBreakEvenRemainingTurns(
	inputs: Omit<ContextRetentionSavingInputs, "expectedRemainingTurns"> & { margin: number },
): number {
	const perTurnSaving = (inputs.rawTokens - inputs.compactTokens) * inputs.marginalInputTokenCost;
	if (perTurnSaving <= 0) return Number.POSITIVE_INFINITY;
	const oneTimeCost =
		inputs.packCostTokens +
		inputs.probabilityNeededAgain * inputs.retrievalCostTokens +
		inputs.probabilityErrorIfDropped * inputs.errorCostTokens +
		inputs.cacheImpactTokens +
		inputs.margin;
	return oneTimeCost / perTurnSaving;
}

/**
 * Hard cap override from policy-engine-spec.md: oversized raw tool output must be packed
 * regardless of break-even math, unless the item is pinned, current, or the latest
 * failure.
 */
export function exceedsHardOutputCap(
	rawTokens: number,
	maxRawToolOutputTokens: number,
	features: Pick<PolicyFeatures, "isPinned" | "isCurrentDiff" | "isLatestFailure">,
): boolean {
	if (features.isPinned || features.isCurrentDiff || features.isLatestFailure) return false;
	return rawTokens > maxRawToolOutputTokens;
}

export interface ContextRetentionCandidateInput {
	action: PolicyAction;
	features: PolicyFeatures;
	flags: HardConstraintFlags;
	saving: ContextRetentionSavingInputs;
	margin: number;
	confidence: "low" | "medium" | "high";
}

/**
 * Score one context-retention candidate. Hard constraints are checked first and, if any
 * fire, the candidate is returned as unappliable (infinite cost, zero savings) no matter
 * what the break-even math says — a hard constraint can never be overridden by savings.
 */
export function scoreContextRetentionCandidate(input: ContextRetentionCandidateInput): PolicyCandidateScore {
	const hardConstraints = evaluateHardConstraints(input.action, input.features, input.flags);
	if (hardConstraints.length > 0) {
		return {
			action: input.action,
			expectedCostTokens: Number.POSITIVE_INFINITY,
			expectedSavingsTokens: 0,
			expectedReliabilityRisk: 1,
			cacheImpactTokens: input.saving.cacheImpactTokens,
			reworkRiskTokens: input.saving.probabilityErrorIfDropped * input.saving.errorCostTokens,
			confidence: "low",
			reasonCodes: hardConstraints,
		};
	}

	const saving = computeContextRetentionSaving(input.saving);
	const applied = saving > input.margin;
	const decisionBearingLowConfidence = input.features.isDecisionBearing && input.confidence === "low";

	return {
		action: input.action,
		expectedCostTokens: input.saving.packCostTokens + input.saving.cacheImpactTokens,
		expectedSavingsTokens: Math.max(0, saving),
		expectedReliabilityRisk: input.saving.probabilityErrorIfDropped,
		cacheImpactTokens: input.saving.cacheImpactTokens,
		reworkRiskTokens: input.saving.probabilityErrorIfDropped * input.saving.errorCostTokens,
		confidence: input.confidence,
		reasonCodes:
			applied && !decisionBearingLowConfidence
				? ["saving_above_margin"]
				: decisionBearingLowConfidence
					? ["low_confidence_decision_bearing"]
					: ["saving_below_margin"],
	};
}

const HARD_CONSTRAINT_REASON_TEXT: Record<PolicyHardConstraintCode, string> = {
	pinned_user_instruction: "item is a pinned user instruction and must remain present verbatim",
	approval_or_denial: "item records a user approval or denial and cannot be summarized or dropped",
	safety_constraint: "item is a safety/security constraint and must remain present verbatim",
	open_requirement: "item is an open requirement for the active goal and cannot be dropped while active",
	active_blocker: "item is an active blocker and must remain present until resolved",
	latest_unresolved_failure: "item is the latest unresolved failure; dropping it risks repeating the mistake",
	current_diff_summary: "item is the current diff summary during active code changes",
	current_validation_result: "item is the current validation command/result and cannot be dropped while pending",
	missing_retrieval_path: "no retrieval path (artifact/evidence ref) exists to recover this content if evicted",
	path_or_tool_scope: "item encodes an active path/tool scope restriction that must stay enforced",
	unknown_risk: "task risk is high or unknown and this action requires stronger reliability guarantees",
};

export function formatHardConstraintReason(code: PolicyHardConstraintCode): string {
	return HARD_CONSTRAINT_REASON_TEXT[code];
}

/** Human-readable, deterministic summary of a scored candidate's reason codes. */
export function formatCandidateReason(candidate: Pick<PolicyCandidateScore, "action" | "reasonCodes">): string {
	const hardCodes = candidate.reasonCodes.filter(
		(code): code is PolicyHardConstraintCode => code in HARD_CONSTRAINT_REASON_TEXT,
	);
	if (hardCodes.length > 0) {
		return `${candidate.action} rejected: ${hardCodes.map(formatHardConstraintReason).join("; ")}`;
	}
	return `${candidate.action}: ${candidate.reasonCodes.join(", ")}`;
}
