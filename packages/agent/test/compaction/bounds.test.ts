import type { AssistantMessage, Model } from "@caupulican/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../../src/compaction/index.ts";
import type { AgentMessage } from "../../src/types.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@caupulican/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@caupulican/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(contextWindow: number, maxTokens = 2048): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function messages(chars: number): AgentMessage[] {
	return [{ role: "user", content: "x".repeat(chars), timestamp: Date.now() }];
}

describe("compaction bounds", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(response("## Active Task\nok"));
	});

	it("throws input-overflow when a non-chunked summarization request exceeds the summarizer bound", async () => {
		await expect(generateSummary(messages(9000), createModel(3000), 100, "test-key")).rejects.toThrow(
			"input-overflow",
		);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("summarizes bounded chunks then merges them when chunked is selected", async () => {
		completeSimpleMock.mockResolvedValue(response("chunk summary"));

		await generateSummary(
			messages(9000),
			createModel(3000),
			100,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"files:\nactions:\nprohibitions:",
			true,
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(4);
		expect(completeSimpleMock.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain("conversation-chunk");
		expect(completeSimpleMock.mock.calls[3]?.[1].messages[0]?.content[0]?.text).toContain(
			"Checkpoint the conversation",
		);
	});

	it("truncates oversized output by dropping lower-priority sections", async () => {
		const oversized = [
			"## Active Task",
			"Keep this active task",
			"",
			"### Mandatory Rules",
			"- DO NOT drop this rule",
			"",
			"## Files",
			"- src/a.ts — modified",
			"",
			"## Done",
			"1. EDIT src/a.ts — done",
			"",
			"## Constraints & Preferences",
			"keep concise",
			"",
			"## Key Decisions",
			"- decided",
			"",
			"## Blocked / Open",
			"- blocked",
			"",
			"## Critical Context",
			"z".repeat(6000),
		].join("\n");
		completeSimpleMock.mockResolvedValue(response(oversized));

		const summary = await generateSummary(messages(10), createModel(200000), 1000, "test-key");

		expect(summary).toContain("## Active Task");
		expect(summary).toContain("### Mandatory Rules");
		expect(summary).not.toContain("## Critical Context");
	});
});
