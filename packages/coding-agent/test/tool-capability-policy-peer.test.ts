import { describe, expect, it } from "vitest";
import { resolveToolCallCapabilities } from "../src/core/tool-capability-policy.ts";

describe("peer action authority", () => {
	it.each([
		undefined,
		{ action: "options" },
		{ action: "obligations" },
		{ action: "review", review: {} },
		{ action: "review", review: { selection: "independent" } },
	])("admits ordinary review and inspection with delegation authority: %j", (args) => {
		expect(resolveToolCallCapabilities(["workflow.delegate"], "peer", args)).toEqual(["workflow.delegate"]);
		expect(resolveToolCallCapabilities(["semantic.judge"], "peer", args)).toBeUndefined();
	});

	it.each([{ action: "review", review: { selection: "stronger" } }, { action: "resolve" }])(
		"requires semantic authority for strength judgments and proof resolution: %j",
		(args) => {
			expect(resolveToolCallCapabilities(["workflow.delegate"], "peer", args)).toBeUndefined();
			expect(resolveToolCallCapabilities(["semantic.judge"], "peer", args)).toBeUndefined();
			expect(resolveToolCallCapabilities(["workflow.delegate", "semantic.judge"], "peer", args)).toEqual([
				"workflow.delegate",
				"semantic.judge",
			]);
		},
	);
});
