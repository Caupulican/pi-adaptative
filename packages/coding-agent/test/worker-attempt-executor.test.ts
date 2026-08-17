import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import type { LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import { createWorkerAttemptExecutor } from "../src/core/delegation/worker-attempt-executor.ts";
import { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerTreeBudgetCoordinator } from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { CapabilityGateway, type SharedCapabilityBudget } from "../src/core/orchestration/capability-gateway.ts";
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
	signal?: AbortSignal,
	maxWallClockMs = 30_000,
	autoPreflight = true,
	sharedBudget?: SharedCapabilityBudget,
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
		budget: { maxCostUsd: 1, maxTokens, maxToolCalls: 2, maxWallClockMs },
	};
	const gateway = new CapabilityGateway({
		grant,
		cwd: process.cwd(),
		...(sharedBudget ? { sharedBudget } : {}),
	});
	const toolSurface: LaneToolSurface = {
		tools: [],
		dispose: async () => {},
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
	const productionShapedCompletion = async (options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> => {
		let preflightInvoked = false;
		const requestPreflight = options.requestPreflight;
		let trackedOptions: IsolatedCompletionOptions;
		const ensurePreflight = async (): Promise<void> => {
			if (autoPreflight && !preflightInvoked) await invokeRequestPreflight(trackedOptions);
		};
		trackedOptions = requestPreflight
			? {
					...options,
					requestPreflight: (context, requestSignal) => {
						preflightInvoked = true;
						return requestPreflight(context, requestSignal);
					},
					...(options.beforeToolCall
						? {
								beforeToolCall: async (context, toolSignal) => {
									await ensurePreflight();
									return options.beforeToolCall?.(context, toolSignal);
								},
							}
						: {}),
					...(options.onMessage
						? {
								onMessage: async (message, origin) => {
									if (message.role === "assistant" && origin !== "local") await ensurePreflight();
									return options.onMessage?.(message, origin);
								},
							}
						: {}),
				}
			: options;
		const result = await runIsolatedCompletion(trackedOptions);
		await ensurePreflight();
		return result;
	};
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
		...(signal ? { signal } : {}),
		...(retentionPolicy ? { retentionPolicy } : {}),
		runIsolatedCompletion: productionShapedCompletion,
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
			await options.onMessage?.(assistant);
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
				usage: { ...ZERO_USAGE, input: 60, totalTokens: 60 },
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
		expect(result.usage).toMatchObject({ inputTokens: 60, totalTokens: 60 });
		expect(harness.checkpoints).not.toContain(
			"Persisted supplemental provider result usage before rejecting unverified completion evidence.",
		);
		expect(harness.checkpoints.at(-1)).toBe("Persisted final cumulative worker usage before terminal result.");
	});

	it("persists an immediate unknown-tool request before its error result", async () => {
		const harness = createExecutorHarness(async (options) => {
			const assistant = fauxAssistantMessage([fauxToolCall("memory", { query: "private" })], {
				stopReason: "toolUse",
			});
			const toolCall = assistant.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected an unknown tool request.");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "Tool memory not found" }],
				isError: true,
				timestamp: Date.now(),
			};
			const finalAssistant = fauxAssistantMessage('{"summary":"continued without memory","status":"completed"}');
			await options.onMessage?.(assistant);
			await options.onMessage?.(toolResult);
			await invokeRequestPreflight(options);
			await options.onMessage?.(finalAssistant);
			return {
				text: '{"summary":"continued without memory","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant, toolResult, finalAssistant],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.events.indexOf("append:assistant")).toBeLessThan(harness.events.indexOf("append:toolResult"));
	});

	it("releases an accounted tool-assistant reservation before nested provider admission", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const attemptBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		const nestedBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "nested-attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		let nestedSettledBeforeNextTurn = false;
		let nestedMaxTokens = 0;
		const harness = createExecutorHarness(
			async (options) => {
				await invokeRequestPreflight(options);
				const assistant = assistantToolRequest(20);
				const toolCall = assistant.content.find((content) => content.type === "toolCall");
				if (!toolCall || toolCall.type !== "toolCall" || !options.beforeToolCall) {
					throw new Error("Expected a worker tool gate.");
				}
				await options.onMessage?.(assistant);
				await options.beforeToolCall(
					{
						assistantMessage: assistant,
						toolCall,
						args: { path: "focused.ts" },
						context: { systemPrompt: "", messages: [], tools: [] },
					},
					undefined,
				);
				let nestedSettled = false;
				const nestedAdmission = nestedBudget
					.reserveProviderBudget(100, "nested provider request during parent tool execution")
					.then((reservation) => {
						nestedSettled = true;
						nestedMaxTokens = reservation.maxTokens;
						reservation.release();
					});
				await Promise.resolve();
				nestedSettledBeforeNextTurn = nestedSettled;
				const toolResult: Message = {
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "nested work complete" }],
					isError: false,
					timestamp: 2,
				};
				await options.onMessage?.(toolResult);
				await invokeRequestPreflight(options);
				await nestedAdmission;
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"nested work complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"nested work complete","status":"completed"}',
					usage: assistant.usage,
					stopReason: "stop",
					messages: [...(options.history ?? []), assistant, toolResult, finalAssistant],
				};
			},
			100,
			undefined,
			undefined,
			undefined,
			30_000,
			true,
			attemptBudget,
		);

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
		expect(nestedSettledBeforeNextTurn).toBe(true);
		expect(nestedMaxTokens).toBe(80);
	});

	it("persists a local terminal assistant after a tool result without consuming a provider reservation", async () => {
		const harness = createExecutorHarness(async (options) => {
			await invokeRequestPreflight(options);
			const assistant = assistantToolRequest(20);
			const toolCall = assistant.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall" || !options.beforeToolCall) {
				throw new Error("Expected a worker tool gate.");
			}
			await options.onMessage?.(assistant);
			await options.beforeToolCall(
				{
					assistantMessage: assistant,
					toolCall,
					args: { path: "focused.ts" },
					context: { systemPrompt: "", messages: [], tools: [] },
				},
				undefined,
			);
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "focused result" }],
				isError: false,
				timestamp: 2,
			};
			await options.onMessage?.(toolResult);
			const localTerminal = fauxAssistantMessage(
				'{"summary":"local terminal handoff persisted","status":"completed"}',
			) as AssistantMessage;
			await options.onMessage?.(localTerminal, "local");
			return {
				text: '{"summary":"local terminal handoff persisted","status":"completed"}',
				usage: assistant.usage,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant, toolResult, localTerminal],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome).toMatchObject({ accepted: true, reasonCode: "worker_completed" });
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(result.usage).toMatchObject({ inputTokens: 20, totalTokens: 20 });
	});

	it("redacts resolved provider failure metadata before persisting the worker result", async () => {
		const secret = "secret-token-123456789";
		const assistantText = `The provider documentation mentions Bearer ${secret}.`;
		const harness = createExecutorHarness(async (options) => {
			const assistant: AssistantMessage = {
				...fauxAssistantMessage(assistantText, { stopReason: "error" }),
				errorMessage: `Provider rejected Authorization: Bearer ${secret} ${"detail ".repeat(100)}`,
				diagnostics: [
					{
						type: "provider_transport_failure",
						timestamp: 123,
						error: {
							name: "TransportFailure",
							code: `credential=${secret}`,
							message: `socket failed Authorization: Bearer ${secret}\nraw second line`,
							stack: `Error: ${secret}\n at provider.ts:1`,
						},
						details: { rawAuthorization: `Bearer ${secret}` },
					},
				],
			};
			await options.onMessage?.(assistant);
			return {
				text: assistantText,
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: assistant.errorMessage,
				messages: [...(options.history ?? []), assistant],
			};
		});

		const result = await harness.executor.run();
		const persistedAssistant = harness.conversation
			.getRawTranscript()
			.findLast((message): message is AssistantMessage => message.role === "assistant");

		expect(persistedAssistant?.errorMessage).toHaveLength(240);
		expect(persistedAssistant?.errorMessage).toMatch(/^Provider rejected \[REDACTED\]/);
		expect(persistedAssistant?.errorMessage?.endsWith("…")).toBe(true);
		expect(persistedAssistant?.errorMessage).not.toContain(secret);
		expect(persistedAssistant?.diagnostics).toEqual([
			{
				type: "provider_transport_failure",
				timestamp: 123,
				error: {
					name: "TransportFailure",
					code: "[REDACTED]",
					message: "socket failed [REDACTED]",
				},
			},
		]);
		expect(JSON.stringify(persistedAssistant?.diagnostics)).not.toContain(secret);
		expect(JSON.stringify(persistedAssistant?.diagnostics)).not.toContain("rawAuthorization");
		expect(JSON.stringify(persistedAssistant?.diagnostics)).not.toContain("provider.ts");
		expect(persistedAssistant?.content).toEqual([{ type: "text", text: assistantText }]);
		expect(result.rawOutcome).toMatchObject({
			reasonCode: "completion_error",
			reasonDetail: persistedAssistant?.errorMessage,
			claim: { status: "failed" },
		});
		expect(JSON.stringify(result.rawOutcome)).not.toContain(secret);
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
		// A blocked second request is a budget-exhaustion denial (CapabilityGatewayDeniedError,
		// status "budget_exhausted"), and worker-runner.ts deliberately projects that as a "partial"
		// claim, not "failed" (commit 78a2158dd, "unblock partial DAGs") — a budget-exhausted worker
		// made real progress and should not permanently block DAG dependents like a hard failure would.
		expect(result.rawOutcome).toMatchObject({
			accepted: false,
			reasonCode: "token_budget_exhausted",
			claim: { status: "partial" },
		});
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

	it("rejects terminal completion results that cannot supply a new assistant suffix", async () => {
		const assistantFreeSuffix: Message = {
			role: "toolResult",
			toolCallId: "missing-assistant",
			toolName: "read",
			content: [{ type: "text", text: "orphaned result" }],
			isError: false,
			timestamp: 1,
		};
		const cases: Array<{ name: string; messages: (history: readonly Message[]) => Message[] }> = [
			{ name: "shorter than history", messages: () => [] },
			{ name: "empty suffix", messages: (history) => [...history] },
			{ name: "assistant-free suffix", messages: (history) => [...history, assistantFreeSuffix] },
			{
				name: "assistant without callback evidence",
				messages: (history) => [...history, fauxAssistantMessage('{"summary":"unevidenced","status":"completed"}')],
			},
		];
		for (const scenario of cases) {
			const harness = createExecutorHarness(async (options) => ({
				text: '{"summary":"worker complete","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: scenario.messages(options.history ?? []),
			}));

			const result = await harness.executor.run();

			expect(result.rawOutcome.accepted, scenario.name).toBe(false);
			expect(
				harness.conversation.getRawTranscript().map((message) => message.role),
				scenario.name,
			).toEqual(["user"]);
		}
	});

	it("ignores returned old-history drift but rejects bounded suffix drift from callback evidence", async () => {
		for (const drift of ["history", "suffix"] as const) {
			const durableAssistant = fauxAssistantMessage(
				'{"summary":"callback evidence","status":"completed"}',
			) as AssistantMessage;
			const harness = createExecutorHarness(async (options) => {
				await options.onMessage?.(durableAssistant);
				const history = options.history ?? [];
				if (history.length === 0 || history[0]?.role !== "user") {
					throw new Error("Expected the durable worker prompt in provider history.");
				}
				const messages =
					drift === "history"
						? [{ ...history[0], content: "mutated captured history" }, ...history.slice(1), durableAssistant]
						: [
								...history,
								fauxAssistantMessage('{"summary":"different suffix","status":"completed"}') as AssistantMessage,
							];
				return {
					text: '{"summary":"callback evidence","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages,
				};
			});

			const result = await harness.executor.run();

			expect(result.rawOutcome.accepted, drift).toBe(drift === "history");
			const assistants = harness.conversation
				.getRawTranscript()
				.filter((message): message is AssistantMessage => message.role === "assistant");
			expect(assistants, drift).toHaveLength(1);
			expect(assistants[0]?.content, drift).toEqual(durableAssistant.content);
		}
	});

	it("does not inspect returned old-history objects while validating the bounded durable suffix", async () => {
		let oldHistoryReads = 0;
		const finalAssistant = fauxAssistantMessage(
			'{"summary":"bounded validation","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(async (options) => {
			await options.onMessage?.(finalAssistant);
			const opaquePrefix = { role: "user", timestamp: 0 } as Message;
			Object.defineProperty(opaquePrefix, "content", {
				enumerable: true,
				get: () => {
					oldHistoryReads += 1;
					throw new Error("Old returned history must remain opaque.");
				},
			});
			return {
				text: '{"summary":"bounded validation","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...Array<Message>((options.history ?? []).length).fill(opaquePrefix), finalAssistant],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
		expect(oldHistoryReads).toBe(0);
	});

	it("rejects terminal scalar drift from the durable callback-evidenced assistant without retry", async () => {
		const assistant = fauxAssistantMessage('{"summary":"scalar evidence","status":"completed"}') as AssistantMessage;
		const cases: Array<{
			name: string;
			text: string;
			stopReason: IsolatedCompletionResult["stopReason"];
			usage: Usage;
		}> = [
			{ name: "text", text: "different text", stopReason: "stop", usage: ZERO_USAGE },
			{
				name: "stop reason",
				text: '{"summary":"scalar evidence","status":"completed"}',
				stopReason: "error",
				usage: ZERO_USAGE,
			},
			{
				name: "usage",
				text: '{"summary":"scalar evidence","status":"completed"}',
				stopReason: "stop",
				usage: { ...ZERO_USAGE, input: 1, totalTokens: 1 },
			},
		];
		for (const scenario of cases) {
			let providerCalls = 0;
			const harness = createExecutorHarness(async (options) => {
				providerCalls += 1;
				await options.onMessage?.(assistant);
				return {
					text: scenario.text,
					usage: scenario.usage,
					stopReason: scenario.stopReason,
					messages: [...(options.history ?? []), assistant],
				};
			});

			const result = await harness.executor.run();

			expect(result.rawOutcome.accepted, scenario.name).toBe(false);
			expect(providerCalls, scenario.name).toBe(1);
			expect(
				harness.conversation.getRawTranscript().filter((message) => message.role === "assistant"),
				scenario.name,
			).toHaveLength(1);
		}
	});

	it("accounts paid provider output before rejecting a result without callback evidence", async () => {
		const returnedUsage: Usage = {
			...ZERO_USAGE,
			input: 7,
			output: 4,
			totalTokens: 11,
			cost: { ...ZERO_USAGE.cost, input: 0.1, output: 0.2, total: 0.3 },
		};
		const harness = createExecutorHarness(async (options) => {
			await invokeRequestPreflight(options);
			return {
				text: '{"summary":"unevidenced paid output","status":"completed"}',
				usage: returnedUsage,
				stopReason: "stop",
				messages: [
					...(options.history ?? []),
					fauxAssistantMessage('{"summary":"unevidenced paid output","status":"completed"}'),
				],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 4, totalTokens: 11, costUsd: 0.3 });
		expect(harness.checkpoints).toContain(
			"Persisted supplemental provider result usage before rejecting unverified completion evidence.",
		);
	});

	it("accounts rejected provider output before handing its shared reservation to a sibling", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const attemptBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		const siblingBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "sibling-attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		let siblingAdmission: Promise<number> | undefined;
		let siblingSettled = false;
		const harness = createExecutorHarness(
			async (options) => {
				await invokeRequestPreflight(options);
				const assistant: AssistantMessage = {
					...fauxAssistantMessage('{"summary":"divergent shared spend","status":"completed"}'),
					usage: { ...ZERO_USAGE, input: 20, totalTokens: 20 },
				};
				await options.onMessage?.(assistant);
				siblingAdmission = siblingBudget
					.reserveProviderBudget(100, "queued sibling provider request")
					.then((reservation) => {
						siblingSettled = true;
						const maxTokens = reservation.maxTokens;
						reservation.release();
						return maxTokens;
					});
				await Promise.resolve();
				expect(siblingSettled).toBe(false);
				return {
					text: '{"summary":"divergent shared spend","status":"completed"}',
					usage: { ...ZERO_USAGE, input: 80, totalTokens: 80 },
					stopReason: "stop",
					messages: [...(options.history ?? []), assistant],
				};
			},
			100,
			undefined,
			undefined,
			undefined,
			30_000,
			true,
			attemptBudget,
		);

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		if (!siblingAdmission) throw new Error("Expected a queued sibling provider request.");
		expect(await siblingAdmission).toBe(20);
	});

	it("accounts only positive provider result deltas before rejecting divergent callback evidence", async () => {
		const callbackAssistant: AssistantMessage = {
			...fauxAssistantMessage('{"summary":"divergent paid output","status":"completed"}'),
			usage: {
				...ZERO_USAGE,
				input: 4,
				totalTokens: 4,
				cost: { ...ZERO_USAGE.cost, input: 0.2, total: 0.2 },
			},
		};
		const returnedUsage: Usage = {
			...ZERO_USAGE,
			input: 9,
			output: 3,
			totalTokens: 12,
			cost: { ...ZERO_USAGE.cost, input: 0.4, output: 0.4, total: 0.8 },
		};
		const harness = createExecutorHarness(async (options) => {
			await options.onMessage?.(callbackAssistant);
			return {
				text: '{"summary":"divergent paid output","status":"completed"}',
				usage: returnedUsage,
				stopReason: "stop",
				messages: [...(options.history ?? []), callbackAssistant],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(result.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12, costUsd: 0.8 });
		expect(
			harness.checkpoints.filter(
				(summary) =>
					summary ===
					"Persisted supplemental provider result usage before rejecting unverified completion evidence.",
			),
		).toHaveLength(1);
	});

	it("rejects a swallowed transcript sink failure without fallback append or provider retry", async () => {
		let providerCalls = 0;
		const assistant = fauxAssistantMessage(
			'{"summary":"must not fallback","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(
			async (options) => {
				providerCalls += 1;
				try {
					await options.onMessage?.(assistant);
				} catch {
					// Simulate an adapter that incorrectly swallows the durable sink failure.
				}
				return {
					text: '{"summary":"must not fallback","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), assistant],
				};
			},
			100,
			(message) => {
				if (message.role === "assistant") throw new Error("WebSocket error hidden by adapter");
			},
		);

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(providerCalls).toBe(1);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
	});

	it("does not retry a propagated transcript sink failure that resembles a transport error", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let providerCalls = 0;
		try {
			const assistant = fauxAssistantMessage(
				'{"summary":"must not retry","status":"completed"}',
			) as AssistantMessage;
			const harness = createExecutorHarness(
				async (options) => {
					providerCalls += 1;
					await options.onMessage?.(assistant);
					throw new Error("unreachable after transcript sink failure");
				},
				100,
				(message) => {
					if (message.role === "assistant") throw new Error("WebSocket error from durable transcript sink");
				},
			);

			const execution = harness.executor.run();
			for (let tick = 0; tick < 20 && providerCalls === 0; tick += 1) await Promise.resolve();
			expect(providerCalls).toBe(1);
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await execution;

			expect(result.rawOutcome.accepted).toBe(false);
			expect(providerCalls).toBe(1);
			expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it("poisons a completion when the adapter swallows its provider authority preflight failure", async () => {
		let providerCalls = 0;
		const assistant = fauxAssistantMessage(
			'{"summary":"must not bypass preflight","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(async (options) => {
			providerCalls += 1;
			try {
				await invokeRequestPreflight(options);
			} catch {
				// Simulate an adapter that incorrectly continues after the host authority callback failed.
			}
			await options.onMessage?.(assistant);
			return {
				text: '{"summary":"must not bypass preflight","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant],
			};
		});
		harness.gateway.reserveProviderBudget = async () => {
			throw new Error("provider budget reservation denied");
		};

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(providerCalls).toBe(1);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
	});

	it("rejects provider output when the adapter never invokes its authority preflight", async () => {
		let providerCalls = 0;
		const assistant = fauxAssistantMessage(
			'{"summary":"missing preflight","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(
			async (options) => {
				providerCalls += 1;
				await options.onMessage?.(assistant);
				return {
					text: '{"summary":"missing preflight","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), assistant],
				};
			},
			100,
			undefined,
			undefined,
			undefined,
			30_000,
			false,
		);

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(providerCalls).toBe(1);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
	});

	it("rejects a later assistant turn that skipped its own provider preflight", async () => {
		const partial = assistantToolRequest(0);
		const toolCall = partial.content.find((content) => content.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected tool call.");
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "durable result" }],
			isError: false,
			timestamp: 2,
		};
		const unauthorized = fauxAssistantMessage(
			'{"summary":"skipped second preflight","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(async (options) => {
			await invokeRequestPreflight(options);
			await options.onMessage?.(partial);
			if (!options.beforeToolCall) throw new Error("Expected tool gate.");
			await options.beforeToolCall(
				{
					assistantMessage: partial,
					toolCall,
					args: { path: "focused.ts" },
					context: { systemPrompt: "", messages: [], tools: [] },
				},
				undefined,
			);
			await options.onMessage?.(toolResult);
			try {
				await options.onMessage?.(unauthorized);
			} catch {
				// Simulate an adapter that swallows the missing second-turn reservation failure.
			}
			return {
				text: '{"summary":"skipped second preflight","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), partial, toolResult, unauthorized],
			};
		});

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("rejects and releases a successful provider preflight left unconsumed after the terminal assistant", async () => {
		const assistant = fauxAssistantMessage(
			'{"summary":"terminal before extra preflight","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(async (options) => {
			await invokeRequestPreflight(options);
			await options.onMessage?.(assistant);
			await invokeRequestPreflight(options);
			return {
				text: '{"summary":"terminal before extra preflight","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant],
			};
		});
		const reserveProviderBudget = harness.gateway.reserveProviderBudget.bind(harness.gateway);
		const release = vi.fn();
		harness.gateway.reserveProviderBudget = async (requestedMaxTokens, subject, signal) => {
			const reservation = await reserveProviderBudget(requestedMaxTokens, subject, signal);
			return {
				maxTokens: reservation.maxTokens,
				release: () => {
					reservation.release();
					release();
				},
			};
		};

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(release).toHaveBeenCalledTimes(2);
	});

	it("rejects overlapping provider preflights and releases the invalidated acquisition", async () => {
		let resolveReservation: ((reservation: { maxTokens: number; release(): void }) => void) | undefined;
		let reserveCalls = 0;
		const releaseFirst = vi.fn();
		const assistant = fauxAssistantMessage(
			'{"summary":"overlapping preflights","status":"completed"}',
		) as AssistantMessage;
		const harness = createExecutorHarness(async (options) => {
			const firstPreflight = invokeRequestPreflight(options).then(
				() => undefined,
				() => undefined,
			);
			await Promise.resolve();
			try {
				await invokeRequestPreflight(options);
			} catch {
				// Simulate an adapter that swallows the overlapping-preflight protocol failure.
			}
			await firstPreflight;
			try {
				await options.onMessage?.(assistant);
			} catch {
				// The poisoned completion must still fail after the adapter returns a result.
			}
			return {
				text: '{"summary":"overlapping preflights","status":"completed"}',
				usage: ZERO_USAGE,
				stopReason: "stop",
				messages: [...(options.history ?? []), assistant],
			};
		});
		harness.gateway.reserveProviderBudget = () => {
			reserveCalls += 1;
			return new Promise((resolve) => {
				resolveReservation = resolve;
			});
		};

		const execution = harness.executor.run();
		for (let tick = 0; tick < 20 && !resolveReservation; tick += 1) await Promise.resolve();
		expect(resolveReservation).toBeDefined();
		resolveReservation?.({ maxTokens: 100, release: releaseFirst });
		const result = await execution;

		expect(result.rawOutcome.accepted).toBe(false);
		expect(reserveCalls).toBe(1);
		expect(releaseFirst).toHaveBeenCalledTimes(1);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
	});

	it("releases a provider reservation acquired after the abort listener already fired", async () => {
		const controller = new AbortController();
		let resolveReservation: ((reservation: { maxTokens: number; release(): void }) => void) | undefined;
		let preflightStarted = false;
		let preflightSettled: Promise<void> | undefined;
		const release = vi.fn();
		const harness = createExecutorHarness(
			async (options) => {
				preflightStarted = true;
				preflightSettled = invokeRequestPreflight(options).then(
					() => undefined,
					() => undefined,
				);
				return new Promise<IsolatedCompletionResult>(() => undefined);
			},
			100,
			undefined,
			undefined,
			controller.signal,
		);
		harness.gateway.reserveProviderBudget = () =>
			new Promise((resolve) => {
				resolveReservation = resolve;
			});

		const execution = harness.executor.run();
		for (let tick = 0; tick < 20 && !preflightStarted; tick += 1) await Promise.resolve();
		expect(preflightStarted).toBe(true);
		controller.abort(new Error("cancel while provider reservation is pending"));
		resolveReservation?.({ maxTokens: 100, release });
		await preflightSettled;
		const result = await execution;

		expect(result.rawOutcome.accepted).toBe(false);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("resumes a transient retry from its durable callback suffix without duplicating partial output", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let providerCalls = 0;
		try {
			const partial = assistantToolRequest(0);
			const toolCall = partial.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected retry tool call.");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "durable partial result" }],
				isError: false,
				timestamp: 2,
			};
			const finalAssistant = fauxAssistantMessage(
				'{"summary":"retry complete","status":"completed"}',
			) as AssistantMessage;
			const harness = createExecutorHarness(async (options) => {
				providerCalls += 1;
				if (providerCalls === 1) {
					await options.onMessage?.(partial);
					if (!options.beforeToolCall) throw new Error("Expected retry tool gate.");
					await options.beforeToolCall(
						{
							assistantMessage: partial,
							toolCall,
							args: { path: "focused.ts" },
							context: { systemPrompt: "", messages: [], tools: [] },
						},
						undefined,
					);
					await options.onMessage?.(toolResult);
					throw new Error("WebSocket error: connection lost");
				}
				expect(options.history?.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"retry complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
				};
			});
			const abortTranscriptCommit = vi.spyOn(harness.conversation, "abortTranscriptCommit");

			const execution = harness.executor.run();
			for (let tick = 0; tick < 20 && providerCalls === 0; tick += 1) await Promise.resolve();
			expect(providerCalls).toBe(1);
			await vi.advanceTimersByTimeAsync(2_500);
			const result = await execution;

			expect(result.rawOutcome.accepted).toBe(true);
			expect(providerCalls).toBe(2);
			expect(abortTranscriptCommit).toHaveBeenCalledTimes(1);
			expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(
				harness.conversation
					.getRawTranscript()
					.filter((message): message is AssistantMessage => message.role === "assistant")
					.map((message) => message.content),
			).toEqual([partial.content, finalAssistant.content]);
			abortTranscriptCommit.mockRestore();
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it("retries a returned overloaded completion from its durable error suffix", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let providerCalls = 0;
		try {
			const overloaded = fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider service overloaded; try again later",
			}) as AssistantMessage;
			const recovered = fauxAssistantMessage(
				'{"summary":"overload retry complete","status":"completed"}',
			) as AssistantMessage;
			const harness = createExecutorHarness(async (options) => {
				providerCalls += 1;
				const assistant = providerCalls === 1 ? overloaded : recovered;
				if (providerCalls === 2) {
					expect(options.history?.map((message) => message.role)).toEqual(["user", "assistant"]);
				}
				await options.onMessage?.(assistant);
				return {
					text: providerCalls === 1 ? "" : '{"summary":"overload retry complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: assistant.stopReason,
					...(assistant.errorMessage ? { errorMessage: assistant.errorMessage } : {}),
					messages: [...(options.history ?? []), assistant],
				};
			});

			const execution = harness.executor.run();
			for (let tick = 0; tick < 20 && providerCalls === 0; tick += 1) await Promise.resolve();
			expect(providerCalls).toBe(1);
			await vi.advanceTimersByTimeAsync(2_500);
			const result = await execution;

			expect(result.rawOutcome).toMatchObject({ accepted: true, reasonCode: "worker_completed" });
			expect(providerCalls).toBe(2);
			expect(harness.events.some((event) => event.includes("provider request failed (overloaded)"))).toBe(true);
			expect(
				harness.conversation
					.getRawTranscript()
					.filter((message): message is AssistantMessage => message.role === "assistant")
					.map((message) => ({ stopReason: message.stopReason, errorMessage: message.errorMessage })),
			).toEqual([
				{
					stopReason: "error",
					errorMessage: "Provider service overloaded; try again later",
				},
				{ stopReason: "stop", errorMessage: undefined },
			]);
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it("surfaces exhausted returned provider failures as durable retry evidence", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let providerCalls = 0;
		try {
			const errorMessage = "Provider service overloaded; try again later";
			const harness = createExecutorHarness(async (options) => {
				providerCalls += 1;
				const assistant = fauxAssistantMessage("", { stopReason: "error", errorMessage }) as AssistantMessage;
				await options.onMessage?.(assistant);
				return {
					text: "",
					usage: ZERO_USAGE,
					stopReason: "error",
					errorMessage,
					messages: [...(options.history ?? []), assistant],
				};
			});

			const execution = harness.executor.run();
			for (let tick = 0; tick < 20 && providerCalls === 0; tick += 1) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await execution;

			expect(providerCalls).toBe(3);
			expect(result.rawOutcome).toMatchObject({
				accepted: false,
				laneStatus: "failed",
				reasonCode: "completion_error",
				reasonDetail: errorMessage,
			});
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it("gates the final claim against cumulative provider spend across a transient retry", async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let providerCalls = 0;
		try {
			const partial: AssistantMessage = {
				...assistantToolRequest(0),
				usage: {
					...ZERO_USAGE,
					cost: { ...ZERO_USAGE.cost, total: 0.6 },
				},
			};
			const toolCall = partial.content.find((content) => content.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected retry tool call.");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "durable partial result" }],
				isError: false,
				timestamp: 2,
			};
			const finalAssistant: AssistantMessage = {
				...fauxAssistantMessage('{"summary":"retry complete","status":"completed"}'),
				usage: {
					...ZERO_USAGE,
					cost: { ...ZERO_USAGE.cost, total: 0.6 },
				},
			};
			const harness = createExecutorHarness(async (options) => {
				providerCalls += 1;
				await invokeRequestPreflight(options);
				if (providerCalls === 1) {
					await options.onMessage?.(partial);
					if (!options.beforeToolCall) throw new Error("Expected retry tool gate.");
					await options.beforeToolCall(
						{
							assistantMessage: partial,
							toolCall,
							args: { path: "focused.ts" },
							context: { systemPrompt: "", messages: [], tools: [] },
						},
						undefined,
					);
					await options.onMessage?.(toolResult);
					throw new Error("WebSocket error: connection lost");
				}
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"retry complete","status":"completed"}',
					usage: finalAssistant.usage,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
				};
			});

			const execution = harness.executor.run();
			for (let tick = 0; tick < 20 && providerCalls === 0; tick += 1) await Promise.resolve();
			expect(providerCalls).toBe(1);
			await vi.advanceTimersByTimeAsync(2_500);
			const result = await execution;

			expect(providerCalls).toBe(2);
			expect(result.usage.costUsd).toBeCloseTo(1.2);
			expect(result.rawOutcome).toMatchObject({
				laneStatus: "budget_exhausted",
				reasonCode: "cost_budget_exceeded",
			});
		} finally {
			random.mockRestore();
			vi.useRealTimers();
		}
	});

	it("revokes the transcript cursor before a non-cooperative completion can emit or resolve after abort", async () => {
		const controller = new AbortController();
		let isolatedOptions: IsolatedCompletionOptions | undefined;
		let resolveCompletion: ((result: IsolatedCompletionResult) => void) | undefined;
		const harness = createExecutorHarness(
			async (options) => {
				isolatedOptions = options;
				return new Promise<IsolatedCompletionResult>((resolve) => {
					resolveCompletion = resolve;
				});
			},
			100,
			undefined,
			undefined,
			controller.signal,
		);
		const execution = harness.executor.run();
		for (let tick = 0; tick < 20 && !isolatedOptions; tick += 1) await Promise.resolve();
		expect(isolatedOptions).toBeDefined();

		controller.abort(new Error("cancel non-cooperative worker"));
		const result = await execution;
		const lateAssistant = fauxAssistantMessage(
			'{"summary":"late completion","status":"completed"}',
		) as AssistantMessage;
		await expect(isolatedOptions?.onMessage?.(lateAssistant)).rejects.toThrow();
		resolveCompletion?.({
			text: '{"summary":"late completion","status":"completed"}',
			usage: ZERO_USAGE,
			stopReason: "stop",
			messages: [...(isolatedOptions?.history ?? []), lateAssistant],
		});
		for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

		expect(result.rawOutcome.accepted).toBe(false);
		expect(harness.conversation.getRawTranscript().map((message) => message.role)).toEqual(["user"]);
	});

	it("does not apply or account a verified compaction that resolves after the composed signal aborts", async () => {
		vi.useFakeTimers();
		let resolveCompaction: ((result: IsolatedCompletionResult) => void) | undefined;
		try {
			const harness = createExecutorHarness(
				async (options) => {
					if (options.laneKind === "worker-compaction") {
						return new Promise<IsolatedCompletionResult>((resolve) => {
							resolveCompaction = resolve;
						});
					}
					await options.transformContext?.(options.history ?? []);
					throw new Error("main completion must remain blocked behind compaction");
				},
				100,
				undefined,
				{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
				undefined,
				1_000,
			);
			for (let index = 0; index < 36; index++) {
				harness.conversation.appendMessage({
					role: "user",
					content: `turn-${index}: ${"context ".repeat(80)}`,
					timestamp: index + 1,
				});
			}
			const execution = harness.executor.run();
			for (let tick = 0; tick < 40 && !resolveCompaction; tick += 1) await Promise.resolve();
			expect(resolveCompaction).toBeDefined();

			await vi.advanceTimersByTimeAsync(1_100);
			const result = await execution;
			resolveCompaction?.({
				text: VERIFIED_COMPACTION_SUMMARY,
				usage: { ...ZERO_USAGE, input: 11, totalTokens: 11 },
				stopReason: "stop",
			});
			for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();

			expect(result.rawOutcome.accepted).toBe(false);
			expect(harness.conversation.hasProviderCompaction()).toBe(false);
			expect(harness.gateway.getUsage()).toMatchObject({ inputTokens: 0, totalTokens: 0 });
			expect(harness.checkpoints).not.toContain("Persisted worker compaction provider usage before verification.");
		} finally {
			vi.useRealTimers();
		}
	});

	it("accounts verified compaction before handing its shared reservation to a sibling", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const attemptBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		const siblingBudget = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "sibling-attempt",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: ZERO_ATTEMPT_USAGE,
		});
		let siblingAdmission: Promise<number> | undefined;
		const harness = createExecutorHarness(
			async (options) => {
				if (options.laneKind === "worker-compaction") {
					await invokeRequestPreflight(options);
					siblingAdmission ??= siblingBudget
						.reserveProviderBudget(100, "queued sibling after compaction")
						.then((reservation) => {
							const maxTokens = reservation.maxTokens;
							reservation.release();
							return maxTokens;
						});
					return {
						text: VERIFIED_COMPACTION_SUMMARY,
						usage: { ...ZERO_USAGE, input: 80, totalTokens: 80 },
						stopReason: "stop",
					};
				}
				await options.transformContext?.(options.history ?? []);
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"worker complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
				};
			},
			100,
			undefined,
			{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
			undefined,
			30_000,
			true,
			attemptBudget,
		);
		for (let index = 0; index < 36; index++) {
			harness.conversation.appendMessage({
				role: "user",
				content: `turn-${index}: ${"context ".repeat(80)}`,
				timestamp: index + 1,
			});
		}

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
		if (!siblingAdmission) throw new Error("Expected a queued sibling provider request.");
		expect(await siblingAdmission).toBe(20);
		expect(harness.gateway.getUsage()).toMatchObject({ inputTokens: 80, totalTokens: 80 });
	});

	it("accounts output from swallowed compaction preflight failures before rejecting it", async () => {
		let compactionCalls = 0;
		const harness = createExecutorHarness(
			async (options) => {
				if (options.laneKind === "worker-compaction") {
					compactionCalls += 1;
					try {
						await invokeRequestPreflight(options);
					} catch {
						// Simulate an adapter that incorrectly returns output after authority rejection.
					}
					return {
						text: VERIFIED_COMPACTION_SUMMARY,
						usage: { ...ZERO_USAGE, input: 11, totalTokens: 11 },
						stopReason: "stop",
					};
				}
				await options.transformContext?.(options.history ?? []);
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"worker complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
				};
			},
			100,
			undefined,
			{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
		);
		const reserveProviderBudget = harness.gateway.reserveProviderBudget.bind(harness.gateway);
		harness.gateway.reserveProviderBudget = (requestedMaxTokens, subject, signal) => {
			if (subject === "worker_compaction_provider_completion") {
				return Promise.reject(new Error("compaction provider reservation denied"));
			}
			return reserveProviderBudget(requestedMaxTokens, subject, signal);
		};
		for (let index = 0; index < 36; index++) {
			harness.conversation.appendMessage({
				role: "user",
				content: `turn-${index}: ${"context ".repeat(80)}`,
				timestamp: index + 1,
			});
		}

		const result = await harness.executor.run();
		const compacted = harness.conversation.getProviderContext().messages[0];

		expect(result.rawOutcome.accepted).toBe(true);
		expect(compactionCalls).toBeGreaterThan(0);
		expect(compacted).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Deterministic checkpoint used"),
		});
		expect(harness.gateway.getUsage()).toMatchObject({
			inputTokens: compactionCalls * 11,
			totalTokens: compactionCalls * 11,
		});
		expect(
			harness.checkpoints.filter(
				(summary) => summary === "Persisted worker compaction provider usage before verification.",
			),
		).toHaveLength(compactionCalls);
	});

	it("rejects compaction provider output when the adapter omits its authority preflight", async () => {
		let compactionCalls = 0;
		const harness = createExecutorHarness(
			async (options) => {
				if (options.laneKind === "worker-compaction") {
					compactionCalls += 1;
					return {
						text: VERIFIED_COMPACTION_SUMMARY,
						usage: { ...ZERO_USAGE, input: 11, totalTokens: 11 },
						stopReason: "stop",
					};
				}
				await options.transformContext?.(options.history ?? []);
				await invokeRequestPreflight(options);
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"worker complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
				};
			},
			100,
			undefined,
			{ maxContextTokens: 5_000, keepRecentTokens: 1_500 },
			undefined,
			30_000,
			false,
		);
		for (let index = 0; index < 36; index++) {
			harness.conversation.appendMessage({
				role: "user",
				content: `turn-${index}: ${"context ".repeat(80)}`,
				timestamp: index + 1,
			});
		}

		const result = await harness.executor.run();
		const compacted = harness.conversation.getProviderContext().messages[0];

		expect(result.rawOutcome.accepted).toBe(true);
		expect(compactionCalls).toBeGreaterThan(0);
		expect(compacted).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Deterministic checkpoint used"),
		});
		expect(harness.gateway.getUsage()).toMatchObject({
			inputTokens: compactionCalls * 11,
			totalTokens: compactionCalls * 11,
		});
		expect(
			harness.checkpoints.filter(
				(summary) => summary === "Persisted worker compaction provider usage before verification.",
			),
		).toHaveLength(compactionCalls);
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
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"worker complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
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

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
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
				const finalAssistant = fauxAssistantMessage(
					'{"summary":"worker complete","status":"completed"}',
				) as AssistantMessage;
				await options.onMessage?.(finalAssistant);
				return {
					text: '{"summary":"worker complete","status":"completed"}',
					usage: ZERO_USAGE,
					stopReason: "stop",
					messages: [...(options.history ?? []), finalAssistant],
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

		const result = await harness.executor.run();

		expect(result.rawOutcome.accepted).toBe(true);
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
