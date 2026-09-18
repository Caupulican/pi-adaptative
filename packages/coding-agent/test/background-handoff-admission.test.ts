import {
	type AgentTool,
	type BackgroundToolCallCompletion,
	createEmptyUsage,
	retainedToolInvocation,
	runAgentLoop,
} from "@caupulican/pi-agent-core";
import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import {
	disposeMutationLockScope,
	getMutationLockScope,
	withExclusiveMutationBarrier,
} from "../src/core/tools/file-mutation-queue.ts";

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

describe("background handoff admission ownership", () => {
	it.each(["scope_error", "scope_undefined", "persistence_refusal", "accepted"] as const)(
		"retains exactly one completion owner: %s",
		async (mode) => {
			const scope = `handoff-admission:${mode}`;
			const started = Promise.withResolvers<void>();
			const releaseBody = Promise.withResolvers<void>();
			const attempted = Promise.withResolvers<void>();
			const persisted: BackgroundToolTaskRecord[] = [];
			const notified: BackgroundToolTaskRecord[] = [];
			const getMutationScope = vi.fn(() => {
				if (mode === "scope_error") throw new Error("Scope dependency unavailable");
				if (mode === "scope_undefined") throw undefined;
				return scope;
			});
			const controller = new BackgroundToolTaskController({
				getSessionId: () => "fixture-session",
				getArtifactStore: () => undefined,
				getMutationScope,
				persist: (record) => {
					if (mode === "persistence_refusal") throw new Error("Persistence unavailable");
					persisted.push(record);
				},
				notifyTerminal: (records) => {
					notified.push(...records);
				},
			});
			const parameters = Type.Object({});
			const execute = vi.fn(async (callId: string) =>
				withExclusiveMutationBarrier(
					async () => {
						started.resolve();
						await releaseBody.promise;
						return { content: [{ type: "text" as const, text: "actual operation output" }], details: {} };
					},
					{ holdId: callId, scope },
				),
			);
			const tool: AgentTool<typeof parameters> = {
				name: "fixture",
				label: "Fixture",
				description: "Controlled operation",
				parameters,
				execute,
			};
			let completion: Promise<BackgroundToolCallCompletion> | undefined;
			const running = runAgentLoop(
				[{ role: "user", content: "Run fixture", timestamp: 0 }],
				{ systemPrompt: "Fixture", messages: [], tools: [tool] },
				{
					model,
					maxProviderTurns: 1,
					convertToLlm: (history) =>
						history.filter(
							(message) =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						),
					subscribeToolCallHandoffRequest: (_id, request) => {
						request();
						return () => {};
					},
					handoffToolCall: (context) => {
						completion = context.completion;
						try {
							return controller.handoff(context);
						} finally {
							attempted.resolve();
						}
					},
				},
				() => {},
				undefined,
				() => {
					const stream = new AssistantMessageEventStream();
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: createEmptyUsage(),
							timestamp: 0,
							stopReason: "toolUse",
							content: [{ type: "toolCall", id: "fixture-call", name: tool.name, arguments: {} }],
						},
					});
					return stream;
				},
			);
			let successor: Promise<void> | undefined;
			try {
				await attempted.promise;
				await started.promise;
				const accepted = mode === "accepted";
				expect(controller.list()).toHaveLength(accepted ? 1 : 0);
				expect(persisted).toHaveLength(accepted ? 1 : 0);
				expect(notified).toHaveLength(0);
				expect(getMutationScope).toHaveBeenCalledOnce();

				const lock = getMutationLockScope(scope);
				let successorAdmitted = false;
				successor = lock.acquireLock("mutation", undefined).then(() => {
					successorAdmitted = true;
					lock.releaseLock();
				});
				// acquireLock admits synchronously; one promise reaction observes that admission.
				await Promise.resolve();
				expect(successorAdmitted).toBe(accepted);

				releaseBody.resolve();
				const messages = await running;
				await completion;
				await controller.waitForNotifications();
				expect(execute).toHaveBeenCalledOnce();
				const results = messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(1);
				expect(retainedToolInvocation(results[0].details)?.execution).toBe(accepted ? "running" : "completed");
				if (accepted) {
					expect(notified).toEqual([
						expect.objectContaining({ status: "completed", output: "actual operation output" }),
					]);
				} else {
					expect(results[0].content).toEqual([{ type: "text", text: "actual operation output" }]);
					expect(controller.list()).toEqual([]);
					expect(persisted).toEqual([]);
					expect(notified).toEqual([]);
				}
			} finally {
				releaseBody.resolve();
				await running;
				await completion;
				await successor;
				await controller.shutdown();
				disposeMutationLockScope(scope);
			}
		},
	);
});
