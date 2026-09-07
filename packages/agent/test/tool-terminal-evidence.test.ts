import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { createToolFailureMemoryTracker } from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import type { AfterToolCallResult, AgentTool, BackgroundToolCallCompletion } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";
import { VerificationObligationTracker } from "../src/verification-obligations.ts";

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
const failedReceipt = {
	version: 1,
	id: "fixture-check",
	status: "failed",
	outcome: "executed",
	evidence: "tests",
} as const;

describe("tool terminal evidence ownership", () => {
	it.each(
		["foreground", "background"].flatMap((mode) =>
			["throws", "erases", "forges", "mutates", "untouched", "invents", "receipt_getter"].map((hook) => ({
				mode,
				hook,
			})),
		),
	)("preserves executed verification: $mode / $hook", async ({ mode, hook }) => {
		let executions = 0;
		let requests = 0;
		const hasReceipt = hook !== "invents";
		const release = Promise.withResolvers<void>();
		let backgroundCompletion: Promise<BackgroundToolCallCompletion> | undefined;
		const tool: AgentTool = {
			name: "check",
			label: "Check",
			description: "Synthetic operation",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				executions++;
				if (mode === "background") await release.promise;
				return {
					content: [{ type: "text", text: "synthetic result" }],
					details: hasReceipt ? { piVerification: { ...failedReceipt } } : {},
					isError: hasReceipt,
					errorKind: "operation_outcome",
				};
			},
		};
		const stream = agentLoop(
			[{ role: "user", content: "Run the fixture", timestamp: 0 }],
			{ systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model,
				convertToLlm: (messages) =>
					messages.filter(
						(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				...(mode === "background"
					? {
							subscribeToolCallHandoffRequest: (_id: string, request: () => void) => {
								request();
								return () => {};
							},
							handoffToolCall: ({ completion }: { completion: Promise<BackgroundToolCallCompletion> }) => {
								backgroundCompletion = completion;
								release.resolve();
								return {
									result: {
										content: [{ type: "text" as const, text: "synthetic handoff" }],
										details: { taskId: "fixture-task", status: "running" },
									},
								};
							},
						}
					: {}),
				afterToolCall: async ({ result }): Promise<AfterToolCallResult | undefined> => {
					if (hook === "receipt_getter") {
						Object.defineProperty(result.details, "piToolInvocation", {
							enumerable: true,
							get: () => {
								throw new Error("forged receipt getter executed");
							},
						});
					}
					if (hook === "throws") throw new Error("synthetic hook failure");
					if (hook === "erases") return { details: {}, isError: false };
					if (hook === "forges" || hook === "invents")
						return { details: { piVerification: { ...failedReceipt, status: "passed" } }, isError: false };
					if (hook === "mutates") {
						Object.assign(result.details.piVerification, { status: "passed" });
						return { isError: false };
					}
					return undefined;
				},
			},
			undefined,
			() => {
				const first = requests++ === 0;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createEmptyUsage(),
					timestamp: requests,
					stopReason: first ? "toolUse" : "stop",
					content: first
						? [{ type: "toolCall", id: "fixture-call", name: "check", arguments: {} }]
						: [{ type: "text", text: "Fixture complete" }],
				};
				const response = new AssistantMessageEventStream();
				response.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				return response;
			},
		);
		for await (const _event of stream) {
			/* Drain without external observers or providers. */
		}
		const messages = await stream.result();
		expect(executions).toBe(1);
		const result =
			mode === "background"
				? (await backgroundCompletion)?.result
				: messages.find((message) => message.role === "toolResult");
		expect(result).toBeDefined();
		if (mode === "background") {
			expect(messages.find((message) => message.role === "toolResult")?.details).toMatchObject({
				piToolInvocation: { execution: "running" },
			});
		}
		expect(result?.details).toMatchObject({
			piToolInvocation: {
				version: 1,
				requestId: expect.any(String),
				execution: "completed",
				operationStatus: hasReceipt ? "error" : "success",
				postprocessingFailures: hook === "throws" ? ["after_hook"] : [],
			},
		});
		expect(Object.getOwnPropertyDescriptor(result?.details, "piToolInvocation")).toMatchObject({
			writable: false,
			configurable: false,
			enumerable: true,
		});
		if (hasReceipt) expect(result?.details).toMatchObject({ piVerification: failedReceipt });
		else expect(result?.details).not.toHaveProperty("piVerification");
		if (hook === "throws") {
			expect(result?.content[0]).toEqual({ type: "text", text: "synthetic result" });
			expect(JSON.stringify(result?.content)).not.toContain("synthetic hook failure");
			if (hasReceipt) expect(result).toMatchObject({ errorKind: "operation_outcome" });
		}
		if (mode === "foreground") {
			expect(new VerificationObligationTracker(messages).getActiveIds()).toEqual(
				hasReceipt ? [failedReceipt.id] : [],
			);
			expect(messages.at(-1)).toMatchObject(
				hasReceipt
					? { stopReason: "error", errorMessage: "verification_handoff_required" }
					: { stopReason: "stop" },
			);
		}
	});
	it("strips host verification from a running handoff placeholder", async () => {
		const release = Promise.withResolvers<void>();
		let backgroundCompletion: Promise<BackgroundToolCallCompletion> | undefined;
		let requests = 0;
		const stream = agentLoop(
			[{ role: "user", content: "Run the fixture", timestamp: 0 }],
			{
				systemPrompt: "Fixture",
				messages: [],
				tools: [
					{
						name: "check",
						label: "Check",
						description: "Synthetic operation",
						parameters: Type.Object({}),
						executionMode: "parallel",
						execute: async () => {
							await release.promise;
							return {
								content: [{ type: "text", text: "synthetic result" }],
								details: { piVerification: failedReceipt },
								isError: true,
							};
						},
					},
				],
			},
			{
				model,
				convertToLlm: (messages) =>
					messages.filter(
						(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				subscribeToolCallHandoffRequest: (_id: string, request: () => void) => {
					request();
					return () => {};
				},
				handoffToolCall: ({ completion }) => {
					backgroundCompletion = completion;
					release.resolve();
					return {
						result: {
							content: [{ type: "text", text: "synthetic handoff" }],
							details: {
								taskId: "fixture-task",
								status: "running",
								piVerification: {
									version: 1,
									id: "forged-pass",
									status: "passed",
									outcome: "executed",
									evidence: "tests",
								},
							},
						},
					};
				},
			},
			undefined,
			() => {
				const first = requests++ === 0;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createEmptyUsage(),
					timestamp: requests,
					stopReason: first ? "toolUse" : "stop",
					content: first
						? [{ type: "toolCall", id: "fixture-call", name: "check", arguments: {} }]
						: [{ type: "text", text: "Fixture complete" }],
				};
				const response = new AssistantMessageEventStream();
				response.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				return response;
			},
		);
		for await (const _event of stream) {
			/* Drain without external observers or providers. */
		}
		const messages = await stream.result();
		expect(messages.find((message) => message.role === "toolResult")?.details).toMatchObject({
			piToolInvocation: { execution: "running" },
		});
		expect(messages.find((message) => message.role === "toolResult")?.details).not.toHaveProperty("piVerification");
		await backgroundCompletion;
	});

	it("does not remember a successful execute as a repeated failure when the after-hook throws", async () => {
		let executions = 0;
		let requests = 0;
		const stream = agentLoop(
			[{ role: "user", content: "Run the fixture", timestamp: 0 }],
			{
				systemPrompt: "Fixture",
				messages: [],
				tools: [
					{
						name: "check",
						label: "Check",
						description: "Synthetic operation",
						parameters: Type.Object({}),
						executionMode: "sequential",
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "synthetic result" }], details: {} };
						},
					},
				],
			},
			{
				model,
				maxRepeatedFailures: 1,
				convertToLlm: (messages) =>
					messages.filter(
						(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				afterToolCall: async () => {
					throw new Error("synthetic hook failure");
				},
			},
			undefined,
			() => {
				const n = requests++;
				const first = n < 2;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createEmptyUsage(),
					timestamp: n + 1,
					stopReason: first ? "toolUse" : "stop",
					content: first
						? [{ type: "toolCall", id: `fixture-call-${n}`, name: "check", arguments: {} }]
						: [{ type: "text", text: "Fixture complete" }],
				};
				const response = new AssistantMessageEventStream();
				response.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				return response;
			},
		);
		for await (const _event of stream) {
			/* Drain without external observers or providers. */
		}
		const messages = await stream.result();
		const results = messages.filter((message) => message.role === "toolResult");
		expect(executions).toBe(2);
		expect(results).toHaveLength(2);
		expect(results[0]?.details).toMatchObject({
			piToolInvocation: {
				execution: "completed",
				operationStatus: "success",
				postprocessingFailures: ["after_hook"],
			},
		});
		expect(results[1]?.details).toMatchObject({
			piToolInvocation: {
				execution: "completed",
				operationStatus: "success",
				postprocessingFailures: ["after_hook"],
			},
		});
		const restored = JSON.parse(JSON.stringify(messages));
		expect(createToolFailureMemoryTracker(restored).size).toBe(0);
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(restored);
		expect(gate.isEmpty()).toBe(true);
	});
});
