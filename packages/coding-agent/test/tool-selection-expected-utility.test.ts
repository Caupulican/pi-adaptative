import { describe, expect, it } from "vitest";
import {
	betaSuccessProbability,
	DEFAULT_EXPECTED_UTILITY_WEIGHTS,
	decideExpectedUtility,
	normalizedEntropy,
	rankExpectedUtilityCandidates,
} from "../src/core/tool-selection/expected-utility.ts";

const candidate = (
	tool: string,
	overrides: Partial<Parameters<typeof rankExpectedUtilityCandidates>[0][number]> = {},
) => ({
	tool,
	value: 0.8,
	alpha: 1,
	beta: 1,
	sampleCount: 0,
	...overrides,
});

describe("expected utility tool selection", () => {
	it("calculates a beta posterior and normalized entropy", () => {
		expect(betaSuccessProbability(3, 1)).toBe(0.75);
		expect(normalizedEntropy([1, 0])).toBe(0);
		expect(normalizedEntropy([0.5, 0.5])).toBeCloseTo(1);
	});

	it("normalizes costs and ranks a positive best candidate", () => {
		const ranked = rankExpectedUtilityCandidates([
			candidate("read", { alpha: 5, beta: 1, sampleCount: 5, latencyMs: 10_000, tokenEstimate: 2_000 }),
			candidate("search", { alpha: 1, beta: 5, sampleCount: 5 }),
		]);
		expect(ranked[0]?.tool).toBe("read");
		expect(ranked[0]?.latencyCost).toBe(1);
		expect(ranked[0]?.tokenCost).toBe(1);
	});

	it("recommends a positive candidate with evidence and margin", () => {
		const decision = decideExpectedUtility([candidate("read", { alpha: 10, beta: 1, sampleCount: 10 })], {
			...DEFAULT_EXPECTED_UTILITY_WEIGHTS,
			highEntropy: 0.99,
		});
		expect(decision.disposition).toBe("recommend");
		expect(decision.recommendation).toBe("read");
	});

	it("shortlists ties and high-entropy candidates", () => {
		const decision = decideExpectedUtility([candidate("read"), candidate("search"), candidate("find")]);
		expect(decision.disposition).toBe("shortlist");
		expect(decision.shortlist).toHaveLength(3);
	});

	it("abstains without evidence and when every utility is non-positive", () => {
		expect(decideExpectedUtility([candidate("read")]).disposition).toBe("abstain");
		expect(
			decideExpectedUtility([candidate("read", { value: 0 }), candidate("no_tool", { value: 0 })]).disposition,
		).toBe("abstain");
	});

	it("allows a deterministic match to override the evidence threshold", () => {
		const decision = decideExpectedUtility([candidate("read", { deterministicMatch: true })]);
		expect(decision.disposition).toBe("recommend");
		expect(decision.recommendation).toBe("read");
	});

	it("supports no_tool as a normal candidate", () => {
		const ranked = rankExpectedUtilityCandidates([
			candidate("no_tool", { successProbability: 1, value: 0.4, latencyMs: 0, tokenEstimate: 0 }),
		]);
		expect(ranked[0]?.tool).toBe("no_tool");
		expect(ranked[0]?.latencyCost).toBe(0);
	});
});
