import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DurableLearningState } from "../src/core/learning/durable-learning-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
	CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
	type CurrentTurnReflectionCueState,
} from "../src/core/reflection-controller.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;
	const originalNativeReflection = process.env.PI_NATIVE_REFLECTION;
	const originalAutoLearnChild = process.env.PI_AUTO_LEARN_CHILD;
	const originalSessionRole = process.env.PI_SESSION_ROLE;

	beforeEach(() => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.disposeAndWait();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		if (originalNativeReflection === undefined) delete process.env.PI_NATIVE_REFLECTION;
		else process.env.PI_NATIVE_REFLECTION = originalNativeReflection;
		if (originalAutoLearnChild === undefined) delete process.env.PI_AUTO_LEARN_CHILD;
		else process.env.PI_AUTO_LEARN_CHILD = originalAutoLearnChild;
		if (originalSessionRole === undefined) delete process.env.PI_SESSION_ROLE;
		else process.env.PI_SESSION_ROLE = originalSessionRole;
	});

	function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		delayAssistantMessageEndMs?: number;
		baseDelayMs?: number;
		onRequest?: (callCount: number, maxTokens: number | undefined) => void;
		autoLearn?: boolean;
		maxOutputTokens?: number;
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		const baseDelayMs = options?.baseDelayMs ?? 1;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, streamOptions) => {
				callCount++;
				options?.onRequest?.(callCount, streamOptions?.maxTokens);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries, baseDelayMs },
			...(options?.autoLearn ? { autoLearn: { enabled: true, reflectionReview: true } } : {}),
			...(options?.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("keeps one exact version claim across automatic retry and completes it only after success", async () => {
		const created = createSession({
			failCount: 1,
			autoLearn: true,
		});
		await created.session.bindExtensions({});

		await created.session.prompt("Retry while retaining the exact version claim");
		// A version claim never buys a reflection turn on its own, so the retried turn only promotes the
		// cue to `due`. A later turn that raises real evidence is what buys the one reflection turn that
		// carries and settles it — and the claim must survive both the retry and that wait as ONE claim.
		await created.session.prompt("Remember that this run retained its exact version claim");
		// The reflection turn is detached from `prompt()`, so settle it deterministically rather than
		// racing it with a timer.
		await created.session.settleReflectionTurn();

		// 2 for the retried first turn, 1 for the second, 1 for the single reflection turn it bought.
		expect(created.getCallCount()).toBe(4);
		const states = created.session.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE
					? [entry.data as CurrentTurnReflectionCueState]
					: [],
			);
		const claimIds = states
			.map((state) => state.versionChange?.token.claimId)
			.filter((claimId): claimId is string => !!claimId);
		expect(new Set(claimIds)).toHaveLength(1);
		expect(states.map((state) => state.status)).toEqual(["pending", "due", "due", "consumed", "consumed"]);
		expect(DurableLearningState.forAgentDir(tempDir).readSnapshot()).toMatchObject({
			currentTransitionId: null,
			currentClaimOwnerId: null,
			resolvedTransitions: 1,
		});
	});

	it("queues steering during retry backoff instead of starting a concurrent run", async () => {
		const created = createSession({ failCount: 1, baseDelayMs: 200 });
		const retryEnds: boolean[] = [];
		let steerPromise: Promise<void> | undefined;
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !steerPromise) {
				expect(created.session.isRetrying).toBe(true);
				steerPromise = created.session.prompt("steer me mid-retry", { streamingBehavior: "steer" });
			}
			if (event.type === "auto_retry_end") retryEnds.push(event.success);
		});

		await created.session.prompt("Hello");
		expect(steerPromise).toBeDefined();
		await steerPromise;

		// The retry itself completed; steering did not cancel or race it.
		expect(retryEnds).toEqual([true]);
		// One failed call plus exactly one retried turn that incorporates the queued
		// steering — no concurrent third run.
		expect(created.getCallCount()).toBe(2);

		const branchMessages = created.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const steerIndex = branchMessages.findIndex(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("steer me mid-retry"),
		);
		const successIndex = branchMessages.findIndex(
			(message) => message.role === "assistant" && JSON.stringify(message.content).includes("Success"),
		);
		// The steering message was consumed by the retried turn, not dropped.
		expect(steerIndex).toBeGreaterThan(-1);
		expect(successIndex).toBeGreaterThan(steerIndex);
	});

	it("keeps a queued chat goal's execution lease across retry", async () => {
		const requestMaxTokens: Array<number | undefined> = [];
		const created = createSession({
			failCount: 1,
			baseDelayMs: 50,
			onRequest: (_callCount, maxTokens) => requestMaxTokens.push(maxTokens),
		});
		let queuedGoal: Promise<void> | undefined;
		created.session.subscribe((event) => {
			if (event.type !== "auto_retry_start" || queuedGoal) return;
			queuedGoal = created.session.prompt(
				"Set a persistent goal: keep retry admission bounded with a token budget of 5000.",
				{ autoContinueGoal: false, streamingBehavior: "steer" },
			);
		});

		await created.session.prompt("Hello", { autoContinueGoal: false });
		await queuedGoal;

		expect(created.getCallCount()).toBe(2);
		// Every request carries the session output cap; the goal budget narrows it once it applies.
		expect(requestMaxTokens).toEqual([DEFAULT_MAX_OUTPUT_TOKENS, 5000]);
		expect(created.session.getGoalStateSnapshot()).toMatchObject({ tokenBudget: 5000 });
	});

	it("caps every request's output at the session setting, never above the model's own limit", async () => {
		const capped: Array<number | undefined> = [];
		const created = createSession({
			failCount: 0,
			maxOutputTokens: 1234,
			onRequest: (_callCount, maxTokens) => capped.push(maxTokens),
		});
		await created.session.prompt("Hello", { autoContinueGoal: false });
		expect(capped).toEqual([1234]);

		// A cap above the model's limit is narrowed to the limit, so a registry maximum is never widened.
		const wide: Array<number | undefined> = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const widened = createSession({
			failCount: 0,
			maxOutputTokens: model.maxTokens + 1,
			onRequest: (_callCount, maxTokens) => wide.push(maxTokens),
		});
		await widened.session.prompt("Hello", { autoContinueGoal: false });
		expect(wide).toEqual([model.maxTokens]);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		await created.session.disposeAndWait();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
