import { describe, expect, it } from "vitest";
import { calculateCost as catalogCalculateCost } from "../src/models.ts";
import { calculateCost, createEmptyUsage } from "../src/usage.ts";

describe("usage zero state", () => {
	it("shares the cost calculator with the model catalog entrypoint", () => {
		expect(catalogCalculateCost).toBe(calculateCost);
	});
	it("creates independent complete zero states for every package consumer", () => {
		const first = createEmptyUsage();
		const second = createEmptyUsage();

		first.input = 7;
		first.cost.input = 3;

		expect(second).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
});
