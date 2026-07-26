import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		async send() {
			return {
				$metadata: {},
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { messageStop: { stopReason: "guardrail_intervened" } };
				})(),
			};
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "bedrock-test",
	name: "Bedrock Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("Bedrock stop reasons", () => {
	it("preserves an unhandled provider stop reason in the terminal error", async () => {
		const result = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("guardrail_intervened");
	});
});
