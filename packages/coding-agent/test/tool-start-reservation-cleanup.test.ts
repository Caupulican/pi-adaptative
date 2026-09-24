import { type AgentTool, createEmptyUsage, runAgentLoop } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AgentRequestId } from "@caupulican/pi-agent-core/types";
import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ForegroundLifecycleAgentDependency,
	ForegroundLifecycleController,
} from "../src/core/foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "../src/core/model-router-controller.ts";
import {
	disposeMutationLockScope,
	getMutationLockScope,
	MutationLockScope,
} from "../src/core/tools/file-mutation-queue.ts";

describe("tool start reservation cleanup", () => {
	beforeEach(() => {
		vi.stubEnv("PI_TOOL_PARALLELISM_DISABLED", "0");
		vi.stubEnv("PI_TOOL_CONCURRENCY", "2");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		"selector_throw",
		"selector_undefined",
		"prepare_cancel",
		"host_cancel",
		"execute",
		"rewritten_id",
	] as const)("settles the real announcement queue after %s", async (boundary) => {
		const scopeKey = `reservation-cleanup-${boundary}`;
		const scope = getMutationLockScope(scopeKey);
		const abort = new AbortController();
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon() {},
		};
		const lifecycle = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: {
				commitSessionBuffer: () => new Map(),
				commitSessionBufferPrefix: () => new Map(),
			} as ModelRouterController,
			emitWarning() {},
			getMutationScope: () => scopeKey,
			getAnnouncer: () => {
				if (boundary === "host_cancel") abort.abort("Reservation canceled");
				return "fixture";
			},
		});
		lifecycle.install();
		const executed: string[] = [];
		const persisted: Message[] = [];
		const parameters = Type.Object({ value: Type.String() });
		const mutation: AgentTool<typeof parameters> = {
			name: "mutation_fixture",
			label: "Mutation",
			description: "Fixture mutation",
			parameters,
			mutationTarget: () => "/fixture/alpha.txt",
			async execute(id) {
				await scope.joinMutationGroup(id, undefined);
				try {
					executed.push(id);
					return { content: [{ type: "text", text: "Mutation completed" }], details: {} };
				} finally {
					scope.releaseLock();
				}
			},
		};
		const shell: AgentTool<typeof parameters> = {
			name: "shell_fixture",
			label: "Shell",
			description: "Fixture command",
			parameters,
			async execute(id) {
				return scope.runExclusive(
					async () => {
						executed.push(id);
						return { content: [{ type: "text", text: "Command completed" }], details: {} };
					},
					{ holdId: id },
				);
			},
		};
		try {
			const messages = await runAgentLoop(
				[{ role: "user", content: "Run both", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [mutation, shell] },
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
					onProviderRequestSnapshot: agent.onProviderRequestSnapshot,
					onToolCallStart: agent.onToolCallStart,
					toolExecution: "parallel",
					toolConcurrency: 2,
					maxProviderTurns: 1,
					beforeToolCall: async ({ toolCall }) => {
						if (boundary === "prepare_cancel" && toolCall.name === shell.name)
							abort.abort("Preparation canceled");
					},
					isBackgroundRequested: (name) => {
						if (boundary === "selector_throw" && name === mutation.name) throw new Error("Selector failed");
						if (boundary === "selector_undefined" && name === mutation.name) throw undefined;
						return false;
					},
					afterToolCall: async ({ toolCall }) => {
						if (boundary === "rewritten_id" && toolCall.name === mutation.name) toolCall.id = "rewritten";
						return undefined;
					},
				},
				(event) => {
					if (event.type !== "message_end") return;
					const message = event.message;
					if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
					const entryId = sessionManager.appendMessage(message);
					persisted.push(message);
					lifecycle.onMessagePersisted(message, entryId);
				},
				abort.signal,
				() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "mutation", name: mutation.name, arguments: { value: "first" } },
							{ type: "toolCall", id: "shell", name: shell.name, arguments: { value: "second" } },
						],
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
			expect(executed).toEqual(
				boundary === "execute" || boundary === "rewritten_id"
					? ["mutation", "shell"]
					: boundary === "selector_throw" || boundary === "selector_undefined"
						? ["shell"]
						: [],
			);
			expect(scope.idle).toBe(true);
			expect(messages).toEqual(persisted);
			const results = messages.filter((message) => message.role === "toolResult");
			if (boundary !== "rewritten_id") {
				expect(results.map((result) => result.toolCallId)).toEqual(["mutation", "shell"]);
				expect(sessionManager.planSessionLifecycleRepair().toolClosers).toEqual([]);
				expect(sessionManager.planSessionLifecycleRepair().terminalPromotions).toEqual([]);
			}
			if (boundary !== "execute" && boundary !== "rewritten_id") {
				const abandoned =
					boundary === "host_cancel" || boundary === "prepare_cancel" ? results : results.slice(0, 1);
				for (const result of abandoned) {
					expect(result).toMatchObject({
						isError: true,
						details: { piToolInvocation: { execution: "not_started", failureCode: "aborted" } },
					});
					expect(result.details).not.toHaveProperty("piToolFailureMemory");
				}
			}
			if (boundary === "selector_throw" || boundary === "selector_undefined") {
				expect(messages).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ role: "toolResult", toolCallId: "shell", isError: false }),
					]),
				);
			}
		} finally {
			lifecycle.resetForSessionReload();
			disposeMutationLockScope(scopeKey);
		}
	});

	it("does not let an old release retire a replacement with the same call id", () => {
		const scope = new MutationLockScope("announcement-identity");
		const releaseOld = scope.announce("same-id", 0, true, "old", "fixture");
		const releaseCurrent = scope.announce("same-id", 0, true, "new", "fixture");
		releaseOld();
		expect(scope.idle).toBe(false);
		releaseCurrent();
		releaseCurrent();
		expect(scope.idle).toBe(true);
	});

	it.each(["bash", "python", "read"])("announces %s before a later mutation reaches its queue", async (toolName) => {
		const scopeKey = `reservation-order-${toolName}`;
		const scope = getMutationLockScope(scopeKey);
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon() {},
		};
		const lifecycle = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: {
				commitSessionBuffer: () => new Map(),
				commitSessionBufferPrefix: () => new Map(),
			} as ModelRouterController,
			emitWarning() {},
			getMutationScope: () => scopeKey,
			getAnnouncer: () => "fixture",
		});
		lifecycle.install();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "first", name: toolName, arguments: {} },
				{ type: "toolCall", id: "second", name: "write", arguments: {} },
			],
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			stopReason: "toolUse",
			timestamp: 1,
			usage: createEmptyUsage(),
		};
		lifecycle.notePersistedMessage(assistantMessage, sessionManager.appendMessage(assistantMessage));
		const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
		const reservation = await agent.onToolCallStart?.(
			calls.map((call, index) => ({
				requestId: "request" as AgentRequestId,
				callId: call.id,
				toolName: call.name,
				index,
				mutation: index === 1,
				assistantMessage,
				toolCall: call,
				args: {},
				context: { systemPrompt: "", messages: [], tools: [] },
			})),
		);
		try {
			const wait = scope.waitForEarlierAnnouncedCalls("second", "shell", undefined);
			if (toolName === "read") {
				await wait;
			} else {
				let cleared = false;
				void wait.then(() => {
					cleared = true;
				});
				await Promise.resolve();
				expect(cleared).toBe(false);
				reservation?.release("first");
				await wait;
			}
		} finally {
			reservation?.release("first");
			reservation?.release("second");
			lifecycle.resetForSessionReload();
			disposeMutationLockScope(scopeKey);
		}
	});
});
