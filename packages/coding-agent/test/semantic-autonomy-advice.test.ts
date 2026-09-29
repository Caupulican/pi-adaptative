import { describe, expect, it } from "vitest";
import { SemanticProjectRuleController } from "../src/core/project-rules/semantic-project-rule-controller.ts";
import { SessionProjectRules } from "../src/core/project-rules/session-project-rules.ts";
import type { SemanticRule } from "../src/core/project-rules/types.ts";
import { decideFinalCompletion } from "../src/core/system-one/policy.ts";

const rule: SemanticRule = {
	schema_version: "1.0",
	rule_id: "owner-rule",
	source: { path: "/repo/AGENTS.md" },
	text: "Never claim an unverified runtime result.",
	phase: "completion",
	consequence: "critical",
	owner: "jev",
	enabled: true,
};

describe("semantic judgments require autonomous verification", () => {
	it.each(["task_postflight", "completion"] as const)(
		"rechecks %s against the current verification receipts",
		async (phase) => {
			const receipt = { check: "regression", status: "passed", revision: "after-revision" };
			let received: unknown;
			const controller = new SemanticProjectRuleController({
				initialRules: [{ ...rule, phase }],
				decisionEngine: {
					evaluate: async (_program, state) => {
						received = state?.evidence;
						return { answers: { "violate::owner-rule": { value: false } } };
					},
				},
			});
			const input = {
				objectiveId: "goal",
				taskId: "task",
				changedFiles: [],
				artifacts: [receipt],
				evidence: [receipt],
			};
			if (phase === "task_postflight") await controller.validateTaskPostflight(input);
			else await controller.validateCompletion(input);
			expect(received).toEqual([receipt]);
		},
	);
	it.each(["violation", "outage"] as const)(
		"distinguishes a %s from an independently confirmed defect",
		async (outcome) => {
			const controller = new SemanticProjectRuleController({
				initialRules: [rule],
				decisionEngine: {
					evaluate: async () => {
						if (outcome === "outage") throw new Error("decision service unavailable");
						return { answers: { "violate::owner-rule": { value: true } } };
					},
				},
			});
			for (let attempt = 0; attempt < 4; attempt++) {
				const result = await controller.validateCompletion({ objectiveId: "goal", changedFiles: [] });
				expect(result.passed).toBe(false);
				expect(SessionProjectRules.blocks(result)).toBe(outcome === "violation");
				expect(result.repairWork).toBeUndefined();
				if (outcome === "outage") {
					expect(result.advisory).toBe(true);
					expect(result.summaryEvent).toContain("decision service unavailable");
				} else {
					expect(result.verificationRequired).toBe(true);
					expect(result.summaryEvent).toContain("Verify");
				}
			}
		},
	);

	it("retains a deterministic instruction violation and its corrective work", async () => {
		const controller = new SemanticProjectRuleController({
			initialRules: [
				{ ...rule, phase: "mutation", owner: "deterministic", deterministic_check: { pattern: "forbidden" } },
			],
		});
		const result = await controller.validateMutation({
			objectiveId: "goal",
			changedFiles: ["owner.ts"],
			diffContent: "forbidden",
		});
		expect(SessionProjectRules.blocks(result)).toBe(true);
		expect(result.repairWork).toBeDefined();
	});

	it.each(["mutation", "task_postflight", "completion"] as const)(
		"retains cancellation during %s advice",
		async (phase) => {
			const abort = new AbortController();
			const cancelled = new Error("owner cancelled");
			const controller = new SemanticProjectRuleController({
				initialRules: [{ ...rule, phase }],
				decisionEngine: {
					evaluate: async (_program, _state, options) => {
						expect(options?.signal).toBe(abort.signal);
						abort.abort(cancelled);
						throw cancelled;
					},
				},
			});
			const input = { objectiveId: "goal", taskId: "task", changedFiles: [], signal: abort.signal };
			const result =
				phase === "mutation"
					? controller.validateMutation(input)
					: phase === "task_postflight"
						? controller.validateTaskPostflight(input)
						: controller.validateCompletion(input);
			await expect(result).rejects.toBe(cancelled);
			expect(controller.getRepairLog()).toEqual([]);
		},
	);

	it.each([true, { value: true }, { noul: 0.99 }, { noul: 0.5 }, { value: "true" }])(
		"requires verification of a positive or unsettled certificate answer %j",
		async (answer) => {
			const controller = new SemanticProjectRuleController({
				initialRules: [rule],
				steering: {
					requireCertificate: async () => ({
						certificate_id: "certificate",
						answers: { "violate::owner-rule": answer },
					}),
				},
			});
			const result = await controller.validateCompletion({ objectiveId: "goal", changedFiles: [] });
			expect(SessionProjectRules.blocks(result)).toBe(true);
			expect(result.verificationRequired).toBe(true);
			expect(result.repairWork).toBeUndefined();
			expect(result.violations).toHaveLength(1);
		},
	);

	it("requires verification of the session's uncertain completion findings before completion", () => {
		const verdict = decideFinalCompletion({
			deterministicGates: [{ id: "G-TEST", kind: "deterministic", required: true, status: "passed" }],
			primaryAnswers: {
				outcomes_achieved: true,
				root_cause_addressed: 0.64,
				required_behavior_unverified: 0.56,
				material_claim_unsupported: false,
				out_of_scope_change_present: 0.77,
				duplicate_responsibility_introduced: false,
				completion_verdict: {
					choice: "complete",
					confidence: 0.58,
					probabilities: { complete: 0.58, verify_more: 0.42 },
				},
			},
			challengeAnswers: {
				missing_requirement: false,
				hidden_assumption: 0.62,
				plausible_regression_not_tested: 0.55,
				conclusion_overstates_evidence: false,
			},
			isBugFix: true,
		});
		expect(verdict.verdict).toBe("verify_more");
		expect(verdict).toMatchObject({
			failed_gates: expect.arrayContaining([
				expect.objectContaining({ id: "JEV-out_of_scope_change_present" }),
				expect.objectContaining({ id: "JEV-CHALLENGE-hidden_assumption" }),
			]),
		});
	});

	it.each([false, { value: false }, { noul: 0.01 }])("accepts an established negative control %j", async (answer) => {
		const controller = new SemanticProjectRuleController({
			initialRules: [rule],
			steering: {
				requireCertificate: async () => ({
					certificate_id: "negative",
					answers: { "violate::owner-rule": answer },
				}),
			},
		});
		const result = await controller.validateCompletion({ objectiveId: "goal", changedFiles: [] });
		expect(result.passed).toBe(true);
		expect(SessionProjectRules.blocks(result)).toBe(false);
		expect(result.repairWork).toBeUndefined();
	});

	it("still refuses a recorded test failure regardless of semantic answers", () => {
		const verdict = decideFinalCompletion({
			deterministicGates: [
				{ id: "G-TEST", kind: "deterministic", required: true, status: "failed", details: "regression failed" },
			],
			primaryAnswers: {},
			challengeAnswers: {},
			isBugFix: false,
		});
		expect(verdict).toMatchObject({
			verdict: "rework",
			failed_gates: [{ id: "G-TEST", reason: "regression failed" }],
		});
	});
});
