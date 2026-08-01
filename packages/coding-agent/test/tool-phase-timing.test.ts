import { describe, expect, it } from "vitest";
import { ToolPhaseTimings } from "../src/core/tool-selection/tool-phase-timing.ts";

describe("ToolPhaseTimings", () => {
	it("keeps bounded recent samples while retaining the total observation count", () => {
		const timings = new ToolPhaseTimings(4);
		for (const durationMs of [1, 2, 3, 4, 100]) timings.record("selection", durationMs);

		expect(timings.getStats()).toEqual([
			{
				phase: "selection",
				count: 5,
				recentCount: 4,
				p50Ms: 4,
				p95Ms: 100,
				maxMs: 100,
			},
		]);
	});

	it("rejects invalid samples and renders only observed phases", () => {
		const timings = new ToolPhaseTimings();
		timings.record("execution", Number.NaN);
		timings.record("execution", -1);
		timings.record("validation_write", 2.25);

		expect(timings.formatReport()).toContain("validation evidence write: n=1");
		expect(timings.formatReport()).not.toContain("execution:");
	});
});
