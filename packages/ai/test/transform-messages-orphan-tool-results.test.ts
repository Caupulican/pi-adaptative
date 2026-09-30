import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT, transformMessages } from "../src/providers/transform-messages.ts";
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
	it("preserves a compacted orphan output as labeled evidence instead of an invalid wire result", () => {
		const orphan = toolResult("call_compacted|fc_compacted");
		const messages: Message[] = [nextUser, orphan];
		const result = transformMessages(messages, model);

		expect(result.filter((message) => message.role === "toolResult")).toHaveLength(0);
		expect(result.at(-1)).toMatchObject({ role: "user", timestamp: orphan.timestamp });
		const evidence = result.at(-1)!;
		expect(JSON.stringify(evidence)).toContain("call_compacted|fc_compacted");
		expect(JSON.stringify(evidence)).toContain("result");
		expect(JSON.stringify(evidence)).toContain("Historical tool output");
		expect(messages).toEqual([nextUser, orphan]);

		const responsesModel = { ...model, api: "openai-responses" as const, provider: "openai" };
		const wire = convertResponsesMessages(responsesModel, { messages }, new Set(["openai"]));
		expect(wire.some((item) => item.type === "function_call_output")).toBe(false);
	});

	it("retains images and negative operation status in unpaired historical evidence", () => {
		const orphan: ToolResultMessage = {
			...toolResult("compacted"),
			isError: true,
			content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }],
		};
		const result = transformMessages([orphan], { ...model, input: ["text", "image"] });
		expect(result[0]).toMatchObject({
			role: "user",
			content: [expect.objectContaining({ type: "text" }), orphan.content[0]],
		});
		expect(JSON.stringify(result[0])).toContain("isError=true");
	});

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
				content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
				isError: true,
				timestamp: expect.any(Number),
			},
			nextUser,
		]);
	});
});
