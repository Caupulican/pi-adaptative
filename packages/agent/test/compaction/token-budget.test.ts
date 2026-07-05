import { describe, expect, it } from "vitest";
import { TokenBudget } from "../../src/compaction/index.ts";

describe("TokenBudget", () => {
	it("uses the current chars/4 heuristic before anchors are observed", () => {
		const budget = new TokenBudget();
		expect(budget.ratio).toBe(4);
		expect(budget.estimateDelta(1000)).toBe(250);
		expect(budget.current(1000, 2000)).toBe(250);
	});

	it("tracks provider anchors and adds safety margin", () => {
		const budget = new TokenBudget();
		budget.anchor(100, 400);
		expect(budget.ratio).toBe(4);
		expect(budget.current(500, 4000)).toBe(305);
	});

	it("converges toward observed density within five anchors", () => {
		const budget = new TokenBudget();
		for (let i = 0; i < 5; i++) {
			budget.anchor(1000, 3100);
		}

		expect(budget.ratio).toBeGreaterThanOrEqual(3.05);
		expect(budget.ratio).toBeLessThanOrEqual(3.15);
		const estimate = budget.estimateDelta(3100);
		expect(estimate).toBeGreaterThanOrEqual(990);
		expect(estimate).toBeLessThanOrEqual(1010);
	});

	it("clamps impossible observed densities", () => {
		const low = new TokenBudget();
		low.anchor(1000, 1000);
		expect(low.ratio).toBe(2.2);

		const high = new TokenBudget();
		high.anchor(1000, 10000);
		expect(high.ratio).toBe(6);
	});
});
