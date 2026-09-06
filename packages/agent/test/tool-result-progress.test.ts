import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { ToolResultProgressTracker } from "../src/tool-result-progress.ts";
import type { AgentToolCall } from "../src/types.ts";

function batch(names: string[], revision = "original"): [AgentToolCall[], ToolResultMessage[]] {
	return [
		names.map((name) => ({ type: "toolCall", id: name, name: "read", arguments: { path: name } })),
		names.map((name) => ({
			role: "toolResult",
			toolCallId: name,
			toolName: "read",
			isError: false,
			timestamp: 1,
			content: [{ type: "text", text: `${name}: ${revision}` }],
		})),
	];
}

describe("observable tool progress", () => {
	it("counts unchanged operations independently of their batch order and size", () => {
		const tracker = new ToolResultProgressTracker();
		expect(tracker.observe(...batch(["alpha", "beta", "gamma"]))).toBe(0);
		expect(tracker.observe(...batch(["gamma", "beta"]))).toBe(1);
		expect(tracker.observe(...batch(["alpha", "gamma"]))).toBe(2);
		expect(tracker.observe(...batch(["beta"]))).toBe(3);
	});
	it("resets stagnation when any operation returns new content or has a new target", () => {
		const tracker = new ToolResultProgressTracker();
		expect(tracker.observe(...batch(["alpha", "beta"]))).toBe(0);
		expect(tracker.observe(...batch(["alpha"]))).toBe(1);
		expect(tracker.observe(...batch(["alpha"], "edited"))).toBe(0);
		expect(tracker.observe(...batch(["alpha"], "edited"))).toBe(1);
		expect(tracker.observe(...batch(["gamma"]))).toBe(0);
	});
	it.each(["duplicate_call", "duplicate_result", "wrong_tool", "missing_result", "extra_result"])(
		"refuses to treat incoherent results as progress evidence (%s)",
		(kind) => {
			const tracker = new ToolResultProgressTracker();
			tracker.observe(...batch(["alpha"]));
			expect(tracker.observe(...batch(["alpha"]))).toBe(1);
			const [calls, results] = batch(["alpha", "beta"]);
			if (kind === "duplicate_call") calls[1] = calls[0]!;
			if (kind === "duplicate_result") results[1] = results[0]!;
			if (kind === "wrong_tool") results[0]!.toolName = "write";
			if (kind === "missing_result") results.pop();
			if (kind === "extra_result") results.push(results[0]!);
			expect(tracker.observe(calls, results)).toBe(0);
			expect(tracker.observe(...batch(["alpha"]))).toBe(0);
		},
	);
	it("expires old observations and refuses oversized batches", () => {
		const tracker = new ToolResultProgressTracker();
		tracker.observe(...batch(["original"]));
		for (let index = 0; index < 13; index++) tracker.observe(...batch([`new-file-${index}`]));
		expect(tracker.observe(...batch(["original"]))).toBe(0);
		expect(tracker.observe(...batch(["original"]))).toBe(1);
		expect(tracker.observe(...batch(Array.from({ length: 257 }, (_, index) => `file-${index}`)))).toBe(0);
		expect(tracker.observe(...batch(["original"]))).toBe(0);
	});
});
