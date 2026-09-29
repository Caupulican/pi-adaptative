import { describe, expect, it } from "vitest";
import { addUsage, createEmptyUsage } from "../src/usage.ts";

describe("usage tier estimate aggregation", () => {
	it("retains uncertainty without mixing metadata into dollar arithmetic", () => {
		const base = createEmptyUsage();
		base.cost.total = 1;
		const estimated = createEmptyUsage();
		estimated.cost.total = 2;
		estimated.cost.estimate = "base-rates";
		addUsage(base, estimated);
		addUsage(base, createEmptyUsage());
		expect(base.cost.total).toBe(3);
		expect(base.cost.estimate).toBe("base-rates");
		expect(createEmptyUsage().cost.estimate).toBeUndefined();
	});
});
