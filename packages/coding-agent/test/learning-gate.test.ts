import { describe, expect, it } from "vitest";
import {
	type DurableChangeProposal,
	evaluateLearningDecision,
	type LearningGateSettings,
} from "../src/core/learning/learning-gate.ts";

describe("Learning Gate (Phase 7)", () => {
	const baseProposal: DurableChangeProposal = {
		id: "p1",
		layer: "memory",
		summary: "Learned a new thing",
		evidenceIds: ["ev1"],
		rollbackPlan: "Delete the memory",
	};

	const baseSettings: LearningGateSettings = {
		enabled: true,
		autoApplyEnabled: true,
		confidenceThreshold: 90,
		minObservations: 2,
		allowedAutoApplyLayers: ["memory"],
		requireEvidence: false,
		requireRollbackPlan: false,
	};

	it("disabled settings returns no-op", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, enabled: false },
		});
		expect(decision.kind).toBe("no-op");
		expect(decision.reasonCode).toBe("learning_disabled");
	});

	it("confidence 89 with threshold 90 does not apply (proposes if evidence exists)", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 89,
			observations: 5,
			contradictions: 0,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("below_confidence_threshold");
		expect(decision.requiresApproval).toBe(true);
	});

	it("confidence 89 with threshold 90 proposes (requires approval) even without evidence", () => {
		// Below-threshold learning must be VISIBLE: it degrades to an approval-gated proposal, never a
		// silent no-op. A silent no-op here was the stock-settings cliff (reflectionSourceConfidence 50 <
		// confidenceThreshold 90, reflection writes carry no evidenceIds) that disabled learning entirely.
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, evidenceIds: [] },
			confidence: 89,
			observations: 5,
			contradictions: 0,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("below_confidence_threshold");
		expect(decision.requiresApproval).toBe(true);
	});

	it("confidence 90 with one observation does not auto-apply when min observations is 2", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 90,
			observations: 1,
			contradictions: 0,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("insufficient_observations");
		expect(decision.requiresApproval).toBe(true);
	});

	it("confidence 90 with two observations may apply only eligible memory-level changes", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 90,
			observations: 2,
			contradictions: 0,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("apply");
		expect(decision.reasonCode).toBe("eligible_auto_apply");
		expect(decision.requiresApproval).toBe(false);
	});

	it("autoApplyEnabled false returns proposal, not apply", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 90,
			observations: 2,
			contradictions: 0,
			settings: { ...baseSettings, autoApplyEnabled: false },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("auto_apply_disabled");
		expect(decision.requiresApproval).toBe(true);
	});

	it("contradictions force proposal/approval", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 99,
			observations: 10,
			contradictions: 1,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("contradictions_present");
		expect(decision.requiresApproval).toBe(true);
	});

	it("missing evidence blocks auto-apply when requireEvidence is true", () => {
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, evidenceIds: [] },
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, requireEvidence: true },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("missing_evidence");
		expect(decision.requiresApproval).toBe(true);
	});

	it("missing rollback plan blocks auto-apply when requireRollbackPlan is true", () => {
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, rollbackPlan: undefined },
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, requireRollbackPlan: true },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("missing_rollback_plan");
		expect(decision.requiresApproval).toBe(true);
	});

	it("blank rollback plan blocks auto-apply when requireRollbackPlan is true", () => {
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, rollbackPlan: "   " },
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, requireRollbackPlan: true },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("missing_rollback_plan");
		expect(decision.requiresApproval).toBe(true);
	});

	it("skill/prompt/settings/source/tool/script/extension changes produce proposals by default", () => {
		const layers: Array<"skill" | "prompt" | "extension" | "tool" | "script" | "settings" | "source"> = [
			"skill",
			"prompt",
			"extension",
			"tool",
			"script",
			"settings",
			"source",
		];

		for (const layer of layers) {
			const decision = evaluateLearningDecision({
				proposal: { ...baseProposal, layer },
				confidence: 95,
				observations: 5,
				contradictions: 0,
				settings: baseSettings, // 'memory' is the only allowed layer
			});
			expect(decision.kind).toBe("proposal");
			expect(decision.reasonCode).toBe("layer_not_allowed_for_auto_apply");
			expect(decision.requiresApproval).toBe(true);
		}
	});

	it("explicitly allowed memory layer can apply; disallowed memory layer proposes", () => {
		const allowedDecision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, allowedAutoApplyLayers: ["memory"] },
		});
		expect(allowedDecision.kind).toBe("apply");

		const disallowedDecision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: { ...baseSettings, allowedAutoApplyLayers: [] },
		});
		expect(disallowedDecision.kind).toBe("proposal");
		expect(disallowedDecision.reasonCode).toBe("layer_not_allowed_for_auto_apply");
	});

	it("bounds decision summaries while preserving the proposal summary prefix", () => {
		const longSummary = "x".repeat(300);
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, summary: longSummary },
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings: baseSettings,
		});
		expect(decision.summary.length).toBeLessThanOrEqual(240);
		expect(decision.summary.startsWith("x".repeat(20))).toBe(true);
		expect(decision.summary.endsWith("…")).toBe(true);
	});

	it("function does not mutate proposal.evidenceIds or settings.allowedAutoApplyLayers", () => {
		const evidenceIds = ["ev1", "ev2"];
		const allowedLayers = ["memory" as const];

		const proposal = { ...baseProposal, evidenceIds };
		const settings = { ...baseSettings, allowedAutoApplyLayers: allowedLayers };

		evaluateLearningDecision({
			proposal,
			confidence: 95,
			observations: 5,
			contradictions: 0,
			settings,
		});

		expect(proposal.evidenceIds).toBe(evidenceIds);
		expect(settings.allowedAutoApplyLayers).toBe(allowedLayers);
	});

	it("autoApplySupersessions true: a contradiction falls through to the standard eligibility chain and can apply", () => {
		// Bug F: a memory_replace/memory_remove (contradictions > 0) is the reflection engine's
		// confront-before-write signal — but with the opt-in enabled and every other gate satisfied,
		// updating/deleting a stale fact must be no harder than adding a new contradicting one.
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 90,
			observations: 2,
			contradictions: 1,
			settings: { ...baseSettings, autoApplySupersessions: true },
		});
		expect(decision.kind).toBe("apply");
		expect(decision.reasonCode).toBe("eligible_auto_apply");
		expect(decision.requiresApproval).toBe(false);
	});

	it("autoApplySupersessions true but below the confidence threshold: still proposes (fell through, not skipped)", () => {
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 50,
			observations: 2,
			contradictions: 1,
			settings: { ...baseSettings, autoApplySupersessions: true },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("below_confidence_threshold");
		expect(decision.requiresApproval).toBe(true);
	});

	it("autoApplySupersessions defaults to falsy: contradictions still force a proposal unchanged", () => {
		// baseSettings does not set autoApplySupersessions — the existing default-behavior contract
		// (supersession always proposes) must stay intact for anyone not opting in.
		const decision = evaluateLearningDecision({
			proposal: baseProposal,
			confidence: 99,
			observations: 10,
			contradictions: 1,
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("contradictions_present");
	});

	it("duplicate/paraphrased memory support can be represented as proposal.layer memory plus contradiction/evidence policy", () => {
		// Just proving we can use the layer and contradictions to enforce policy
		const decision = evaluateLearningDecision({
			proposal: { ...baseProposal, layer: "memory", evidenceIds: ["ev-duplicate"] },
			confidence: 95,
			observations: 5,
			contradictions: 1, // represents paraphrasing conflict
			settings: baseSettings,
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("contradictions_present");
	});
});
