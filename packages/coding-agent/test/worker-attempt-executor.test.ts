import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import type { LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import { createWorkerAttemptExecutor } from "../src/core/delegation/worker-attempt-executor.ts";
import { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, ExecutionGrant } from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ZERO_ATTEMPT_USAGE: AttemptUsageSnapshot = {
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	activeWallClockMs: 0,
};

function workerConversation(): WorkerConversation {
	return new WorkerConversation(SessionManager.inMemory(), {
		provider: "pi",
		sessionId: "worker-executor-test",
		cwd: process.cwd(),
		resourceProfileNames: [],
		contextPointers: [],
	});
}

function assistantToolRequest(tokens: number): AssistantMessage {
	return {
		...fauxAssistantMessage([fauxToolCall("read", { path: "focused.ts" })], { stopReason: "toolUse" }),
		usage: {
			...ZERO_USAGE,
			input: tokens,
			totalTokens: tokens,
		},
	};
}

async function invokeRequestPreflight(options: IsolatedCompletionOptions) {
	if (!options.requestPreflight || !options.model) throw new Error("Expected worker request preflight.");
	return options.requestPreflight({
		model: options.model,
		context: { systemPrompt: options.systemPrompt, messages: [], tools: options.tools ?? [] },
		maxTokens: options.maxTokens,
	});
}

function createExecutorHarness(
	runIsolatedCompletion: (options: IsolatedCompletionOptions) => Promise<IsolatedCompletionResult>,
	maxTokens = 100,
	appendMessage?: (message: Message) => void,
	retentionPolicy?: { maxContextTokens: number; keepRecentTokens: number },
) {
	const events: string[] = [];
	const conversation = workerConversation();
	const append = conversation.appendMessage.bind(conversation);
	conversation.appendMessage = (message) => {
		events.push(`append:${message.role}`);
		appendMessage?.(message);
		return append(message);
	};
	const grant: ExecutionGrant = {
		...createTestExecutionGrant({ objectiveId: "objective", taskId: "worker-task", attemptId: "attempt" }),
		capabilities: ["filesystem.read"],
		allowedTools: ["read"],
		readPaths: [process.cwd()],
		budget: { maxCostUsd: 1, maxTokens, maxToolCalls: 2, maxWallClockMs: 1_000 },
	};
	const gateway = new CapabilityGateway({ grant, cwd: process.cwd() });
	const toolSurface: LaneToolSurface = {
		tools: [],
		allowedTools: ["read"],
		deniedTools: [],
		unboundAllowPatterns: [],
		beforeToolCall: async () => {
			events.push("gate");
			return undefined;
		},
		gateway,
	};
	const checkpoints: string[] = [];
	const checkpointUsages: AttemptUsageSnapshot[] = [];
	const executor = createWorkerAttemptExecutor({
		request: {
			id: "worker-task",
			instructions: "Read the focused file",
			route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "test", reasons: [] },
			envelope: { id: "worker-envelope", capabilities: ["filesystem.read"] },
			createdAt: new Date().toISOString(),
		},
		grant,
		executionPlan: {
			processEnabled: false,
			writeEnabled: false,
			readMemory: false,
			readPaths: [process.cwd()],
			writePaths: [],
			deniedPaths: [],
			toolManifests: [],
			requiredCapabilities: [],
			budget: grant.budget,
		},
		toolSurface,
		conversation,
		lifecycle: {
			checkpoint: (_laneId, checkpoint) => {
				checkpoints.push(checkpoint.summary);
				if (checkpoint.usage) checkpointUsages.push(checkpoint.usage);
			},
		} as Pick<WorkerLifecycle, "checkpoint">,
		laneId: "worker-task",
		agentId: "worker-agent",
		durableHandle: { taskId: "worker-task", attemptId: "attempt", fencingToken: 1 } as StartedDelegationAttempt,
		parentSessionId: "parent",
		agentDir: process.cwd(),
		cwd: process.cwd(),
		model: { provider: "faux", id: "faux-1" } as Model<Api>,
		thinkingLevel: "off",
		laneCapability: { laneMaxOutputTokens: 128 },
		workerResourceSystemPrompt: "",
		initialUsage: ZERO_ATTEMPT_USAGE,
		hasPersistedUsageCheckpoint: false,
		usageReportId: "usage",
		processCapable: false,
		...(retentionPolicy ? { retentionPolicy } : {}),
		runIsolatedCompletion,
		agentControl: {
			acknowledgeMailboxMessage: () => events.push("ack"),
			mailboxMessagesForConversation: () => [],
		},
		warn: (message) => events.push(`warn:${message}`),
	});
	return { checkpoints, checkpointUsages, conversation, events, executor, gateway };
}

