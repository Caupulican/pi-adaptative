/**
 * Repro for: auto-compaction not replacing the live context (manual /compact works).
 *
 * Drives the REAL trigger -> prepare -> summarize -> apply pipeline offline: only the
 * LLM wire is faked (huge usage on conversation replies to trip the hard threshold;
 * a small summary reply while compaction is in flight). No kernel mocks.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CompactionSupport, type CompactionSupportDeps } from "../src/core/compaction-support.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { LaneFitnessScore, ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function lane(succeeded = 3, total = 3): LaneFitnessScore {
	return { succeeded, total, outcomes: [], meanMs: 1 };
}

function report(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	return {
		trials: 3,
		research: lane(),
		worker: lane(),
		judge: {
			parsed: 3,
			planningElevated: 3,
			planningTotal: 3,
			trivialCheap: 3,
			trivialTotal: 3,
			total: 3,
			outcomes: [],
			meanMs: 1,
		},
		search: lane(),
		toolCall: lane(),
		digest: lane(),
		totalCostUsd: 0,
		...overrides,
	};
}

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function compactionSupportFixture(options: {
	compactionModel?: string;
	routerEnabled?: boolean;
	cheapModel?: string;
	cheapThinking?: ThinkingLevel;
	exhausted?: readonly string[];
	fitness?: Record<string, ModelFitnessReport>;
	authed?: readonly string[];
}): {
	support: CompactionSupport;
	sessionModel: Model<"openai-completions">;
	cheapModel: Model<"openai-completions">;
	warnings: string[];
} {
	const sessionModel = model("session");
	const cheapModel = model("cheap");
	const settings = {
		getCompactionModel: () => options.compactionModel ?? "auto",
		getModelRouterSettings: () => ({
			enabled: options.routerEnabled ?? false,
			cheapModel: options.cheapModel,
			cheapThinking: options.cheapThinking,
		}),
	};
	const models = [sessionModel, cheapModel];
	const authed = new Set(options.authed ?? models.map((entry) => `${entry.provider}/${entry.id}`));
	const registry = {
		getAll: () => models,
		hasConfiguredAuth: (entry: Model<"openai-completions">) => authed.has(`${entry.provider}/${entry.id}`),
	} as unknown as ModelRegistry;
	const exhausted = new Set(options.exhausted ?? []);
	const warnings: string[] = [];
	return {
		support: new CompactionSupport({
			getModel: () => sessionModel,
			getSettingsManager: () => settings as ReturnType<CompactionSupportDeps["getSettingsManager"]>,
			getModelRegistry: () => registry,
			isRawStream: () => false,
			getRequiredRequestAuth: async () => ({}),
			isModelExhausted: (ref) => exhausted.has(ref),
			getStoredFitnessReport: (ref) => options.fitness?.[ref],
			// Small span: capacity never interferes with the behaviors under test here.
			estimateSummarizationInputTokens: () => 1_000,
			emitWarning: (message) => warnings.push(message),
		}),
		sessionModel,
		cheapModel,
		warnings,
	};
}

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

function assistantReply(text: string, inputTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: inputTokens,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("auto-compaction applies the compacted context (offline pipeline)", () => {
	let session: AgentSession;
	let tempDir: string;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-autocompact-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		// Hard trigger for this model (adapted reserve clamps to 25% of window):
		// contextWindow - min(reserve, window*0.25). Fake usage must exceed it.
		const contextWindow = model.contextWindow ?? 200_000;
		const hugeUsage = Math.floor(contextWindow * 0.9);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				const compacting = session?.isCompacting === true;
				queueMicrotask(() => {
					const message = compacting
						? assistantReply("## Summary\n- prior conversation summarized", 500)
						: assistantReply("big reply", hugeUsage);
					stream.push({ type: "done", reason: "stop", message } as AssistantMessageEvent);
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		session.subscribe((event) => {
			events.push(event);
		});
		return session;
	}

	function compactionEnds() {
		return events.filter((e) => e.type === "compaction_end") as Array<
			Extract<AgentSessionEvent, { type: "compaction_end" }>
		>;
	}

	it("cycle 1: threshold auto-compaction produces a result and replaces live messages", async () => {
		createSession();

		await session.prompt("hello one");
		await session.agent.waitForIdle();

		const ends = compactionEnds();
		expect(ends.length, `expected an auto compaction_end, events: ${events.map((e) => e.type).join(",")}`).toBe(1);
		expect(ends[0].reason).toBe("threshold");
		expect(ends[0].errorMessage).toBeUndefined();
		expect(ends[0].aborted).toBe(false);
		expect(ends[0].result, "auto-compaction ended WITHOUT a result (silent bail)").toBeDefined();

		const messages = session.messages;
		expect(messages[0]?.role).toBe("compactionSummary");
	}, 30_000);

	it("cycle 2: a SECOND threshold auto-compaction also applies (repeat compaction)", async () => {
		createSession();

		await session.prompt("hello one");
		await session.agent.waitForIdle();
		expect(compactionEnds().length).toBe(1);
		expect(compactionEnds()[0].result).toBeDefined();

		// Real-world pacing: the next turn happens later than the compaction entry.
		await sleep(10);

		await session.prompt("hello two");
		await session.agent.waitForIdle();

		const ends = compactionEnds();
		expect(
			ends.length,
			`expected a SECOND auto compaction_end, got ${ends.length}; events: ${events.map((e) => e.type).join(",")}`,
		).toBe(2);
		expect(ends[1].errorMessage).toBeUndefined();
		expect(ends[1].result, "second auto-compaction ended WITHOUT a result (silent bail)").toBeDefined();

		const messages = session.messages;
		expect(messages[0]?.role).toBe("compactionSummary");
	}, 30_000);

	it("same-millisecond turn after compaction is not silently skipped forever", async () => {
		createSession();

		await session.prompt("hello one");
		await session.agent.waitForIdle();
		expect(compactionEnds().length).toBe(1);

		// NO sleep: next turn lands in (or before) the same millisecond bucket as the
		// compaction entry timestamp. The skip-guard must not lock auto-compaction out.
		await session.prompt("hello two");
		await session.agent.waitForIdle();
		await session.prompt("hello three");
		await session.agent.waitForIdle();

		const ends = compactionEnds();
		expect(
			ends.length,
			`auto-compaction never fired again after the first one; events: ${events.map((e) => e.type).join(",")}`,
		).toBeGreaterThanOrEqual(2);
	}, 30_000);
});

describe("auto-compaction never fails silently", () => {
	let session: AgentSession;
	let tempDir: string;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-autocompact-silent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("a no-op auto-compaction (nothing to compact) carries a reason on compaction_end", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: assistantReply("x", 10) } as AssistantMessageEvent);
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		session.subscribe((event) => {
			events.push(event);
		});

		// Fresh session: prepareCompaction() has nothing to work with -> historical behavior
		// was a compaction_end with result undefined AND no reason at all (invisible in the UI).
		type SessionWithAutoCompaction = { _runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean> };
		await (session as unknown as SessionWithAutoCompaction)._runAutoCompaction("threshold", false);

		const ends = events.filter((e) => e.type === "compaction_end") as Array<
			Extract<AgentSessionEvent, { type: "compaction_end" }>
		>;
		expect(ends.length).toBe(1);
		expect(ends[0].result).toBeUndefined();
		const reason = (ends[0] as { skipReason?: string }).skipReason ?? ends[0].errorMessage;
		expect(reason, "no-op compaction_end must carry skipReason or errorMessage — silent bail").toBeTruthy();
	}, 15_000);

	it("compaction selection falls back from exhausted explicit and cheap models with visible reasons", () => {
		const explicit = compactionSupportFixture({ compactionModel: "test/cheap", exhausted: ["test/cheap"] });
		expect(explicit.support.resolveModel(explicit.sessionModel)).toBe(explicit.sessionModel);
		expect(explicit.warnings).toContain("Compaction summarizer fallback:exhausted");

		const cheap = compactionSupportFixture({
			routerEnabled: true,
			cheapModel: "test/cheap",
			exhausted: ["test/cheap"],
		});
		expect(cheap.support.resolveModel(cheap.sessionModel)).toBe(cheap.sessionModel);
		expect(cheap.warnings).toContain("Compaction summarizer fallback:exhausted");
	});

	it("compaction selection applies the digest gate subtractively to router cheap", () => {
		const failed = compactionSupportFixture({
			routerEnabled: true,
			cheapModel: "test/cheap",
			fitness: { "test/cheap": report({ digest: lane(1, 3), research: lane(3, 3), toolCall: lane(3, 3) }) },
		});
		expect(failed.support.resolveModel(failed.sessionModel)).toBe(failed.sessionModel);
		expect(failed.warnings).toContain("Compaction summarizer fallback:digest_unfit(1/3)");

		const unprobed = compactionSupportFixture({ routerEnabled: true, cheapModel: "test/cheap" });
		expect(unprobed.support.resolveModel(unprobed.sessionModel)).toBe(unprobed.cheapModel);
		expect(unprobed.warnings).toEqual([]);

		const passed = compactionSupportFixture({
			routerEnabled: true,
			cheapModel: "test/cheap",
			fitness: { "test/cheap": report({ digest: lane(3, 3) }) },
		});
		expect(passed.support.resolveModel(passed.sessionModel)).toBe(passed.cheapModel);
		expect(passed.warnings).toEqual([]);
	});

	it("gate-redirected compaction selection uses session thinking, not router cheap thinking", () => {
		const fixture = compactionSupportFixture({
			routerEnabled: true,
			cheapModel: "test/cheap",
			cheapThinking: "minimal",
			fitness: { "test/cheap": report({ digest: lane(1, 3) }) },
		});
		const selected = fixture.support.resolveModel(fixture.sessionModel);
		expect(selected).toBe(fixture.sessionModel);
		expect(fixture.support.resolveThinkingLevel("high", selected, fixture.sessionModel)).toBe("low");
	});

	it("raw-stream auth resolution falls back to the session model before failing", async () => {
		const tried: string[] = [];
		const fakeRegistry = {
			getApiKeyAndHeaders: async (m: { id: string }) => {
				tried.push(m.id);
				if (m.id === "cheap-model") return { ok: false as const };
				return { ok: true as const, apiKey: "session-key", headers: { h: "1" } };
			},
		};
		const support = new CompactionSupport({
			getModel: () => undefined,
			getSettingsManager: () => {
				throw new Error("not needed for auth resolution");
			},
			getModelRegistry: () => fakeRegistry as unknown as ReturnType<CompactionSupportDeps["getModelRegistry"]>,
			isRawStream: () => true,
			getRequiredRequestAuth: async () => ({}),
			isModelExhausted: () => false,
			getStoredFitnessReport: () => undefined,
			estimateSummarizationInputTokens: () => 1_000,
			emitWarning: () => {},
		});

		type ModelArg = Parameters<CompactionSupport["resolveModelAndAuth"]>[0];
		const res = await support.resolveModelAndAuth(
			{ id: "cheap-model" } as ModelArg,
			{ id: "session-model" } as ModelArg,
		);
		expect(tried).toEqual(["cheap-model", "session-model"]);
		expect(res.model.id).toBe("session-model");
		expect(res.apiKey).toBe("session-key");
		expect(res.failure).toBeUndefined();
	});
});
