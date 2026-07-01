import { describe, expect, it } from "vitest";
import {
	computeBreakEvenRemainingTurns,
	computeContextRetentionSaving,
	evaluateHardConstraints,
	exceedsHardOutputCap,
	formatCandidateReason,
	formatHardConstraintReason,
	scoreContextRetentionCandidate,
} from "../src/core/context/policy-engine.ts";
import type { HardConstraintFlags, PolicyAction, PolicyFeatures } from "../src/core/context/policy-types.ts";

function makeFeatures(overrides: Partial<PolicyFeatures> = {}): PolicyFeatures {
	return {
		turnIndex: 5,
		expectedRemainingTurns: 10,
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		artifactBytes: 0,
		charEstimate: 4000,
		calibratedTokenEstimate: 1000,
		promptSection: "volatile_tail",
		isReproducible: true,
		isDecisionBearing: false,
		isPinned: false,
		isOpenRequirement: false,
		isLatestFailure: false,
		isCurrentDiff: false,
		probabilityNeededAgain: 0.1,
		probabilityErrorIfDropped: 0.05,
		retrievalCostTokens: 50,
		packCostTokens: 20,
		retryCostTokens: 500,
		failureCostTokens: 2000,
		validationCostTokens: 100,
		...overrides,
	};
}

function makeFlags(overrides: Partial<HardConstraintFlags> = {}): HardConstraintFlags {
	return {
		isApprovalOrDenial: false,
		isSafetyConstraint: false,
		isActiveBlocker: false,
		isCurrentValidationResult: false,
		isPathOrToolScope: false,
		hasAvailableRetrievalPath: true,
		artifactStoreAvailable: true,
		hasEvidenceRefForSummary: true,
		pathOrToolBoundariesEnforced: true,
		validationAvailableAndStrong: true,
		priorAttemptFailedForReasoningOrArchitecture: false,
		isHighImpactOrBroadMultiFileEdit: false,
		...overrides,
	};
}

const AGGRESSIVE_ACTIONS: PolicyAction[] = ["summarize", "drop_from_prompt", "pack_to_artifact"];

describe("evaluateHardConstraints: context retention", () => {
	it.each(AGGRESSIVE_ACTIONS)("rejects %s on a pinned item", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures({ isPinned: true }), makeFlags());
		expect(codes).toContain("pinned_user_instruction");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on an approval/denial", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures(), makeFlags({ isApprovalOrDenial: true }));
		expect(codes).toContain("approval_or_denial");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on a safety constraint", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures(), makeFlags({ isSafetyConstraint: true }));
		expect(codes).toContain("safety_constraint");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on an open requirement", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures({ isOpenRequirement: true }), makeFlags());
		expect(codes).toContain("open_requirement");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on an active blocker", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures(), makeFlags({ isActiveBlocker: true }));
		expect(codes).toContain("active_blocker");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on the latest unresolved failure", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures({ isLatestFailure: true }), makeFlags());
		expect(codes).toContain("latest_unresolved_failure");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on the current diff summary", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures({ isCurrentDiff: true }), makeFlags());
		expect(codes).toContain("current_diff_summary");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on the current validation result", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures(), makeFlags({ isCurrentValidationResult: true }));
		expect(codes).toContain("current_validation_result");
		expect(codes).not.toContain("current_diff_summary");
	});

	it.each(AGGRESSIVE_ACTIONS)("rejects %s on an active path/tool scope restriction", (action) => {
		const codes = evaluateHardConstraints(action, makeFeatures(), makeFlags({ isPathOrToolScope: true }));
		expect(codes).toContain("path_or_tool_scope");
	});

	it("allows summarize/pack/drop when no hard flags are set and a retrieval path exists", () => {
		for (const action of AGGRESSIVE_ACTIONS) {
			expect(evaluateHardConstraints(action, makeFeatures(), makeFlags())).toEqual([]);
		}
	});

	it("rejects drop_from_prompt with no pre-existing retrieval path", () => {
		const flags = makeFlags({ hasAvailableRetrievalPath: false });
		expect(evaluateHardConstraints("drop_from_prompt", makeFeatures(), flags)).toContain("missing_retrieval_path");
	});

	it("allows pack_to_artifact with no pre-existing retrieval path, as long as the artifact store is available", () => {
		// pack_to_artifact is the first-capture operation that *creates* the retrieval
		// path (tool-output-artifacts.md), so lacking one must not block it.
		const flags = makeFlags({ hasAvailableRetrievalPath: false, artifactStoreAvailable: true });
		expect(evaluateHardConstraints("pack_to_artifact", makeFeatures(), flags)).toEqual([]);
	});

	it("rejects pack_to_artifact when the artifact store is unavailable", () => {
		const flags = makeFlags({ artifactStoreAvailable: false });
		expect(evaluateHardConstraints("pack_to_artifact", makeFeatures(), flags)).toContain("missing_retrieval_path");
	});

	it("does not reject drop_from_prompt for an unavailable artifact store when a retrieval path already exists", () => {
		// drop_from_prompt only needs the existing ref (which may point at the transcript,
		// not the artifact store) to still be able to recover the content.
		const flags = makeFlags({ hasAvailableRetrievalPath: true, artifactStoreAvailable: false });
		expect(evaluateHardConstraints("drop_from_prompt", makeFeatures(), flags)).toEqual([]);
	});

	it("rejects summarizing decision-bearing content with no evidence ref", () => {
		const codes = evaluateHardConstraints(
			"summarize",
			makeFeatures({ isDecisionBearing: true }),
			makeFlags({ hasEvidenceRefForSummary: false }),
		);
		expect(codes).toContain("missing_retrieval_path");
	});

	it("does not require an evidence ref to summarize non-decision-bearing content", () => {
		const codes = evaluateHardConstraints(
			"summarize",
			makeFeatures({ isDecisionBearing: false }),
			makeFlags({ hasEvidenceRefForSummary: false }),
		);
		expect(codes).not.toContain("missing_retrieval_path");
	});
});

