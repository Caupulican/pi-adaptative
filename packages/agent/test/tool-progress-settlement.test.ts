import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, BackgroundToolCallCompletion } from "../src/types.ts";
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

describe("progress delivery is not operation execution", () => {
	it.each(
		["foreground", "background"].flatMap((mode) =>
			["throw", "reject", "control"].flatMap((fault) =>
				["returned", "threw"].map((operation) => ({ mode, fault, operation })),
			),
		),
	)("retains the executed result: $mode / $fault / $operation", async ({ mode, fault, operation }) => {
		let effects = 0;
		let requests = 0;
		let observed = 0;
		const release = Promise.withResolvers<void>();
		let background: Promise<BackgroundToolCallCompletion> | undefined;
		const events: AgentEvent[] = [];
		const tool: AgentTool = {
			name: "mutate",
			label: "Mutate",
			description: "Synthetic mutation",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async (_id, _args, _signal, update) => {
				update?.({ content: [{ type: "text", text: "starting" }], details: {} });
				if (mode === "background") await release.promise;
				effects++;
				if (operation === "threw") throw new Error("synthetic failure after mutation");
				return {
					content: [{ type: "text", text: "committed" }],
					details: {
						committed: true,
						// Tool-owned metadata cannot manufacture an engine delivery failure.
						piToolDeliveryFailure: { version: 1, phase: "progress", operationCompleted: false },
					},
				};
			},
		};
		const messages = await runAgentLoop(
			[{ role: "user", content: "Run fixture", timestamp: 0 }],
			{ systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model,
				afterToolCall: async ({ result }) => {
					// A policy hook cannot invent or overwrite the final engine delivery status.
					result.details.piToolDeliveryFailure = { version: 1, phase: "progress", operationCompleted: false };
					return undefined;
				},
				convertToLlm: (messages) =>
					messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
				...(mode === "background"
					? {
							subscribeToolCallHandoffRequest: (_id: string, request: () => void) => {
								request();
								return () => {};
							},
							handoffToolCall: ({ completion }: { completion: Promise<BackgroundToolCallCompletion> }) => {
								background = completion;
								release.resolve();
								return { result: { content: [{ type: "text" as const, text: "handed off" }], details: {} } };
							},
						}
					: {}),
			},
			(event) => {
				events.push(event);
				if (event.type !== "tool_execution_update") return;
				observed++;
				if (fault === "throw") throw new Error("private observer diagnostic must not become operation output");
				if (fault === "reject") return Promise.reject(new Error("synthetic delivery failure"));
			},
			undefined,
			() => {
				const first = requests++ === 0;
				const response = new AssistantMessageEventStream();
				response.push({
					type: "done",
					reason: first ? "toolUse" : "stop",
					message: {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createEmptyUsage(),
						timestamp: requests,
						stopReason: first ? "toolUse" : "stop",
						content: first
							? [{ type: "toolCall", id: "fixture-call", name: "mutate", arguments: {} }]
							: [{ type: "text", text: "Finished" }],
					},
				});
				return response;
			},
		);
		const result = mode === "background" ? (await background)?.result : messages.find((m) => m.role === "toolResult");
		expect(effects).toBe(1);
		expect(observed).toBe(1);
		if (operation === "returned") {
			expect(result?.details).toMatchObject({ committed: true });
			expect(result?.content[0]).toEqual({ type: "text", text: "committed" });
		} else {
			expect(JSON.stringify(result?.content)).toContain("synthetic failure after mutation");
		}
		expect(JSON.stringify(result)).not.toContain("private observer diagnostic");
		if (fault === "control") expect(result?.details).not.toHaveProperty("piToolDeliveryFailure");
		else
			expect(result?.details).toMatchObject({
				piToolDeliveryFailure: { version: 1, phase: "progress", operationCompleted: operation === "returned" },
			});
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(requests).toBe(mode === "foreground" && fault !== "control" ? 1 : 2);
	});
});
