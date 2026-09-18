import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { retainedToolInvocation } from "../src/tool-invocation-receipt.ts";
import type { AgentEvent, AgentTool, BackgroundToolCallCompletion } from "../src/types.ts";
import { AgentToolExecutionError } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"openai-responses"> = {
	id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

describe("completed tool cleanup settlement", () => {
	it.each(
		["sequential", "parallel", "background"].flatMap((mode) =>
			["registered", "start", "binding", "throw_undefined", "control"].flatMap((fault) =>
				["success", "negative", "interrupted"].map((operation) => ({ mode, fault, operation })),
			),
		),
	)("retains execution evidence: $mode / $fault / $operation", async ({ mode, fault, operation }) => {
		const release = Promise.withResolvers<void>();
		const effects: string[] = [];
		const cleanups: string[] = [];
		const events: AgentEvent[] = [];
		const usage = { ...createEmptyUsage(), input: 7, totalTokens: 7 };
		let background: Promise<BackgroundToolCallCompletion> | undefined;
		let requests = 0;
		const cleanup = (owner: string, id: string) => {
			cleanups.push(`${owner}:${id}`);
			if (id !== "first") return;
			if (owner === "registered") release.resolve();
			if (fault === owner) throw new Error("private cleanup diagnostic");
			if (fault === "throw_undefined" && owner === "registered") throw undefined;
		};
		const tool: AgentTool = {
			name: "operate", label: "Operate", description: "Synthetic mutation", parameters: Type.Object({}),
			async execute() { throw new Error("Must use bound executor"); },
			async bindInvocation() {
				let callId = "";
				return {
					executionContext: {
						attachment: { workspaceId: "fixture", attachmentId: "fixture", root: "/fixture", flavor: "posix", caseSensitive: true },
						sessionId: "fixture", generation: 0, cwd: "/fixture",
					},
					async execute(id) {
						callId = id;
						if (id === "sibling" || mode === "background") await release.promise;
						effects.push(id);
						if (id === "first" && operation === "negative")
							throw new AgentToolExecutionError("completed negative outcome", "exit_1", "fixture", "operation_outcome");
						if (id === "first" && operation === "interrupted") throw new Error("executor interrupted");
						return {
							content: [{ type: "text", text: `committed:${id}` }],
							details: { effect: id, piVerification: { version: 1, id: `check-${id}`, status: "passed", outcome: "executed", evidence: "tests" } },
							usage,
						};
					},
					release() { cleanup("binding", callId); },
				};
			},
		};
		const messages = await runAgentLoop(
			[{ role: "user", content: "Run", timestamp: 0 }],
			{ systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model, toolConcurrency: 2, toolExecution: mode === "parallel" ? "parallel" : "sequential",
				convertToLlm: (history) => history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
				beforeToolCall: async ({ toolCall, registerCleanup }) => {
					registerCleanup?.(() => cleanup("registered", toolCall.id));
					registerCleanup?.(() => cleanup("second", toolCall.id));
				},
				onToolCallStart: () => ({ release(id) { cleanup("start", id); } }),
				...(mode === "background" ? {
					subscribeToolCallHandoffRequest: (_id: string, request: () => void) => { request(); return () => {}; },
					handoffToolCall: ({ completion }: { completion: Promise<BackgroundToolCallCompletion> }) => {
						background = completion;
						release.resolve();
						return { result: { content: [{ type: "text" as const, text: "handed off" }], details: {} } };
					},
				} : {}),
			},
			(event) => { events.push(event); }, undefined,
			() => {
				const first = requests++ === 0;
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: createEmptyUsage(), timestamp: requests,
					stopReason: first ? "toolUse" : "stop",
					content: first ? (mode === "parallel" ? ["first", "sibling"] : ["first"]).map((id) =>
						({ type: "toolCall", id, name: tool.name, arguments: {} })) : [{ type: "text", text: "Finished" }],
				} });
				return stream;
			},
		);
		const results = messages.filter((message) => message.role === "toolResult");
		const detached = await background;
		const result = mode === "background" ? detached?.result : results[0];
		expect(effects).toEqual(mode === "parallel" ? ["first", "sibling"] : ["first"]);
		expect(cleanups.filter((entry) => entry.endsWith(":first"))).toEqual(["registered:first", "second:first", "start:first", "binding:first"]);
		expect(result).toBeDefined();
		expect(retainedToolInvocation(result?.details)).toMatchObject({
			execution: operation === "interrupted" ? "unknown" : "completed",
			...(operation === "interrupted" ? {} : { operationStatus: operation === "success" ? "success" : "error" }),
			postprocessingFailures: fault === "control" ? [] : ["cleanup"],
		});
		expect(mode === "background" ? detached?.isError : results[0]?.isError).toBe(operation !== "success");
		if (operation === "success") {
			expect(result?.content[0]).toEqual({ type: "text", text: "committed:first" });
			expect(result?.usage).toEqual(usage);
			expect(Object.getOwnPropertyDescriptor(result?.details, "piVerification"))
				.toMatchObject({ value: { id: "check-first", status: "passed" }, configurable: false, writable: false });
		}
		if (mode === "parallel") {
			expect(results.map((result) => result.toolCallId)).toEqual(["first", "sibling"]);
			expect(retainedToolInvocation(results[1].details)).toMatchObject({ operationStatus: "success", postprocessingFailures: [] });
		}
		expect(JSON.stringify(result)).not.toContain("private cleanup diagnostic");
		expect(messages).toEqual(events.flatMap((event) => event.type === "message_end" ? [event.message] : []));
		expect(requests).toBe(fault === "control" || mode === "background" ? 2 : 1);
	});

	it.each(["completed", "manual"].flatMap((race) => ["throw", "control"].map((fault) => ({ race, fault }))))(
		"retains completion across unsubscribe: $race / $fault", async ({ race, fault }) => {
		const release = Promise.withResolvers<void>();
		let effects = 0;
		let handoffs = 0;
		const tool: AgentTool = {
			name: "operate", label: "Operate", description: "Synthetic mutation", parameters: Type.Object({}),
			async execute() {
				if (race === "manual") await release.promise;
				effects++;
				return { content: [{ type: "text", text: "committed" }], details: {} };
			},
		};
		const messages = await runAgentLoop(
			[{ role: "user", content: "Run", timestamp: 0 }], { systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model, maxProviderTurns: 1,
				convertToLlm: (history) => history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
				subscribeToolCallHandoffRequest: (_id, request) => {
					if (race === "manual") request();
					return () => {
						release.resolve();
						if (fault === "throw") throw new Error("private unsubscribe diagnostic");
					};
				},
				handoffToolCall: () => { handoffs++; return undefined; },
			}, () => {}, undefined,
			() => {
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: createEmptyUsage(), timestamp: 0,
					stopReason: "toolUse", content: [{ type: "toolCall", id: "first", name: tool.name, arguments: {} }],
				} });
				return stream;
			},
		);
		const result = messages.find((message) => message.role === "toolResult");
		expect(effects).toBe(1);
		expect(handoffs).toBe(race === "manual" && fault === "control" ? 1 : 0);
		expect(result?.isError).toBe(false);
		expect(result?.content[0]).toEqual({ type: "text", text: "committed" });
		expect(retainedToolInvocation(result?.details)).toMatchObject({ operationStatus: "success", postprocessingFailures: fault === "throw" ? ["cleanup"] : [] });
		expect(JSON.stringify(messages)).not.toContain("private unsubscribe diagnostic");
	});
});