describe("evaluateHardConstraints: cheap model routing", () => {
	it("rejects route_cheap for high or unknown task risk", () => {
		expect(evaluateHardConstraints("route_cheap", makeFeatures({ taskRisk: "high" }), makeFlags())).toContain(
			"unknown_risk",
		);
		expect(evaluateHardConstraints("route_cheap", makeFeatures({ taskRisk: "unknown" }), makeFlags())).toContain(
			"unknown_risk",
		);
		expect(evaluateHardConstraints("route_cheap", makeFeatures(), makeFlags())).toContain("unknown_risk");
	});

	it("allows route_cheap for low risk, narrow, validated, enforced work", () => {
		const codes = evaluateHardConstraints("route_cheap", makeFeatures({ taskRisk: "low" }), makeFlags());
		expect(codes).toEqual([]);
	});

	it("rejects route_cheap when path/tool boundaries are not enforced", () => {
		const codes = evaluateHardConstraints(
			"route_cheap",
			makeFeatures({ taskRisk: "low" }),
			makeFlags({ pathOrToolBoundariesEnforced: false }),
		);
		expect(codes).toContain("path_or_tool_scope");
	});

	it("rejects route_cheap after a prior reasoning/architecture failure", () => {
		const codes = evaluateHardConstraints(
			"route_cheap",
			makeFeatures({ taskRisk: "low" }),
			makeFlags({ priorAttemptFailedForReasoningOrArchitecture: true }),
		);
		expect(codes).toContain("unknown_risk");
	});
});

describe("context retention break-even math", () => {
	it("computes positive saving when raw tokens dwarf compact tokens over many turns", () => {
		const saving = computeContextRetentionSaving({
			rawTokens: 5000,
			compactTokens: 100,
			expectedRemainingTurns: 10,
			marginalInputTokenCost: 1,
			packCostTokens: 50,
			probabilityNeededAgain: 0.05,
			retrievalCostTokens: 100,
			probabilityErrorIfDropped: 0.01,
			errorCostTokens: 1000,
			cacheImpactTokens: 0,
		});
		expect(saving).toBeGreaterThan(0);
	});

	it("computes negative saving when remaining turns are too few to amortize one-time costs", () => {
		const saving = computeContextRetentionSaving({
			rawTokens: 5000,
			compactTokens: 4900,
			expectedRemainingTurns: 1,
			marginalInputTokenCost: 1,
			packCostTokens: 500,
			probabilityNeededAgain: 0.5,
			retrievalCostTokens: 1000,
			probabilityErrorIfDropped: 0.2,
			errorCostTokens: 2000,
			cacheImpactTokens: 0,
		});
		expect(saving).toBeLessThan(0);
	});

	it("break-even turns is +Infinity when raw and compact tokens are equal", () => {
		const turns = computeBreakEvenRemainingTurns({
			rawTokens: 1000,
			compactTokens: 1000,
			marginalInputTokenCost: 1,
			packCostTokens: 10,
			probabilityNeededAgain: 0.1,
			retrievalCostTokens: 50,
			probabilityErrorIfDropped: 0.05,
			errorCostTokens: 100,
			cacheImpactTokens: 0,
			margin: 0,
		});
		expect(turns).toBe(Number.POSITIVE_INFINITY);
	});

	it("packing at or beyond the break-even point yields non-negative saving", () => {
		const inputs = {
			rawTokens: 5000,
			compactTokens: 200,
			marginalInputTokenCost: 1,
			packCostTokens: 50,
			probabilityNeededAgain: 0.1,
			retrievalCostTokens: 200,
			probabilityErrorIfDropped: 0.02,
			errorCostTokens: 500,
			cacheImpactTokens: 10,
			margin: 5,
		};
		const breakEven = computeBreakEvenRemainingTurns(inputs);
		const saving = computeContextRetentionSaving({ ...inputs, expectedRemainingTurns: Math.ceil(breakEven) });
		expect(saving).toBeGreaterThanOrEqual(inputs.margin);
	});
});