const VERIFIED_COMPACTION_SUMMARY = `## Active Task
turn context

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)

## Key Decisions
(none)

## Constraints & Preferences
(none)

## Critical Context
(none)`;

describe("worker attempt executor", () => {
	it("persists ordered boundaries and narrows a later request to the remaining token budget", async () => {
		const requestCaps: Array<number | undefined> = [];
		const harness = createExecutorHarness(async (options) => {
			requestCaps.push((await invokeRequestPreflight(options))?.maxTokens);
			const assistant = assistantToolRequest(60);
			const toolCall = assistant.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall" || !options.beforeToolCall) {
				throw new Error("Expected a worker tool gate.");
			}
			await options.beforeToolCall(
				{
					assistantMessage: assistant,
					toolCall,
					args: { path: "focused.ts" },
					context: { systemPrompt: "", messages: [], tools: [] },
				},
				undefined,
			);
			requestCaps.push((await invokeRequestPreflight(options))?.maxTokens);
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			};
			await options.onMessage?.(toolResult);
			const finalAssistant = fauxAssistantMessage(
				'{"summary":"read complete","status":"completed"}',
			) as AssistantMessage;
			await options.onMessage?.(finalAssistant);
			return {
				text: '{"summary":"read complete","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant, toolResult, finalAssistant],
			};
		});
		expect(harness.executor.ledger.getUsage()).toMatchObject({
			...ZERO_ATTEMPT_USAGE,
			activeWallClockMs: expect.any(Number),
		});
		expect(harness.checkpoints).toEqual([]);

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
		expect(requestCaps).toEqual([100, 40]);
		expect(harness.events.indexOf("append:assistant")).toBeLessThan(harness.events.indexOf("gate"));
		expect(harness.events.indexOf("append:toolResult")).toBeLessThan(harness.events.indexOf("ack"));
		expect(harness.checkpoints).toContain(
			"Persisted worker assistant tool request and its cumulative provider usage.",
		);
		expect(harness.checkpoints.at(-1)).toBe("Persisted final cumulative worker usage before terminal result.");
	});

	it("blocks the second provider request after the first response exhausts the token budget", async () => {
		let providerRequests = 0;
		const harness = createExecutorHarness(async (options) => {
			await invokeRequestPreflight(options);
			providerRequests++;
			const assistant = assistantToolRequest(100);
			const toolCall = assistant.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall" || !options.beforeToolCall) {
				throw new Error("Expected a worker tool gate.");
			}
			await options.beforeToolCall(
				{
					assistantMessage: assistant,
					toolCall,
					args: { path: "focused.ts" },
					context: { systemPrompt: "", messages: [], tools: [] },
				},
				undefined,
			);
			await invokeRequestPreflight(options);
			providerRequests++;
			throw new Error("second provider request should not be issued");
		});

		const result = await harness.executor.run();

		expect(providerRequests).toBe(1);
		expect(result.rawOutcome).toMatchObject({ accepted: false, claim: { status: "failed" } });
	});

	it("retains provider usage when persisting a tool request fails before tool execution", async () => {
		let toolRan = false;
		const harness = createExecutorHarness(
			async (options) => {
				await invokeRequestPreflight(options);
				const assistant = assistantToolRequest(37);
				const toolCall = assistant.content.find((content) => content.type === "toolCall");
				if (!toolCall || toolCall.type !== "toolCall" || !options.beforeToolCall) {
					throw new Error("Expected a worker tool gate.");
				}
				await options.beforeToolCall(
					{
						assistantMessage: assistant,
						toolCall,
						args: { path: "focused.ts" },
						context: { systemPrompt: "", messages: [], tools: [] },
					},
					undefined,
				);
				toolRan = true;
				throw new Error("tool request persistence failure should abort completion");
			},
			100,
			(message) => {
				if (message.role === "assistant") throw new Error("durable append failed");
			},
		);

		const result = await harness.executor.run();

		expect(toolRan).toBe(false);
		expect(result.rawOutcome).toMatchObject({ accepted: false, claim: { status: "failed" } });
		expect(result.usage).toMatchObject({ inputTokens: 37, totalTokens: 37 });
		expect(harness.checkpoints.at(-1)).toBe("Persisted final cumulative worker usage before terminal result.");
		expect(harness.checkpointUsages.at(-1)).toMatchObject({ inputTokens: 37, totalTokens: 37 });
	});

	it("uses the lane-pinned model for verified worker compaction and checkpoints its provider usage", async () => {
		const compactionModels: Model<Api>[] = [];
		const compactionPreflightCaps: Array<number | undefined> = [];
		const harness = createExecutorHarness(
			async (options) => {
				if (options.laneKind === "worker-compaction") {
					compactionModels.push(options.model!);
					compactionPreflightCaps.push((await invokeRequestPreflight(options))?.maxTokens);
					return {
						text: VERIFIED_COMPACTION_SUMMARY,
						usage: { ...ZERO_USAGE, input: 11, totalTokens: 11 },
						stopReason: "stop",
					};
				}
				await options.transformContext?.(options.history ?? []);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
				};
			},
			100,
			undefined,
			{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
		);
		for (let index = 0; index < 36; index++) {
			harness.conversation.appendMessage({
				role: "user",
				content: `turn-${index}: ${"context ".repeat(80)}`,
				timestamp: index + 1,
			});
		}

		await harness.executor.run();

		expect(compactionModels).toHaveLength(1);
		expect(compactionModels[0]).toMatchObject({ provider: "faux", id: "faux-1" });
		expect(compactionPreflightCaps).toEqual([100]);
		expect(harness.conversation.hasProviderCompaction()).toBe(true);
		expect(harness.gateway.getUsage()).toMatchObject({ inputTokens: 11, totalTokens: 11 });
		expect(harness.checkpoints).toContain("Persisted worker compaction provider usage before verification.");
		expect(harness.checkpointUsages.at(-1)).toMatchObject({ inputTokens: 11, totalTokens: 11 });
	});

	it("falls back deterministically after rejected verified compactions while retaining every failed attempt usage", async () => {
		let compactionCalls = 0;
		const harness = createExecutorHarness(
			async (options) => {
				if (options.laneKind === "worker-compaction") {
					await invokeRequestPreflight(options);
					compactionCalls++;
					return {
						text: "not a valid checkpoint",
						usage: { ...ZERO_USAGE, input: 7, totalTokens: 7 },
						stopReason: "stop",
					};
				}
				await options.transformContext?.(options.history ?? []);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
				};
			},
			100,
			undefined,
			{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
		);
		for (let index = 0; index < 36; index++) {
			harness.conversation.appendMessage({
				role: "user",
				content: `turn-${index}: ${"context ".repeat(80)}`,
				timestamp: index + 1,
			});
		}

		await harness.executor.run();

		expect(compactionCalls).toBe(2);
		expect(harness.conversation.getProviderContext().messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Deterministic checkpoint used"),
		});
		expect(harness.gateway.getUsage()).toMatchObject({ inputTokens: 14, totalTokens: 14 });
		expect(
			harness.checkpoints.filter(
				(summary) => summary === "Persisted worker compaction provider usage before verification.",
			),
		).toHaveLength(2);
		expect(harness.checkpointUsages.at(-1)).toMatchObject({ inputTokens: 14, totalTokens: 14 });
	});
});
