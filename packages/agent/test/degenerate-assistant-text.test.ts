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

	it("collapses a status sentence concatenated with no space", () => {
		const sentence = "Session ended mid-implementation. Checking the written plan and what actually landed.";
		expect(collapseRepeatedLines(sentence + sentence)).toBe(sentence);
		expect(collapseRepeatedLines(sentence.repeat(4))).toBe(sentence);
	});

	it("drops a later tool call that repeats an earlier execution identity", () => {
		const original = assistant("");
		const first = {
			type: "toolCall" as const,
			id: "call-1",
			name: "python",
			arguments: { code: "print(1)", timeout: 30 },
		};
		original.content = [
			first,
			{
				type: "toolCall",
				id: "call-2",
				name: "python",
				arguments: { code: "print(1)", timeout: 90 },
			},
			{
				type: "toolCall",
				id: "call-3",
				name: "python",
				arguments: { code: "print(2)" },
			},
		];
		const collapsed = collapseDegenerateAssistantMessage(original);
		expect(collapsed.content).toEqual([
			first,
			{
				type: "toolCall",
				id: "call-3",
				name: "python",
				arguments: { code: "print(2)" },
			},
		]);
		expect(isCollapsedDegenerateAssistantMessage(collapsed)).toBe(true);
	});

	it("drops a later text block that repeats an earlier block around tool calls", () => {
		const sentence = "Session ended mid-implementation. Checking the written plan and what actually landed.";
		const doubled = sentence + sentence;
		const original = assistant("");
		original.content = [
			{ type: "text", text: doubled },
			{
				type: "toolCall",
				id: "call-1",
				name: "python",
				arguments: { code: "print(1)" },
			},
			{ type: "text", text: doubled },
		];
		const collapsed = collapseDegenerateAssistantMessage(original);
		expect(collapsed.content).toEqual([{ type: "text", text: sentence }, original.content[1]]);
		expect(isCollapsedDegenerateAssistantMessage(collapsed)).toBe(true);
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
