import { describe, expect, it } from "vitest";
import {
	decidePostflight,
	decidePreflight,
	decideToolGate,
	evaluateChoice,
	evaluateNoul,
} from "../../src/core/system-one/policy.ts";

describe("System One Policy Engine", () => {
	it("distinguishes probability of yes from certainty for Noul (R-038)", () => {
		// required_true: high probability is pass
		expect(evaluateNoul(0.95, "required_true")).toBe("hard_pass");
		expect(evaluateNoul(0.88, "required_true")).toBe("soft_pass");
		expect(evaluateNoul(0.5, "required_true")).toBe("ambiguous");
		expect(evaluateNoul(0.1, "required_true")).toBe("hard_fail");

		// required_false: low probability (e.g. 0.03) is a confident NO -> hard_pass!
		expect(evaluateNoul(0.03, "required_false")).toBe("hard_pass");
		expect(evaluateNoul(0.1, "required_false")).toBe("soft_pass");
		expect(evaluateNoul(0.5, "required_false")).toBe("ambiguous");
		expect(evaluateNoul(0.85, "required_false")).toBe("hard_fail");
	});

	it("evaluates Choice with confidence and top-two margin (R-039)", () => {
		// High confidence with good margin passes
		const goodChoice = evaluateChoice(
			{
				choice: "complete",
				confidence: 0.95,
				probabilities: { complete: 0.95, verify_more: 0.03, rework: 0.02 },
			},
			"hard",
		);
		expect(goodChoice.accepted).toBe(true);
		expect(goodChoice.margin).toBeCloseTo(0.92, 2);

		// Near-tie fails hard gate margin check even if confidence is slightly above threshold
		const nearTieChoice = evaluateChoice(
			{
				choice: "complete",
				confidence: 0.52,
				probabilities: { complete: 0.52, verify_more: 0.48 },
			},
			"hard",
		);
		expect(nearTieChoice.accepted).toBe(false);
		expect(nearTieChoice.reasons).toBeDefined();
	});

	it("routes preflight safely based on evidence and step relevance", () => {
		// Sufficient evidence and relevant step -> allow
		const allowPreflight = decidePreflight({
			step_relevant: { noul: 0.96 },
			evidence_sufficient_to_act: { noul: 0.95 },
			unsupported_assumption_present: { noul: 0.02 },
			route: { choice: "edit", confidence: 0.95, probabilities: { edit: 0.95, test: 0.05 } },
		});
		expect(allowPreflight).toBe("allow");

		// Unsupported assumption treated as fact -> retrieve evidence
		const retrievePreflight = decidePreflight({
			step_relevant: { noul: 0.95 },
			evidence_sufficient_to_act: { noul: 0.2 },
			unsupported_assumption_present: { noul: 0.85 },
		});
		expect(retrievePreflight).toBe("retrieve");

		// Step irrelevant -> replan
		const replanPreflight = decidePreflight({
			step_relevant: { noul: 0.05 },
			evidence_sufficient_to_act: { noul: 0.95 },
			unsupported_assumption_present: { noul: 0.02 },
		});
		expect(replanPreflight).toBe("replan");
	});

	it("blocks prompt injection and fences broad scope in tool gates (R-034, R-065)", () => {
		// Prompt injection attempt in untrusted text
		const injectionOutcome = decideToolGate(
			{
				repo_text_injection_like: { noul: 0.92 },
				tool_call_relevant: { noul: 0.95 },
			},
			"repo_mutation",
		);
		expect(injectionOutcome).toBe("block");

		// Destructive tool with broad semantic scope
		const highRiskOutcome = decideToolGate(
			{
				repo_text_injection_like: { noul: 0.01 },
				tool_call_relevant: { noul: 0.95 },
				tool_call_semantic_scope_risk: { score: 3, confidence: 0.95 },
			},
			"destructive",
		);
		expect(highRiskOutcome).toBe("block");
	});

	it("never replans on relevance when the projection had no step to be relevant to", () => {
		const answers = {
			repo_text_injection_like: { noul: 0.01 },
			tool_call_relevant: { noul: 0.02 },
			tool_call_semantic_scope_risk: { score: 0, confidence: 0.9 },
		};
		expect(decideToolGate(answers, "read_only")).toBe("replan");
		expect(decideToolGate(answers, "read_only", undefined, { relevanceEvaluable: true })).toBe("replan");
		// A plain session: no objective, no plan step. The relevance answer is not evidence.
		expect(decideToolGate(answers, "read_only", undefined, { relevanceEvaluable: false })).toBe("allow");
		expect(
			decideToolGate({ ...answers, repo_text_injection_like: { noul: 0.95 } }, "read_only", undefined, {
				relevanceEvaluable: false,
			}),
		).toBe("block");
	});

	it("routes postflight to rollback on scope violation and replan on invalidation", () => {
		// Scope violation routes to rollback
		const rollbackPost = decidePostflight({
			scope_violation: { noul: 0.92 },
			replan_required: { noul: 0.02 },
			conclusions_supported: { noul: 0.95 },
		});
		expect(rollbackPost).toBe("rollback");

		// Plan invalidation routes to replan
		const replanPost = decidePostflight({
			scope_violation: { noul: 0.01 },
			replan_required: { noul: 0.9 },
			conclusions_supported: { noul: 0.95 },
		});
		expect(replanPost).toBe("replan");
	});
});
