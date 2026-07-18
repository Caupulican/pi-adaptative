/**
 * Compaction's summarizer must pass the SAME readiness/residency gate every other isolated
 * consumer uses (LocalRuntimeController.ensureIsolatedModelReady) before compact() calls a
 * managed-local (Ollama) model — for BOTH auto-compaction and manual /compact. Before this fix
 * agent-session.ts called compact() with a router-selected local cheapModel without ever checking
 * whether its server was up, installed, or resident.
 *
 * Two levels of coverage:
 *  - Unit level: CompactionSupport.resolveModelAndAuth (compaction-support.ts) with a fake
 *    ensureModelReady dep, pinning the exact gating/fallback semantics for both the raw-stream and
 *    custom-streamFn branches.
 *  - Integration level: a real AgentSession (mirrors test/auto-compaction-apply.test.ts's offline
 *    pipeline style) with a REAL LocalRuntimeController wired to a faked Ollama HTTP surface,
 *    proving the not-ready local model is never actually called (no bypass) and the ready one is.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
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
import type { LocalRuntimeDeps } from "../src/core/models/local-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const OLLAMA_MODEL_ID = "qwen3:0.6b";

// ---------------------------------------------------------------------------
// Unit level: CompactionSupport.resolveModelAndAuth
// ---------------------------------------------------------------------------

function fauxModel(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function supportWithReadinessDep(
	isRawStream: boolean,
	options: {
		authOk?: Set<string>;
		notReady?: Set<string>;
	} = {},
): { support: CompactionSupport; readinessCalls: string[] } {
	const authOk = options.authOk ?? new Set(["cheap", "session"]);
	const notReady = options.notReady ?? new Set();
	const readinessCalls: string[] = [];
	const registry = {
		getApiKeyAndHeaders: async (model: Model<any>) =>
			authOk.has(model.id) ? { ok: true as const, apiKey: `${model.id}-key` } : { ok: false as const },
	} as unknown as ModelRegistry;
	const deps: CompactionSupportDeps = {
		getModel: () => undefined,
		getSettingsManager: () => {
			throw new Error("not needed for resolveModelAndAuth");
		},
		getModelRegistry: () => registry,
		isRawStream: () => isRawStream,
		getRequiredRequestAuth: async () => ({}),
		isModelExhausted: () => false,
		getStoredFitnessReport: () => undefined,
		estimateSummarizationInputTokens: () => 1_000,
		emitWarning: () => {},
		ensureModelReady: async (model) => {
			readinessCalls.push(model.id);
			if (notReady.has(model.id)) {
				throw new Error(`Managed local model ${model.provider}/${model.id} is unavailable (server_down)`);
			}
		},
	};
	return { support: new CompactionSupport(deps), readinessCalls };
}

describe("CompactionSupport.resolveModelAndAuth honors the readiness gate", () => {
	it("raw-stream: a not-ready local cheap model is checked (never bypassed) and falls back to the session model", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(true, { notReady: new Set(["cheap"]) });
		const result = await support.resolveModelAndAuth(fauxModel("ollama", "cheap"), fauxModel("anthropic", "session"));

		expect(readinessCalls).toContain("cheap");
		expect(result.model.id).toBe("session");
		expect(result.apiKey).toBe("session-key");
		expect(result.failure).toBeUndefined();
	});

	it("raw-stream: a ready local cheap model passes the gate and is used directly", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(true);
		const result = await support.resolveModelAndAuth(fauxModel("ollama", "cheap"), fauxModel("anthropic", "session"));

		expect(readinessCalls).toContain("cheap");
		expect(result.model.id).toBe("cheap");
		expect(result.apiKey).toBe("cheap-key");
		expect(result.failure).toBeUndefined();
	});

	it("raw-stream: fails cleanly (never bypassing) when neither candidate is ready/authed", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(true, {
			authOk: new Set(["cheap", "session"]),
			notReady: new Set(["cheap", "session"]),
		});
		const result = await support.resolveModelAndAuth(fauxModel("ollama", "cheap"), fauxModel("ollama", "session"));

		expect(readinessCalls).toEqual(["cheap", "session"]);
		expect(result.failure).toBeTruthy();
		expect(result.failure).toContain("not ready");
	});

	it("raw-stream: a cloud session model resolves unaffected — the gate is checked but never blocks a non-local model", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(true);
		const result = await support.resolveModelAndAuth(
			fauxModel("anthropic", "session"),
			fauxModel("anthropic", "session"),
		);

		expect(readinessCalls).toContain("session");
		expect(result.model.id).toBe("session");
		expect(result.failure).toBeUndefined();
	});

	it("custom streamFn (CLI) path: a not-ready local model surfaces a failure instead of being handed back for use", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(false, { notReady: new Set(["cheap"]) });
		const result = await support.resolveModelAndAuth(fauxModel("ollama", "cheap"), fauxModel("anthropic", "session"));

		expect(readinessCalls).toContain("cheap");
		expect(result.failure).toBeTruthy();
		expect(result.model.id).toBe("cheap"); // caller (runCompactionLoop) treats `failure` as authoritative
	});

	it("custom streamFn (CLI) path: a ready local model resolves normally", async () => {
		const { support, readinessCalls } = supportWithReadinessDep(false);
		const result = await support.resolveModelAndAuth(fauxModel("ollama", "cheap"), fauxModel("anthropic", "session"));

		expect(readinessCalls).toContain("cheap");
		expect(result.model.id).toBe("cheap");
		expect(result.failure).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Integration level: a real AgentSession + real LocalRuntimeController against a faked Ollama
// HTTP surface (fetch/spawn faked; no real network/process). Mirrors
// test/auto-compaction-apply.test.ts's offline pipeline style.
// ---------------------------------------------------------------------------

/** A minimal fake child process matching Pick<ChildProcess, "pid"|"kill"|"unref"|"on">. */
function fakeChild(): ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>> {
	const child: { pid: number; kill: () => boolean; unref: () => void; on: () => typeof child } = {
		pid: 1,
		kill: () => true,
		unref: () => {},
		on: () => child,
	};
	return child as unknown as ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>>;
}

