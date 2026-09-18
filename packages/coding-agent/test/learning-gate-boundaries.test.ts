import { describe, expect, it } from "vitest";
import { isLearningAuditRecord } from "../src/core/learning/learning-audit.ts";
import {
	evaluateLearningDecision,
	isLearningDecision,
	type LearningGateSettings,
} from "../src/core/learning/learning-gate.ts";

const settings: LearningGateSettings = {
	enabled: true,
	autoApplyEnabled: true,
	confidenceThreshold: 90,
	minObservations: 2,
	allowedAutoApplyLayers: ["memory"],
	requireEvidence: true,
};
const eligible = {
	proposal: { id: "proposal", layer: "memory" as const, summary: "A fact", evidenceIds: ["receipt-1"] },
	confidence: 95,
	observations: 2,
	contradictions: 0,
	settings,
};

describe("learning evidence boundaries", () => {
	it("retains eligible auto-apply and explicit supersession controls", () => {
		expect(evaluateLearningDecision(eligible).kind).toBe("apply");
		expect(evaluateLearningDecision({ ...eligible, contradictions: 1 }).kind).toBe("proposal");
		expect(
			evaluateLearningDecision({
				...eligible,
				contradictions: 1,
				settings: { ...settings, autoApplySupersessions: true },
			}).kind,
		).toBe("apply");
	});

	it.each([
		{ confidence: Number.NaN },
		{ confidence: Number.POSITIVE_INFINITY },
		{ confidence: -1 },
		{ confidence: 101 },
		{ observations: Number.NaN },
		{ observations: Number.POSITIVE_INFINITY },
		{ observations: -1 },
		{ observations: 2.5 },
		{ contradictions: Number.NaN },
		{ contradictions: Number.POSITIVE_INFINITY },
		{ contradictions: -1 },
		{ contradictions: 0.5 },
	])("requires review for malformed evidence %j", (invalid) => {
		const decision = evaluateLearningDecision({ ...eligible, ...invalid });
		expect(decision.kind).toBe("proposal");
		expect(decision.requiresApproval).toBe(true);
		expect(decision.reasonCode).toBe("invalid_learning_evidence");
		expect(isLearningDecision(decision)).toBe(true);
	});

	it.each([
		{ confidenceThreshold: Number.NaN },
		{ confidenceThreshold: Number.POSITIVE_INFINITY },
		{ confidenceThreshold: -1 },
		{ confidenceThreshold: 101 },
		{ minObservations: Number.NaN },
		{ minObservations: Number.POSITIVE_INFINITY },
		{ minObservations: -1 },
		{ minObservations: 1.5 },
	])("requires review for malformed policy %j", (invalid) => {
		const decision = evaluateLearningDecision({ ...eligible, settings: { ...settings, ...invalid } });
		expect(decision.kind).toBe("proposal");
		expect(decision.requiresApproval).toBe(true);
		expect(decision.reasonCode).toBe("invalid_learning_policy");
	});

	it("keeps disabled learning inert even with malformed evidence", () => {
		const decision = evaluateLearningDecision({
			...eligible,
			confidence: Number.NaN,
			settings: { ...settings, enabled: false },
		});
		expect(decision.kind).toBe("no-op");
		expect(isLearningDecision(decision)).toBe(true);
	});

	it.each([[""], [" \t"], ["receipt-1", ""]])("rejects blank evidence references %j", (...evidenceIds) => {
		const decision = evaluateLearningDecision({
			...eligible,
			proposal: { ...eligible.proposal, evidenceIds },
		});
		expect(decision.kind).toBe("proposal");
		expect(decision.reasonCode).toBe("missing_evidence");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])(
		"uses the same confidence validity rule for decisions and audit replay: %s",
		(confidence) => {
			const decision = { ...evaluateLearningDecision(eligible), confidence };
			expect(isLearningDecision(decision)).toBe(false);
			expect(
				isLearningAuditRecord({
					id: "audit",
					proposalId: "proposal",
					layer: "memory",
					action: "apply",
					summary: "A fact",
					reasonCode: "eligible_auto_apply",
					decision,
					createdAt: "2026-09-17T00:00:00Z",
				}),
			).toBe(false);
		},
	);

	it("rejects contradictory decision with kind apply and requiresApproval true", () => {
		const decision = { ...evaluateLearningDecision(eligible), kind: "apply" as const, requiresApproval: true };
		expect(isLearningDecision(decision)).toBe(false);
	});

	it("rejects contradictory decision with kind proposal and requiresApproval false", () => {
		const decision = { ...evaluateLearningDecision(eligible), kind: "proposal" as const, requiresApproval: false };
		expect(isLearningDecision(decision)).toBe(false);
	});

	it("rejects contradictory decision with kind no-op and requiresApproval true", () => {
		const decision = { ...evaluateLearningDecision(eligible), kind: "no-op" as const, requiresApproval: true };
		expect(isLearningDecision(decision)).toBe(false);
	});
});
