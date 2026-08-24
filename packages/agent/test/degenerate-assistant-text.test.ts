import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import {
	assistantMessageText,
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

	it("collapses repeated thinking and exposes it to the live-stream loop guard", () => {
		const line =
			"The product test is passing. Re-running the live card, then recording evidence and finishing the remaining work.";
		const looping = Array.from({ length: 14 }, () => line).join("\n");
		const original = assistant("");
		original.content = [{ type: "thinking", thinking: looping, thinkingSignature: "reasoning_content" }];

		const collapsed = collapseDegenerateAssistantMessage(original);

		expect(collapsed.content).toEqual([{ type: "thinking", thinking: line, thinkingSignature: "reasoning_content" }]);
		expect(assistantMessageText(original)).toBe(looping);
		expect(shouldAbortDegenerateStream(assistantMessageText(original))).toBe(true);
		expect(isCollapsedDegenerateAssistantMessage(collapsed)).toBe(true);
	});

	it("keeps opaque signed thinking byte-for-byte for provider replay", () => {
		const line = "Signed reasoning must remain byte-for-byte stable for replay.";
		const original = assistant("");
		original.api = "anthropic-messages";
		original.content = [
			{
				type: "thinking",
				thinking: Array.from({ length: 8 }, () => line).join("\n"),
				thinkingSignature: "opaque-cryptographic-signature",
			},
		];

		expect(collapseDegenerateAssistantMessage(original)).toBe(original);
	});

	it("keeps distinct reasoning items even when their summaries match", () => {
		const original = assistant("");
		original.content = [
			{ type: "thinking", thinking: "Same summary.", thinkingSignature: '{"id":"reasoning-1"}' },
			{ type: "thinking", thinking: "Same summary.", thinkingSignature: '{"id":"reasoning-2"}' },
		];

		expect(collapseDegenerateAssistantMessage(original)).toBe(original);
	});

	it("collapses repeated thinking across tool turns while retaining the tool call", () => {
		const line = "The operation was rejected. I will inspect the result and correct the request.";
		const previous = assistant("");
		previous.content = [
			{ type: "thinking", thinking: line, thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
		];
		const current = assistant("");
		current.content = [
			{ type: "thinking", thinking: line, thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/file.ts" } },
		];

		expect(collapseDegenerateAssistantMessage(current, previous).content).toEqual([current.content[1]]);
	});

	it("collapses repeated thinking when the tool operation changes or parallel calls differ", () => {
		const line = "The operation was rejected. I will inspect the result and correct the request.";
		const previous = assistant("");
		previous.content = [
			{ type: "thinking", thinking: line, thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/other.ts" } },
		];
		const current = assistant("");
		current.content = [
			{ type: "thinking", thinking: line, thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-3", name: "read", arguments: { path: "src/file.ts" } },
			{ type: "toolCall", id: "call-4", name: "read", arguments: { path: "src/new.ts" } },
		];

		expect(collapseDegenerateAssistantMessage(current, previous).content).toEqual(current.content.slice(1));
	});

	it("keeps non-identical reasoning across changed tool turns", () => {
		const previous = assistant("");
		previous.content = [
			{ type: "thinking", thinking: "I will inspect the first result.", thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
		];
		const current = assistant("");
		current.content = [
			{ type: "thinking", thinking: "I will inspect the second result.", thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/other.ts" } },
		];

		expect(collapseDegenerateAssistantMessage(current, previous)).toBe(current);
	});

	it("preserves repeated assistant text across tool turns", () => {
		const previous = assistant("");
		previous.content = [
			{ type: "text", text: "The same visible answer is valid on both turns." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
		];
		const current = assistant("");
		current.content = [
			{ type: "text", text: "The same visible answer is valid on both turns." },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/file.ts" } },
		];

		expect(collapseDegenerateAssistantMessage(current, previous)).toBe(current);
	});

	it("does not collapse a tool-free repeated turn without the closing-turn policy", () => {
		const line = "The unresolved operation remains blocked.";
		const previous = assistant("");
		previous.content = [
			{ type: "thinking", thinking: line, thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
		];
		const current = assistant("");
		current.content = [{ type: "thinking", thinking: line, thinkingSignature: "reasoning" }];

		expect(collapseDegenerateAssistantMessage(current, previous)).toBe(current);
		expect(collapseDegenerateAssistantMessage(current, previous, { allowToolFreeComparison: true }).content).toEqual(
			[],
		);
	});

	it("collapses a single-line sentence generation loop", () => {
		const sentence = "Checking leftover copy, then finishing docs, sitemap, tests, and the message house.";
		const looping = Array.from({ length: 12 }, () => sentence).join(" ");
		expect(collapseRepeatedLines(looping)).toBe(sentence);
		expect(shouldAbortDegenerateStream(looping)).toBe(true);
	});

	it("does not treat a long run of one filler character as a tiled status sentence", () => {
		const filler = "x".repeat(220_000);
		expect(collapseRepeatedLines(filler)).toBe(filler);
		expect(shouldAbortDegenerateStream(filler)).toBe(false);
	});

	it("collapses a status sentence concatenated with no space", () => {
		const sentence = "Session ended mid-implementation. Checking the written plan and what actually landed.";
		expect(collapseRepeatedLines(sentence + sentence)).toBe(sentence);
		expect(collapseRepeatedLines(sentence.repeat(4))).toBe(sentence);
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
