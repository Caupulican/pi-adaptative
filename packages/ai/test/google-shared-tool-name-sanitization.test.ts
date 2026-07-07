import { describe, expect, it } from "vitest";
import { convertMessages, convertTools } from "../src/providers/google-shared.ts";
import type { Context, Model, Tool } from "../src/types.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function makeTool(name: string): Tool {
	return {
		name,
		description: "test tool",
		parameters: { type: "object", properties: {}, required: [] } as Tool["parameters"],
	};
}

describe("google shared tool name sanitization", () => {
	it("sanitizes and disambiguates outbound declarations", () => {
		const result = convertTools([makeTool("mcp.server:do_thing"), makeTool("mcp/server:do_thing")]);

		expect(result?.[0]?.functionDeclarations.map((declaration) => declaration.name)).toEqual([
			"mcp_server_do_thing",
			"mcp_server_do_thing_2",
		]);
	});

	it("serializes replayed Google function calls and responses with sanitized names", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "mcp.server:do_thing", arguments: { value: "ok" } }],
					api: "google-generative-ai",
					provider: "google",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "mcp.server:do_thing",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [makeTool("mcp.server:do_thing")],
		};

		const contents = convertMessages(model, context);
		expect(contents[1]?.parts?.[0]?.functionCall?.name).toBe("mcp_server_do_thing");
		expect(contents[2]?.parts?.[0]?.functionResponse?.name).toBe("mcp_server_do_thing");
	});
});