/** Ollama server unreachable and no binary resolves anywhere — the model can never be made ready. */
function notReadyDeps(): LocalRuntimeDeps {
	return {
		fetchFn: (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
		existsFn: () => false,
		spawnFn: fakeChild,
		sleepFn: async () => {},
	};
}

/** Ollama server already up and serving the configured model. */
function readyDeps(): LocalRuntimeDeps {
	return {
		fetchFn: (async (url: string) => {
			if (String(url).endsWith("/api/tags")) {
				return Response.json({ models: [{ name: OLLAMA_MODEL_ID, size: 1_000 }] });
			}
			if (String(url).endsWith("/api/ps")) return Response.json({ models: [] });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch,
		existsFn: () => true,
		spawnFn: fakeChild,
		sleepFn: async () => {},
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

function assistantReply(provider: string, modelId: string, text: string, inputTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider,
		model: modelId,
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

describe("AgentSession compaction honors local-model readiness (offline pipeline)", () => {
	let session: AgentSession;
	let tempDir: string;
	let events: AgentSessionEvent[];
	let ollamaCallCount: number;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];
		ollamaCallCount = 0;
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession(localRuntimeDeps: LocalRuntimeDeps, tripAutoCompactionThreshold: boolean) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const contextWindow = model.contextWindow ?? 200_000;
		const hugeUsage = Math.floor(contextWindow * 0.9);
		const smallUsage = 200;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (streamModel) => {
				const stream = new MockAssistantStream();
				if (streamModel.provider === "ollama") ollamaCallCount++;
				const compacting = session?.isCompacting === true;
				queueMicrotask(() => {
					const message = compacting
						? assistantReply(
								streamModel.provider,
								streamModel.id,
								streamModel.provider === "ollama"
									? "## Summary\n- local summarizer used"
									: "## Summary\n- prior conversation summarized",
								500,
							)
						: assistantReply(
								streamModel.provider,
								streamModel.id,
								"reply",
								tripAutoCompactionThreshold ? hugeUsage : smallUsage,
							);
					stream.push({ type: "done", reason: "stop", message } as AssistantMessageEvent);
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Target compaction's OWN summarizer selection directly via the explicit `compaction.model`
		// setting (compaction-support.ts's getExplicitCompactionModelSetting), NOT the foreground
		// `modelRouter` — enabling that would also reroute ordinary conversational turns and
		// conflate two different gates in this test.
		settingsManager.applyOverrides({
			compaction: { keepRecentTokens: 1, model: `ollama/${OLLAMA_MODEL_ID}` },
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage);
		// Register the router's cheap model as a real (fake-served) local Ollama entry, the same
		// way `/models add` registers a discovered local model — so resolveCliModel finds it.
		modelRegistry.registerProvider("ollama", {
			baseUrl: "http://127.0.0.1:11434/v1",
			apiKey: "ollama",
			api: "openai-completions",
			models: [
				{
					id: OLLAMA_MODEL_ID,
					name: OLLAMA_MODEL_ID,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 2048,
				},
			],
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			localRuntimeDeps,
		});
		session.subscribe((event) => events.push(event));
		return session;
	}

	function compactionEnds() {
		return events.filter((e) => e.type === "compaction_end") as Array<
			Extract<AgentSessionEvent, { type: "compaction_end" }>
		>;
	}

	it("auto-compaction: a not-ready local cheapModel is never called — falls back to the session model instead of bypassing readiness", async () => {
		createSession(notReadyDeps(), true);

		await session.prompt("hello one");
		await session.agent.waitForIdle();

		const ends = compactionEnds();
		expect(ends.length, `events: ${events.map((e) => e.type).join(",")}`).toBe(1);
		expect(ends[0].errorMessage).toBeUndefined();
		expect(ends[0].result, "auto-compaction ended WITHOUT a result (silent bail)").toBeDefined();
		// The core assertion: the not-ready local model's stream must never actually be invoked —
		// compaction either makes it ready first or routes around it via the existing fallback ladder,
		// but it never bypasses the gate and calls it anyway.
		expect(ollamaCallCount, "the not-ready local model must never actually be called").toBe(0);
	}, 30_000);

	it("auto-compaction: a ready local cheapModel passes the gate and is actually used as the summarizer", async () => {
		createSession(readyDeps(), true);

		await session.prompt("hello one");
		await session.agent.waitForIdle();

		const ends = compactionEnds();
		expect(ends.length, `events: ${events.map((e) => e.type).join(",")}`).toBe(1);
		expect(ends[0].errorMessage).toBeUndefined();
		expect(ends[0].result, "auto-compaction ended WITHOUT a result (silent bail)").toBeDefined();
		// The gate isn't overly strict either: once the local model IS ready, it is actually used.
		expect(ollamaCallCount, "the ready local model should be used, not skipped").toBeGreaterThan(0);
	}, 30_000);

	it("manual /compact: a not-ready local cheapModel is never called either — same gate as auto-compaction", async () => {
		createSession(notReadyDeps(), false);

		await session.prompt("hello one");
		await session.agent.waitForIdle();
		await session.prompt("hello two");
		await session.agent.waitForIdle();
		expect(compactionEnds().length, "auto-compaction must not have fired on its own").toBe(0);

		const result = await session.compact();

		expect(result.summary, "manual compact() must still produce a result via the fallback ladder").toBeTruthy();
		expect(ollamaCallCount, "the not-ready local model must never actually be called").toBe(0);
	}, 30_000);
});
