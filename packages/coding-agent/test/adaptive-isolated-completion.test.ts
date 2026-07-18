import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R2 prerequisite: AgentSession.runIsolatedCompletion must run a one-shot LLM call FULLY isolated
 * from the main session — the invariant codex's §6(c) audit requires before the native reflection
 * engine can run in-process. We stub streamFn to capture what the primitive sends and assert it
 * mutates nothing.
 */
describe("runIsolatedCompletion isolation invariants", () => {
	let tempDir: string;
	let agentDir: string;

	const newSession = async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns text+usage and leaves session entries, history, and tools untouched", async () => {
		const session = await newSession();

		const fakeReply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "lesson: prefer X" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		// Stub the low-level stream: capture what the primitive sends, return our canned reply.
		(session.agent as unknown as { streamFn: unknown }).streamFn = async (
			_model: unknown,
			context: Context,
			options: SimpleStreamOptions,
		) => {
			capturedContext = context;
			capturedOptions = options;
			return { result: async () => fakeReply };
		};

		const entriesBefore = session.sessionManager.getEntries().length;
		const historyBefore = session.state.messages.length;
		const toolsBefore = session.getAllTools().map((t) => t.name);

		const result = await session.runIsolatedCompletion({
			systemPrompt: "You are a reflection engine.",
			messages: [{ role: "user", content: [{ type: "text", text: "What did we learn?" }], timestamp: Date.now() }],
			maxTokens: 64,
			cacheRetention: "none",
		});

		// Result is surfaced.
		expect(result.text).toBe("lesson: prefer X");
		expect(result.usage.cost.total).toBeCloseTo(0.003, 10);
		expect(result.stopReason).toBe("stop");

		// Isolation of the OUTGOING call.
		expect(capturedContext?.tools).toEqual([]);
		expect(capturedOptions?.cacheRetention).toBe("none");
		expect(capturedOptions?.reasoning).toBe("off");
		// No REAL sessionId crosses the isolation boundary, but a synthetic, namespaced
		// cache-affinity key is now sent so provider-side session-affinity caching can still route
		// repeat calls from the same lane consistently.
		expect(capturedOptions?.sessionId).toBeDefined();
		expect(capturedOptions?.sessionId).toMatch(/^lane:/);
		expect(capturedOptions?.sessionId).not.toBe(session.sessionId);
		expect(capturedOptions?.sessionId).not.toContain(session.sessionId);
		// Main history was NOT used as the context.
		expect(capturedContext?.messages).toHaveLength(1);

		// Isolation of the SESSION state: nothing mutated.
		expect(session.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(session.state.messages.length).toBe(historyBefore);
		expect(session.getAllTools().map((t) => t.name)).toEqual(toolsBefore);

		session.dispose();
	});

	it("gives each lane a stable, namespace-isolated synthetic cache-affinity key", async () => {
		const session = await newSession();

		const fakeReply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const seenSessionIds: (string | undefined)[] = [];
		(session.agent as unknown as { streamFn: unknown }).streamFn = async (
			_model: unknown,
			_context: Context,
			options: SimpleStreamOptions,
		) => {
			seenSessionIds.push(options.sessionId);
			return { result: async () => fakeReply };
		};

		const call = (laneKind: string, systemPrompt: string) =>
			session.runIsolatedCompletion({
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
				maxTokens: 8,
				laneKind,
				cacheRetention: "none",
			});

		await call("research", "same prompt");
		await call("research", "same prompt"); // repeat: same (laneKind, model, prompt) -> same key
		await call("worker", "same prompt"); // different lane -> different namespace
		await call("research", "different prompt"); // different prompt -> different key

		const [researchA, researchRepeat, worker, researchDifferentPrompt] = seenSessionIds;
		expect(researchA).toBeDefined();
		expect(researchA).toBe(researchRepeat);
		expect(researchA).not.toBe(worker);
		expect(researchA).not.toBe(researchDifferentPrompt);
		expect(worker).toMatch(/^lane:worker:/);
		expect(researchA).toMatch(/^lane:research:/);

		session.dispose();
	});
});

/**
 * `AgentSession.runIsolatedCompletion` forwards to `ReflectionController.runIsolatedCompletion`
 * (the SINGLE choke point every isolated completion in the codebase runs through — reflection,
 * research/worker/fitness lanes, context-pipeline curation, model-router judge calls), which must
 * register itself in the reload-gate quiesce registry (reload-blockers.ts) for the run's full
 * duration so `/reload`/profile-switch/live extension load-unload-reconcile wait it out.
 */
describe("runIsolatedCompletion — reload-gate quiesce registration", () => {
	let tempDir: string;
	let agentDir: string;

	const newSession = async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-isolated-quiesce-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		resetInFlightWorkRegistryForTests();
	});

	it("registers while the completion is in flight and deregisters once it resolves", async () => {
		const session = await newSession();

		const fakeReply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let resolveStream!: () => void;
		const streamGate = new Promise<void>((resolve) => {
			resolveStream = resolve;
		});
		(session.agent as unknown as { streamFn: unknown }).streamFn = async () => {
			await streamGate;
			return { result: async () => fakeReply };
		};

		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		const completionPromise = session.runIsolatedCompletion({
			systemPrompt: "system",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
			maxTokens: 8,
			laneKind: "test-lane",
			cacheRetention: "none",
		});

		// Let the synchronous setup run up to the gated streamFn call.
		await Promise.resolve();
		await Promise.resolve();
		const inFlight = getInFlightWorkUnits(agentDir);
		expect(inFlight).toHaveLength(1);
		expect(inFlight[0]?.kind).toBe("isolated-completion");
		expect(inFlight[0]?.label).toBe("test-lane");

		resolveStream();
		await completionPromise;

		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		session.dispose();
	});

	it("still deregisters when the completion throws", async () => {
		const session = await newSession();
		(session.agent as unknown as { streamFn: unknown }).streamFn = async () => {
			throw new Error("boom");
		};

		await expect(
			session.runIsolatedCompletion({
				systemPrompt: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
				maxTokens: 8,
				cacheRetention: "none",
			}),
		).rejects.toThrow("boom");

		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		session.dispose();
	});
});