describe("hard output cap override", () => {
	it("forces packing when raw tokens exceed the cap on a non-pinned, non-current, non-latest-failure item", () => {
		expect(
			exceedsHardOutputCap(50_000, 10_000, { isPinned: false, isCurrentDiff: false, isLatestFailure: false }),
		).toBe(true);
	});

	it("never forces packing on pinned, current, or latest-failure items regardless of size", () => {
		expect(
			exceedsHardOutputCap(50_000, 10_000, { isPinned: true, isCurrentDiff: false, isLatestFailure: false }),
		).toBe(false);
		expect(
			exceedsHardOutputCap(50_000, 10_000, { isPinned: false, isCurrentDiff: true, isLatestFailure: false }),
		).toBe(false);
		expect(
			exceedsHardOutputCap(50_000, 10_000, { isPinned: false, isCurrentDiff: false, isLatestFailure: true }),
		).toBe(false);
	});

	it("does not force packing under the cap", () => {
		expect(
			exceedsHardOutputCap(5000, 10_000, { isPinned: false, isCurrentDiff: false, isLatestFailure: false }),
		).toBe(false);
	});
});

describe("scoreContextRetentionCandidate: hard constraints override savings", () => {
	it("never applies drop_from_prompt on a pinned item even with a huge apparent saving", () => {
		const candidate = scoreContextRetentionCandidate({
			action: "drop_from_prompt",
			features: makeFeatures({ isPinned: true }),
			flags: makeFlags(),
			saving: {
				rawTokens: 1_000_000,
				compactTokens: 0,
				expectedRemainingTurns: 1000,
				marginalInputTokenCost: 1,
				packCostTokens: 0,
				probabilityNeededAgain: 0,
				retrievalCostTokens: 0,
				probabilityErrorIfDropped: 0,
				errorCostTokens: 0,
				cacheImpactTokens: 0,
			},
			margin: 0,
			confidence: "high",
		});

		expect(candidate.expectedSavingsTokens).toBe(0);
		expect(candidate.expectedCostTokens).toBe(Number.POSITIVE_INFINITY);
		expect(candidate.reasonCodes).toContain("pinned_user_instruction");
	});

	it("applies pack_to_artifact when hard constraints clear and saving exceeds margin", () => {
		const candidate = scoreContextRetentionCandidate({
			action: "pack_to_artifact",
			features: makeFeatures(),
			flags: makeFlags(),
			saving: {
				rawTokens: 5000,
				compactTokens: 100,
				expectedRemainingTurns: 10,
				marginalInputTokenCost: 1,
				packCostTokens: 50,
				probabilityNeededAgain: 0.05,
				retrievalCostTokens: 100,
				probabilityErrorIfDropped: 0.01,
				errorCostTokens: 1000,
				cacheImpactTokens: 0,
			},
			margin: 10,
			confidence: "high",
		});

		expect(candidate.expectedSavingsTokens).toBeGreaterThan(0);
		expect(candidate.reasonCodes).toEqual(["saving_above_margin"]);
	});

	it("flags low-confidence decision-bearing summaries even when the raw saving math is positive", () => {
		const candidate = scoreContextRetentionCandidate({
			action: "summarize",
			features: makeFeatures({ isDecisionBearing: true }),
			flags: makeFlags(),
			saving: {
				rawTokens: 5000,
				compactTokens: 100,
				expectedRemainingTurns: 10,
				marginalInputTokenCost: 1,
				packCostTokens: 50,
				probabilityNeededAgain: 0.05,
				retrievalCostTokens: 100,
				probabilityErrorIfDropped: 0.01,
				errorCostTokens: 1000,
				cacheImpactTokens: 0,
			},
			margin: 10,
			confidence: "low",
		});

		expect(candidate.reasonCodes).toEqual(["low_confidence_decision_bearing"]);
	});
});

describe("reason-code formatting", () => {
	it("formats every hard-constraint code as non-empty human text", () => {
		const codes: Parameters<typeof formatHardConstraintReason>[0][] = [
			"pinned_user_instruction",
			"approval_or_denial",
			"safety_constraint",
			"open_requirement",
			"active_blocker",
			"latest_unresolved_failure",
			"current_diff_summary",
			"current_validation_result",
			"missing_retrieval_path",
			"path_or_tool_scope",
			"unknown_risk",
		];
		for (const code of codes) {
			expect(formatHardConstraintReason(code).length).toBeGreaterThan(0);
		}
	});

	it("gives current_diff_summary and current_validation_result distinct reason text", () => {
		expect(formatHardConstraintReason("current_diff_summary")).not.toBe(
			formatHardConstraintReason("current_validation_result"),
		);
	});

	it("formats a rejected candidate's reason with the underlying hard-constraint text", () => {
		const text = formatCandidateReason({ action: "drop_from_prompt", reasonCodes: ["pinned_user_instruction"] });
		expect(text).toContain("drop_from_prompt rejected");
		expect(text).toContain("pinned user instruction");
	});

	it("formats an applied candidate's reason without hard-constraint prefixing", () => {
		const text = formatCandidateReason({ action: "pack_to_artifact", reasonCodes: ["saving_above_margin"] });
		expect(text).toBe("pack_to_artifact: saving_above_margin");
	});
});
