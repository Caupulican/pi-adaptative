import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentTool, BeforeToolCallContext } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

describe("preparation cleanup registration", () => {
	it.each([
		"execute",
		"background",
		"block",
		"cancel",
		"hook_throw",
		"reservation_throw",
		"selector_throw",
		"cleanup_throw",
	] as const)("releases registered resources and the binding after %s", async (boundary) => {
		const abort = new AbortController();
		const order: string[] = [];
		let registerCleanup: BeforeToolCallContext["registerCleanup"];
		let finishExecution!: () => void;
		const executionGate = new Promise<void>((resolve) => {
			finishExecution = resolve;
		});
		let backgroundCompletion: Promise<unknown> | undefined;
		let handoffOrder: string[] | undefined;
		const parameters = Type.Object({});
		const tool: AgentTool<typeof parameters> = {
			name: "fixture",
			label: "Fixture",
			description: "Preparation lifetime",
			parameters,
			async execute() {
				throw new Error("Expected bound tool");
			},
			async bindInvocation() {
				return {
					executionContext: {
						attachment: {
							workspaceId: "fixture",
							attachmentId: "fixture",
							root: "/fixture",
							flavor: "posix",
							caseSensitive: true,
						},
						sessionId: "fixture",
						generation: 0,
						cwd: "/fixture",
					},
					async execute() {
						expect(order).toEqual([]);
						order.push("execute");
						if (boundary === "background") await executionGate;
						return { content: [{ type: "text", text: "completed" }], details: {} };
					},
					release() {
						order.push("binding");
					},
				};
			},
		};
		await runAgentLoop(
			[{ role: "user", content: "Run", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: {
					id: "fixture",
					name: "fixture",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
				convertToLlm: (history) =>
					history.filter((message): message is Message =>
						["user", "assistant", "toolResult"].includes(message.role),
					),
				toolExecution: "sequential",
				maxProviderTurns: 1,
				beforeToolCall: async (context) => {
					registerCleanup = context.registerCleanup;
					if (!registerCleanup) throw new Error("Missing preparation cleanup port");
					registerCleanup(() => {
						order.push("first");
						if (boundary === "cleanup_throw") throw new Error("Cleanup failed");
					});
					registerCleanup(() => order.push("second"));
					if (boundary === "block" || boundary === "cleanup_throw") return { block: true };
					if (boundary === "cancel") abort.abort("fixture");
					if (boundary === "hook_throw") throw new Error("Hook failed after registration");
				},
				onToolCallStart: () => {
					if (boundary === "reservation_throw") throw new Error("Reservation failed");
					return {
						release() {
							order.push("start");
						},
					};
				},
				isBackgroundRequested: () => {
					if (boundary === "selector_throw") throw new Error("Selector failed");
					return boundary === "background";
				},
				handoffToolCall: ({ completion }) => {
					backgroundCompletion = completion;
					handoffOrder = [...order];
					finishExecution();
					return { result: { content: [{ type: "text", text: "Background task" }], details: {} } };
				},
			},
			() => {},
			abort.signal,
			() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: "fixture", name: tool.name, arguments: {} }],
					api: "openai-responses",
					provider: "openai",
					model: "fixture",
					stopReason: "toolUse",
					timestamp: 1,
					usage: createEmptyUsage(),
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message });
				return stream;
			},
		);
		if (boundary === "background") {
			expect(handoffOrder).toEqual(["execute"]);
			expect(backgroundCompletion).toBeDefined();
			await backgroundCompletion;
		}
		expect(order).toEqual([
			...(boundary === "execute" || boundary === "background" ? ["execute"] : []),
			"first",
			"second",
			...(boundary === "execute" || boundary === "background" || boundary === "selector_throw" ? ["start"] : []),
			"binding",
		]);
		registerCleanup?.(() => order.push("late"));
		expect(order.at(-1)).toBe("late");
	});
});
