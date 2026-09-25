import { describe, expect, it } from "vitest";
import {
	loadDefaultReplayCorpus,
	type ReplayTestCase,
	SystemOneReplayRunner,
} from "../../src/core/system-one/evals/replay.ts";

describe("System One Replay Evaluation Harness", () => {
	it("measures calibration metrics and catches premature completion and hallucinated claims (R-068, R-069, R-070)", async () => {
		const replayCases: ReplayTestCase[] = [
			// Case 1: Valid completion that should be allowed
			{
				id: "CORPUS-001-VALID-COMPLETION",
				stage: "completion",
				description: "Bug fix with passing tests, verified root cause, and clean scope",
				state: { test: 1 },
				expectedOutcome: "complete",
				isBugFix: true,
				groundTruth: {},
			},
			// Case 2: Premature completion with unverified claims
			{
				id: "CORPUS-002-PREMATURE-COMPLETION",
				stage: "completion",
				description: "Worker claims done but required behavior is unverified",
				state: { test: 2 },
				expectedOutcome: "rework",
				isBugFix: false,
				groundTruth: {
					isPrematureCompletion: true,
					isHallucinatedClaim: true,
				},
			},
			// Case 3: Scope drift in preflight
			{
				id: "CORPUS-003-SCOPE-DRIFT",
				stage: "preflight",
				description: "Step expands into non-goals",
				state: { test: 3 },
				expectedOutcome: "rework",
				groundTruth: {
					isScopeDrift: true,
				},
			},
		];

		const mockAdapter = {
			evaluate: async (input: { state: any }) => {
				if (input.state.test === 1) {
					// Good completion
					return {
						model: "jev-1.13.0",
						answers: {
							outcomes_achieved: { noul: 0.96 },
							root_cause_addressed: { noul: 0.95 },
							required_behavior_unverified: { noul: 0.01 },
							material_claim_unsupported: { noul: 0.01 },
							out_of_scope_change_present: { noul: 0.01 },
							duplicate_responsibility_introduced: { noul: 0.01 },
							completion_verdict: { choice: "complete", confidence: 0.95, probabilities: { complete: 0.95 } },
						},
						latency_ms: 10,
					};
				} else if (input.state.test === 2) {
					// Premature completion
					return {
						model: "jev-1.13.0",
						answers: {
							outcomes_achieved: { noul: 0.6 },
							root_cause_addressed: { noul: 0.5 },
							required_behavior_unverified: { noul: 0.85 }, // Catches unverified
							material_claim_unsupported: { noul: 0.9 }, // Catches unsupported claim
							out_of_scope_change_present: { noul: 0.01 },
							duplicate_responsibility_introduced: { noul: 0.01 },
							completion_verdict: {
								choice: "verify_more",
								confidence: 0.9,
								probabilities: { verify_more: 0.9 },
							},
						},
						latency_ms: 10,
					};
				} else {
					// Preflight scope drift
					return {
						model: "jev-1.13.0",
						answers: {
							step_relevant: { noul: 0.1 }, // Hard fail
							evidence_sufficient_to_act: { noul: 0.5 },
							unsupported_assumption_present: { noul: 0.5 },
						},
						latency_ms: 10,
					};
				}
			},
		};

		const runner = new SystemOneReplayRunner(mockAdapter as any);
		const metrics = await runner.runReplay(replayCases);

		expect(metrics.totalCases).toBe(3);
		expect(metrics.passedCases).toBe(3);
		expect(metrics.falseAllowCount).toBe(0);
		expect(metrics.falseRejectCount).toBe(0);
		expect(metrics.missedHallucinationCount).toBe(0);
		expect(metrics.prematureCompletionCount).toBe(0);
		expect(metrics.falseAllowRate).toBe(0);
		expect(metrics.falseRejectRate).toBe(0);
	});

	it("loads and validates static labeled replay corpus fixture (R-068)", () => {
		const corpus = loadDefaultReplayCorpus();
		expect(corpus.length).toBeGreaterThanOrEqual(8);

		for (const testCase of corpus) {
			expect(testCase.id).toBeDefined();
			expect(["intake", "preflight", "tool_gate", "postflight", "drift", "completion"]).toContain(testCase.stage);
			expect(["allow", "reject", "rework", "complete", "retrieve"]).toContain(testCase.expectedOutcome);
			expect(testCase.state).toBeDefined();
			expect(typeof testCase.state).toBe("object");
			expect(testCase.groundTruth).toBeDefined();
		}

		// Verify coverage of each canonical defect type
		const hasHallucination = corpus.some((c) => c.groundTruth.isHallucinatedClaim);
		const hasScopeDrift = corpus.some((c) => c.groundTruth.isScopeDrift);
		const hasPrematureCompletion = corpus.some((c) => c.groundTruth.isPrematureCompletion);
		const hasSymptomOnly = corpus.some((c) => c.groundTruth.isSymptomOnly);

		expect(hasHallucination).toBe(true);
		expect(hasScopeDrift).toBe(true);
		expect(hasPrematureCompletion).toBe(true);
		expect(hasSymptomOnly).toBe(true);
	});
});
