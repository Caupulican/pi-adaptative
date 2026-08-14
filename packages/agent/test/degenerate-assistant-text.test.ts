import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import {
	collapseDegenerateAssistantMessage,
	collapseRepeatedLines,
	isCollapsedDegenerateAssistantMessage,
	shouldAbortDegenerateStream,
} from "../src/degenerate-assistant-text.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("degenerate assistant text", () => {
	it("collapses a consecutive identical-line generation loop", () => {
		const line = "Targeted tests only. Running the four changed-file oracles, then `npm run check`.";
		expect(collapseRepeatedLines(Array.from({ length: 14 }, () => line).join("\n"))).toBe(line);
	});

	it("collapses an alternating two-sentence generation loop", () => {
		const a = "Targeted tests only. Checking how `./test.sh` takes paths, then running the four oracles.";
		const b = "Targeted tests only. Running the four changed-file oracles, then `npm run check`.";
		const looping = Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? a : b)).join("\n");
		expect(collapseRepeatedLines(looping)).toBe(`${a}\n${b}`);
	});

	it("leaves ordinary repeated structure under the run threshold alone", () => {
		const text = ["alpha", "alpha", "alpha", "beta"].join("\n");
		expect(collapseRepeatedLines(text)).toBe(text);
	});

	it("rewrites only the stored assistant text blocks", () => {
		const line = "Edits are in. Running targeted tests, then `npm run check`.";
		const message = collapseDegenerateAssistantMessage(assistant(Array.from({ length: 6 }, () => line).join("\n")));
		expect(message.content).toEqual([{ type: "text", text: line }]);
	});

	it("collapses a single-line sentence generation loop", () => {
		const sentence = "Checking leftover copy, then finishing docs, sitemap, tests, and the message house.";
		const looping = Array.from({ length: 12 }, () => sentence).join(" ");
		expect(collapseRepeatedLines(looping)).toBe(sentence);
		expect(shouldAbortDegenerateStream(looping)).toBe(true);
	});

	it("marks a collapsed generation loop so a leftover copy is not a halt report", () => {
		const line = "Recovery exhausted. recovery_exhausted is not harness failure.";
		const original = assistant(Array.from({ length: 8 }, () => line).join("\n"));
		const collapsed = collapseDegenerateAssistantMessage(original);
		expect(collapsed.content).toEqual([{ type: "text", text: line }]);
		expect(isCollapsedDegenerateAssistantMessage(collapsed)).toBe(true);
		expect(isCollapsedDegenerateAssistantMessage(original)).toBe(false);
		expect(isCollapsedDegenerateAssistantMessage(assistant(line))).toBe(false);
	});
});
