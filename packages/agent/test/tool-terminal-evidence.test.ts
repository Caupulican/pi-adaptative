import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
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
			["throws", "erases", "forges", "mutates", "untouched", "invents"].map((hook) => ({ mode, hook })),
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
		if (hasReceipt) expect(result?.details).toMatchObject({ piVerification: failedReceipt });
		else expect(result?.details).not.toHaveProperty("piVerification");
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
});
