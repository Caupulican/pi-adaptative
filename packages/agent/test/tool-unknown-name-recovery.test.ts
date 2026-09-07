import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentTool } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

describe("unknown tool recovery episodes", () => {
	it.each([false, true])("escalates renamed malformed calls, with clean-turn control=%s", async (cleanTurn) => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "read fixture" }], details: {} }));
		const tool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Fixture read",
			parameters: Type.Object({}),
			execute,
		};
		const escalation = vi.fn();
		const names = cleanTurn
			? ["unknown-one", "unknown-two", "read", "unknown-three"]
			: ["unknown-one", "unknown-two", "unknown-three"];
		let request = 0;
		const messages = await runAgentLoop(
			[{ role: "user", content: "Fixture", timestamp: 0 }],
			{ systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model,
				maxStallTurns: 0,
				onToolValidationEscalation: escalation,
				convertToLlm: (messages) =>
					messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			},
			() => {},
			undefined,
			() => {
				const name = names[request++];
				const response = new AssistantMessageEventStream();
				response.push({
					type: "done",
					reason: name ? "toolUse" : "stop",
					message: {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createEmptyUsage(),
						timestamp: request,
						stopReason: name ? "toolUse" : "stop",
						content: name
							? [{ type: "toolCall", id: `fixture-${request}`, name, arguments: {} }]
							: [{ type: "text", text: "Stopped" }],
					},
				});
				return response;
			},
		);
		expect(execute).toHaveBeenCalledTimes(cleanTurn ? 1 : 0);
		expect(escalation).toHaveBeenCalledTimes(cleanTurn ? 0 : 1);
		const rejected = messages.filter((m) => m.role === "toolResult").filter((m) => m.isError);
		expect(rejected).toHaveLength(3);
		for (const result of rejected) {
			expect(result.details).toMatchObject({ piToolInvocation: { execution: "not_started" } });
			expect(JSON.stringify(result.content)).toContain("read");
		}
	});
});
