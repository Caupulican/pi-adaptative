import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

const mistralMock = vi.hoisted(() => ({ payload: undefined as unknown }));

vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		readonly chat = {
			stream: (payload: unknown) => {
				mistralMock.payload = payload;
				return Promise.resolve({
					async *[Symbol.asyncIterator]() {
						yield {
							data: {
								id: "response-1",
								choices: [
									{
										finishReason: "tool_calls",
										delta: {
											content: null,
											toolCalls: [
												{
													id: "call12345",
													index: 0,
													function: { name: "mcp_server_do_thing", arguments: "{}" },
												},
											],
										},
									},
								],
								usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
							},
						};
					},
				});
			},
		};
	},
}));

import { getModel } from "../src/models.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import type { Context } from "../src/types.ts";

describe("Mistral tool-name routing", () => {
	it("maps declarations and returned calls without losing colliding local identities", async () => {
		const localName = "mcp.server:do_thing";
		const context: Context = {
			messages: [{ role: "user", content: "Use the MCP tool", timestamp: 1 }],
			tools: [
				{ name: localName, description: "MCP tool", parameters: Type.Object({}) },
				{ name: "mcp_server_do_thing", description: "Collision", parameters: Type.Object({}) },
			],
		};
		const result = await streamMistral(getModel("mistral", "devstral-medium-latest"), context, {
			apiKey: "test",
			toolChoice: { type: "function", function: { name: localName } },
		}).result();

		const payload = mistralMock.payload as {
			tools: Array<{ function: { name: string } }>;
			toolChoice: { function: { name: string } };
		};
		expect(payload.tools.map((tool) => tool.function.name)).toEqual(["mcp_server_do_thing", "mcp_server_do_thing_2"]);
		expect(payload.toolChoice.function.name).toBe("mcp_server_do_thing");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call12345",
			name: localName,
			arguments: {},
		});
	});
});
