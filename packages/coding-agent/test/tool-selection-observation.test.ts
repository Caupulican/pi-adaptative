import { expect, it, vi } from "vitest";
import type { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import {
	estimateContentTokens,
	ToolSelectionController,
} from "../src/core/tool-selection/tool-selection-controller.ts";

it("skips argument serialization, tool queries and stats reads when observations are disabled", () => {
	const getActiveTools = vi.fn(() => []);
	const getStatsForIntent = vi.fn(() => []);
	const args = { toJSON: vi.fn(() => ({ path: "a.txt" })) };
	const controller = new ToolSelectionController({
		store: { getStatsForIntent } as unknown as ToolPerformanceStore,
		getActiveTools,
		getModelRef: () => "fixture",
		env: { PI_TOOL_SELECTION_OBSERVE: "0" },
	});

	expect(controller.begin("call", "read", args, { modelRef: "fixture" })).toBeUndefined();
	controller.complete("call", false);
	expect(getActiveTools).not.toHaveBeenCalled();
	expect(getStatsForIntent).not.toHaveBeenCalled();
	expect(args.toJSON).not.toHaveBeenCalled();
});

it("counts UTF-16 text and the same separators for non-text blocks", () => {
	expect(estimateContentTokens([])).toBeUndefined();
	expect(estimateContentTokens([{ type: "image" }])).toBeUndefined();
	expect(estimateContentTokens([{ type: "text", text: "😀😀" }, { type: "image" }])).toBe(2);
});
