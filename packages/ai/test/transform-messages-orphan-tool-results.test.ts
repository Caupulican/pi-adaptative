import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage, UserMessage } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCall(id: string): ToolCall {
	return { type: "toolCall", id, name: "tool", arguments: {} };
}

function assistant(stopReason: AssistantMessage["stopReason"], calls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: zeroUsage,
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "tool",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 2,
	};
}

const nextUser: UserMessage = { role: "user", content: "next", timestamp: 3 };

describe("transformMessages orphan tool results", () => {
	it("drops tool results for skipped errored assistant tool calls", () => {
		const messages: Message[] = [assistant("error", [toolCall("dropped")]), toolResult("dropped"), nextUser];

		expect(transformMessages(messages, model)).toEqual([nextUser]);
	});

	it("keeps tool results for retained assistant tool calls", () => {
		const keptAssistant = assistant("stop", [toolCall("kept")]);
		const keptResult = toolResult("kept");
		const messages: Message[] = [keptAssistant, keptResult, nextUser];

		expect(transformMessages(messages, model)).toEqual([keptAssistant, keptResult, nextUser]);
	});

	it("still backfills unresolved retained tool calls before skipped errored turns", () => {
		const keptAssistant = assistant("stop", [toolCall("missing")]);
		const messages: Message[] = [keptAssistant, assistant("error", [toolCall("dropped")]), nextUser];

		expect(transformMessages(messages, model)).toEqual([
			keptAssistant,
			{
				role: "toolResult",
				toolCallId: "missing",
				toolName: "tool",
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: expect.any(Number),
			},
			nextUser,
		]);
	});
});
