import { describe, expect, it } from "vitest";
import { clampLaneMaxUsd } from "../src/core/background-lane-controller.ts";

describe("background lane budgets", () => {
	it("clamps research lane spend to the foreground envelope cap", () => {
		expect(clampLaneMaxUsd(1.5, 0.25)).toBe(0.25);
		expect(clampLaneMaxUsd(0.1, 0.25)).toBe(0.1);
		expect(clampLaneMaxUsd(0.1, undefined)).toBe(0.1);
	});
});
