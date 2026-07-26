import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-completions"> = {
	id: "replay-target",
	name: "Replay Target",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

describe("openai-completions tool-call ID replay", () => {
	it("keeps pipe-delimited item IDs unique within the 40-character limit", () => {
		const callIds = [
			"shared-call|item/with/a/very/long/identifier/one",
			"shared-call|item/with/a/very/long/identifier/two",
		];
		const assistant: AssistantMessage = {
			role: "assistant",
			content: callIds.map((id, index) => ({ type: "toolCall", id, name: "read", arguments: { index } })),
			api: "openai-responses",
			provider: "source",
			model: "source-model",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "run both", timestamp: 1 },
				assistant,
				...callIds.map((toolCallId, index) => ({
					role: "toolResult" as const,
					toolCallId,
					toolName: "read",
					content: [{ type: "text" as const, text: String(index) }],
					isError: false,
					timestamp: 3 + index,
				})),
			],
		};

		const messages = convertMessages(model, context, compat);
		const wireAssistant = messages.find((message) => message.role === "assistant");
		const toolCallWireIds = wireAssistant?.tool_calls?.map((call) => call.id) ?? [];
		const toolResultWireIds = messages
			.filter((message) => message.role === "tool")
			.map((message) => message.tool_call_id);

		expect(new Set(toolCallWireIds).size).toBe(2);
		expect(toolCallWireIds.every((id) => id.length <= 40)).toBe(true);
		expect(toolResultWireIds).toEqual(toolCallWireIds);
	});
});
