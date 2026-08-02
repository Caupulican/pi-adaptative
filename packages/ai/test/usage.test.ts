import { describe, expect, it } from "vitest";
import { createEmptyUsage } from "../src/usage.ts";

describe("usage zero state", () => {
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
