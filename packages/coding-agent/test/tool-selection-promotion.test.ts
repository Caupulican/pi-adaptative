import { describe, expect, it } from "vitest";
import { evaluateToolPromotion, formatToolSelectionHints } from "../src/core/tool-selection/promotion.ts";
import type { ToolPerformanceStats } from "../src/core/tool-selection/tool-performance-store.ts";

function stats(overrides: Partial<ToolPerformanceStats> & { tool: string }): ToolPerformanceStats {
	return {
		modelRef: "faux/model",
		intentClass: "read",
		alpha: 1,
		beta: 1,
		sampleCount: 0,
		repairCount: 0,
		bounceCount: 0,
		failureCount: 0,
		lastUsedAt: new Date(0).toISOString(),
		...overrides,
	};
}

describe("evaluateToolPromotion", () => {
	it("does not promote an empty bucket", () => {
		const decision = evaluateToolPromotion([]);
		expect(decision.tool).toBeUndefined();
		expect(decision.sampleCount).toBe(0);
	});

	it("does not promote below the minimum-evidence sample count even with a strong success rate", () => {
		// alpha=3,beta=1 after 2 recorded successes (prior alpha=1 + 2) -> sampleCount 2 < minimumEvidence 3.
		const decision = evaluateToolPromotion([stats({ tool: "read_file", alpha: 3, beta: 1, sampleCount: 2 })]);
		expect(decision.tool).toBeUndefined();
	});

	it("promotes a single well-evidenced tool once utility, margin, and evidence all clear the gate", () => {
		const decision = evaluateToolPromotion([stats({ tool: "read_file", alpha: 4, beta: 1, sampleCount: 3 })]);
		expect(decision.tool).toBe("read_file");
		expect(decision.sampleCount).toBe(3);
		expect(decision.margin).toBeGreaterThan(0);
		expect(decision.entropy).toBe(0);
	});

	it("does not promote when two tools are too closely matched (low margin / high entropy)", () => {
		const decision = evaluateToolPromotion([
			stats({ tool: "read_file", alpha: 4, beta: 2, sampleCount: 5 }),
			stats({ tool: "cat_file", alpha: 4, beta: 2, sampleCount: 5 }),
		]);
		expect(decision.tool).toBeUndefined();
	});

	it("promotes the clearly-better of two competing tools once the gap is wide enough to also clear the entropy gate", () => {
		// A modest utility gap (e.g. 10/1 vs 2/8 posteriors) still trips the high-entropy shortlist
		// gate — softmax over bounded [0,1] utilities stays close to 50/50 unless the posteriors are
		// this lopsided. That conservatism is intentional (never a false-confident pick between two
		// genuinely live candidates); this fixture is the point at which it finally clears both gates.
		const decision = evaluateToolPromotion([
			stats({ tool: "read_file", alpha: 199, beta: 1, sampleCount: 198 }),
			stats({ tool: "cat_file", alpha: 1, beta: 199, sampleCount: 198 }),
		]);
		expect(decision.tool).toBe("read_file");
	});

	it("deactivates (both-directions evidence gating): a promoted tool stops being promoted once its own accumulated failures erode margin below threshold", () => {
		const promoted = evaluateToolPromotion([stats({ tool: "flaky_tool", alpha: 4, beta: 1, sampleCount: 3 })]);
		expect(promoted.tool).toBe("flaky_tool");

		// Same tool, now with a much longer failure tail accumulated after promotion — success
		// probability (alpha/(alpha+beta)) has dropped enough that margin no longer clears the gate.
		const degraded = evaluateToolPromotion([stats({ tool: "flaky_tool", alpha: 4, beta: 40, sampleCount: 42 })]);
		expect(degraded.tool).toBeUndefined();
	});
});

describe("formatToolSelectionHints", () => {
	it("renders nothing for an empty hint list", () => {
		expect(formatToolSelectionHints([])).toBeUndefined();
	});

	it("renders a compact block naming the promoted tool per intent", () => {
		const text = formatToolSelectionHints([
			{ modelRef: "faux/model", intentClass: "read", tool: "read_file", sampleCount: 3, margin: 0.6, entropy: 0 },
		]);
		expect(text).toContain("read");
		expect(text).toContain("read_file");
	});

	it("is byte-identical across two builds of the same hint set (cache stability)", () => {
		const hints = [
			{
				modelRef: "faux/model",
				intentClass: "read" as const,
				tool: "read_file",
				sampleCount: 3,
				margin: 0.6,
				entropy: 0,
			},
		];
		expect(formatToolSelectionHints(hints)).toBe(formatToolSelectionHints([...hints]));
	});

	it("omits live evidence numbers, so accumulating more evidence for the SAME winner does not change the text", () => {
		const early = formatToolSelectionHints([
			{ modelRef: "faux/model", intentClass: "read", tool: "read_file", sampleCount: 3, margin: 0.2, entropy: 0 },
		]);
		const later = formatToolSelectionHints([
			{
				modelRef: "faux/model",
				intentClass: "read",
				tool: "read_file",
				sampleCount: 400,
				margin: 0.9,
				entropy: 0.1,
			},
		]);
		expect(later).toBe(early);
	});

	it("changes only when the promoted tool for an intent actually flips", () => {
		const before = formatToolSelectionHints([
			{ modelRef: "faux/model", intentClass: "read", tool: "read_file", sampleCount: 3, margin: 0.2, entropy: 0 },
		]);
		const after = formatToolSelectionHints([
			{ modelRef: "faux/model", intentClass: "read", tool: "cat_file", sampleCount: 3, margin: 0.2, entropy: 0 },
		]);
		expect(after).not.toBe(before);
	});
});
