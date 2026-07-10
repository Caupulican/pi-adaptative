import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@caupulican/pi-agent-core";
import { classifyFailure, DEFAULT_RETRY_POLICY } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { RouteDecision } from "../../src/core/autonomy/contracts.ts";
import { BillingFailoverController, ExhaustedProviderRegistry } from "../../src/core/billing-failover-controller.ts";
import { CompactionSupport } from "../../src/core/compaction-support.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRouterController } from "../../src/core/model-router-controller.ts";
import { FitnessStore } from "../../src/core/models/fitness-store.ts";
import type { LaneFitnessScore, ModelFitnessReport } from "../../src/core/research/model-fitness.ts";
import { resolveScoutModel } from "../../src/core/runtime-builder.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	createChaosProvider,
	expectBoundedOutbound,
	expectNoSilentTerminal,
	expectNoUnapprovedMeteredSpend,
} from "./chaos-provider.ts";

const codexSpark = model("openai-codex", "codex-spark");
const codexDefault = model("openai-codex", "gpt-5.6-sol");
const meteredSelected = model("metered", "selected");
const codexLiteral = "You have hit your ChatGPT usage limit. Try again in 2 hours.";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "responses",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function assistantError(modelRef: Model<Api>, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
		provider: modelRef.provider,
		model: modelRef.id,
	} as unknown as AssistantMessage;
}

function registry(subscription: boolean, extraModels: Model<Api>[] = []): ModelRegistry {
	const models = [codexSpark, codexDefault, meteredSelected, ...extraModels];
	return {
		getAll: () => models,
		find: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: undefined }),
		isUsingOAuth: (candidate: Model<Api>) => subscription && candidate.provider === "openai-codex",
	} as unknown as ModelRegistry;
}

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

function compactionHarness(options: { agentDir: string; exhausted?: ExhaustedProviderRegistry }) {
	const warnings: string[] = [];
	const settings = SettingsManager.inMemory();
	settings.setModelRouterSettings({
		...settings.getModelRouterSettings(),
		enabled: true,
		cheapModel: "openai-codex/codex-spark",
	});
	const exhausted = options.exhausted ?? new ExhaustedProviderRegistry();
	return {
		support: new CompactionSupport({
			getModel: () => codexDefault,
			getSettingsManager: () => settings,
			getModelRegistry: () => registry(true),
			isRawStream: () => false,
			getRequiredRequestAuth: async () => ({}),
			isModelExhausted: (ref) => exhausted.isExhausted(ref),
			getStoredFitnessReport: (ref) =>
				FitnessStore.forAgentDir(options.agentDir)
					.getForHost()
					.find((entry) => entry.model === ref)?.report,
			// Small span: capacity never interferes with the failover behaviors under test here.
			estimateSummarizationInputTokens: () => 1_000,
			emitWarning: (message) => warnings.push(message),
		}),
		warnings,
	};
}

type RouterHarness = {
	_lastModelRouterSkipReason?: string;
	_resolveExecutorRoute: () => undefined;
	_routerSurfaceForTier?: (
		tier: "cheap" | "medium" | "expensive",
	) => "router_cheap" | "router_medium" | "router_expensive";
	_evaluateModelFitness?: (
		surface: "router_cheap" | "router_medium" | "router_expensive",
		model: Model<Api>,
	) => { fit: true; probed: boolean } | { fit: false; reason: "unprobed" | "lane_failed" };
	deps: {
		getSettingsManager: () => {
			getModelRouterSettings: () => { enabled: boolean; cheapModel: string; expensiveModel: string };
		};
		getSessionManager: () => { getEntries: () => [] };
		getAgentDir: () => string;
		getModelRegistry: () => ModelRegistry;
		isModelExhausted: (model: Model<Api>) => boolean;
		getFailoverStatus: () => { exhausted: string[]; lastNotice?: string };
	};
};

const routerPrototype = ModelRouterController.prototype as unknown as {
	_routerSurfaceForTier(tier: "cheap" | "medium" | "expensive"): "router_cheap" | "router_medium" | "router_expensive";
	_evaluateModelFitness(
		surface: "router_cheap" | "router_medium" | "router_expensive",
		model: Model<Api>,
	): { fit: true; probed: boolean } | { fit: false; reason: "unprobed" | "lane_failed" };
	_resolveModelRouterTurnRoute(
		this: RouterHarness,
		prompt: string,
	): { decision: RouteDecision; model: Model<Api> } | undefined;
};

type CompactWithRetryHarness = {
	settingsManager: { getRetrySettings: () => { enabled: boolean; maxRetries: number; baseDelayMs: number } };
	/** _compactWithRetry records every caught provider failure to the corpus before deciding on retry. */
	_failureCorpus: { record: (args: unknown) => void };
};

const agentSessionPrototype = AgentSession.prototype as unknown as {
	_compactWithRetry(
		this: CompactWithRetryHarness,
		run: () => Promise<unknown>,
		signal: AbortSignal,
		provider?: string,
	): Promise<unknown>;
};

function controller(startModel: Model<Api>, subscription: boolean, exhausted = new ExhaustedProviderRegistry()) {
	const warnings: string[] = [];
	const agent = { state: { model: startModel } } as unknown as Agent;
	const failover = new BillingFailoverController({
		agent,
		modelRegistry: registry(subscription),
		exhausted,
		emit: (event) => warnings.push(event.message),
	});
	return { agent, failover, exhausted, warnings };
}

describe("provider limit red-team matrix", () => {
	it("Quota storm, subscription provider (codex literal)", async () => {
		const chaos = createChaosProvider([{ type: "error", message: codexLiteral }, { type: "success" }]);
		const harness = controller(codexSpark, true);
		chaos.call("openai-codex/codex-spark");
		await expect(harness.failover.handleAssistantError(assistantError(codexSpark, codexLiteral))).resolves.toBe(true);
		chaos.call(`${harness.agent.state.model.provider}/${harness.agent.state.model.id}`);
		expect(harness.agent.state.model.id).toBe("gpt-5.6-sol");
		expect(harness.warnings[0]).toContain("switched to openai-codex/gpt-5.6-sol");
		expectBoundedOutbound(chaos, 2);
		expectNoSilentTerminal({ ended: true, visibleMessages: harness.warnings });
	});

	it("Quota storm, metered provider", async () => {
		const chaos = createChaosProvider([{ type: "error", message: "quota exceeded" }]);
		const harness = controller(meteredSelected, false);
		chaos.call("metered/selected");
		await expect(
			harness.failover.handleAssistantError(assistantError(meteredSelected, "quota exceeded")),
		).resolves.toBe(true);
		expect(harness.agent.state.model.id).toBe("selected");
		expect(harness.warnings[0]).toContain("switch models (/model), wait for the limit window, or re-send to retry");
		expectBoundedOutbound(chaos, 1);
		expectNoSilentTerminal({ ended: true, visibleMessages: harness.warnings });
		expectNoUnapprovedMeteredSpend(chaos, "metered/selected");
	});

	it("Quota on the hop target too", async () => {
		const chaos = createChaosProvider([
			{ type: "error", message: codexLiteral },
			{ type: "error", message: codexLiteral },
		]);
		const harness = controller(codexSpark, true);
		chaos.call("openai-codex/codex-spark");
		await harness.failover.handleAssistantError(assistantError(codexSpark, codexLiteral));
		chaos.call("openai-codex/gpt-5.6-sol");
		await harness.failover.handleAssistantError(assistantError(codexDefault, codexLiteral));
		expect(harness.exhausted.snapshot().sort()).toEqual(["openai-codex/codex-spark", "openai-codex/gpt-5.6-sol"]);
		expect(harness.agent.state.model.id).toBe("gpt-5.6-sol");
		expectBoundedOutbound(chaos, 2);
		expectNoSilentTerminal({ ended: true, visibleMessages: harness.warnings });
	});

	it("True 429 rate-limit storm (no quota phrasing)", () => {
		const chaos = createChaosProvider([
			{ type: "error", message: "429 rate limit" },
			{ type: "error", message: "429 rate limit" },
			{ type: "error", message: "429 rate limit" },
		]);
		for (let attempt = 0; attempt < DEFAULT_RETRY_POLICY.maxAttempts; attempt++)
			chaos.call("openai-codex/codex-spark");
		const classified = classifyFailure({ message: "429 rate limit", provider: "openai-codex" });
		expect(classified.reason).toBe("rate_limit");
		expect(classified.retryable).toBe(true);
		expect(classified.reason).not.toBe("billing_or_quota");
		expectBoundedOutbound(chaos, DEFAULT_RETRY_POLICY.maxAttempts);
	});

	it("A0 stored literal replayed verbatim", async () => {
		const harness = controller(codexSpark, true);
		await expect(harness.failover.handleAssistantError(assistantError(codexSpark, codexLiteral))).resolves.toBe(true);
		expect(classifyFailure({ message: codexLiteral, provider: "openai-codex" }).reason).toBe("billing_or_quota");
		expect(classifyFailure({ message: codexLiteral, provider: "openai-codex" }).retryable).toBe(false);
	});

	it("Per-provider signature fixtures (one per A1b row)", () => {
		const classified = classifyFailure({ message: codexLiteral, provider: "openai-codex" });
		expect(classified.reason).toBe("billing_or_quota");
		expect(classified.shouldFallback).toBe(true);
	});

	it("Same fixture WITHOUT provider passed", () => {
		expect(classifyFailure({ message: codexLiteral }).reason).toBe("billing_or_quota");
	});

	it("Quota mid-compaction (summarizer model)", async () => {
		const harness: CompactWithRetryHarness = {
			settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: 1 }) },
			_failureCorpus: { record: () => {} },
		};
		let surfaced = "";
		try {
			await agentSessionPrototype._compactWithRetry.call(
				harness,
				async () => {
					throw new Error(codexLiteral);
				},
				new AbortController().signal,
				"openai-codex",
			);
		} catch (error) {
			surfaced = error instanceof Error ? error.message : String(error);
		}
		expect(surfaced).toBe(codexLiteral);
		expectNoSilentTerminal({ ended: true, visibleMessages: [surfaced] });
	});

	it("Quota on a routed cheap turn", () => {
		const exhausted = new ExhaustedProviderRegistry();
		exhausted.markExhausted("openai-codex/codex-spark");
		const harness: RouterHarness = {
			_resolveExecutorRoute: () => undefined,
			deps: {
				getSettingsManager: () => ({
					getModelRouterSettings: () => ({
						enabled: true,
						cheapModel: "openai-codex/codex-spark",
						expensiveModel: "openai-codex/gpt-5.6-sol",
					}),
				}),
				getSessionManager: () => ({ getEntries: () => [] }),
				getAgentDir: () => "/tmp/pi-red-team-router",
				getModelRegistry: () => registry(true),
				isModelExhausted: (candidate) => exhausted.isExhausted(`${candidate.provider}/${candidate.id}`),
				getFailoverStatus: () => ({ exhausted: exhausted.snapshot() }),
			},
		};
		expect(routerPrototype._resolveModelRouterTurnRoute.call(harness, "Explain this code block")).toBeUndefined();
		const skipReason = harness._lastModelRouterSkipReason;
		expect(skipReason).toBe("cheap model exhausted: quota");
		if (!skipReason) throw new Error("expected router skip reason");
		expectNoSilentTerminal({ ended: true, visibleMessages: [skipReason] });
	});

	it("Compaction fires while router cheap is quota-exhausted", () => {
		const exhausted = new ExhaustedProviderRegistry();
		exhausted.markExhausted("openai-codex/codex-spark");
		const harness = compactionHarness({
			agentDir: mkdtempSync(join(tmpdir(), "pi-red-team-compaction-exhausted-")),
			exhausted,
		});
		const selected = harness.support.resolveModel(codexDefault);
		expect(selected).toBe(codexDefault);
		expect(harness.warnings).toContain("Compaction summarizer fallback:exhausted");
		expectNoSilentTerminal({ ended: true, visibleMessages: harness.warnings });
	});

	it("Digest-failed router cheap is blocked from compaction but can still route research", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-red-team-compaction-digest-"));
		FitnessStore.forAgentDir(agentDir).save(
			"openai-codex/codex-spark",
			report({ digest: lane(1, 3), research: lane(3, 3), toolCall: lane(3, 3) }),
			"2026-07-05T00:00:00.000Z",
		);
		const compaction = compactionHarness({ agentDir });
		expect(compaction.support.resolveModel(codexDefault)).toBe(codexDefault);
		expect(compaction.warnings).toContain("Compaction summarizer fallback:digest_unfit(1/3)");

		const routerHarness: RouterHarness = {
			_resolveExecutorRoute: () => undefined,
			_routerSurfaceForTier: (tier) => routerPrototype._routerSurfaceForTier.call(routerHarness, tier),
			_evaluateModelFitness: (surface, candidate) =>
				routerPrototype._evaluateModelFitness.call(routerHarness, surface, candidate),
			deps: {
				getSettingsManager: () => ({
					getModelRouterSettings: () => ({
						enabled: true,
						fitnessGate: true,
						cheapModel: "openai-codex/codex-spark",
						expensiveModel: "openai-codex/gpt-5.6-sol",
					}),
				}),
				getSessionManager: () => ({ getEntries: () => [] }),
				getAgentDir: () => agentDir,
				getModelRegistry: () => registry(true),
				isModelExhausted: () => false,
				getFailoverStatus: () => ({ exhausted: [] }),
			},
		};
		const routed = routerPrototype._resolveModelRouterTurnRoute.call(routerHarness, "Find references to this symbol");
		expect(routed?.model).toBe(codexSpark);
	});

	it("Unprobed router cheap remains eligible for compaction", () => {
		const harness = compactionHarness({ agentDir: mkdtempSync(join(tmpdir(), "pi-red-team-compaction-unprobed-")) });
		expect(harness.support.resolveModel(codexDefault)).toBe(codexSpark);
		expect(harness.warnings).toEqual([]);
	});

	it("Quota during a scout run", async () => {
		const exhausted = new ExhaustedProviderRegistry();
		exhausted.markExhausted("openai-codex/codex-spark");
		const resolved = await resolveScoutModel(
			registry(true),
			"openai-codex/codex-spark",
			"/tmp/pi-red-team-scout",
			(candidate) => exhausted.isExhausted(`${candidate.provider}/${candidate.id}`),
		);
		expect(resolved).toEqual({ failure: "openai-codex/codex-spark exhausted: quota" });
		if (!("failure" in resolved) || !resolved.failure) throw new Error("expected scout failure");
		expectNoSilentTerminal({ ended: true, visibleMessages: [resolved.failure] });
	});

	it("Auth expiry mid-turn", () => {
		const classified = classifyFailure({ message: "401 unauthorized", provider: "openai-codex" });
		expect(classified.reason).toBe("auth");
		expect(classified.retryable).toBe(false);
		expectNoSilentTerminal({ ended: true, visibleMessages: [classified.message] });
	});

	it("Failover ping-pong (A exhausted → hop B → B quota → A recovers)", async () => {
		const chaos = createChaosProvider([
			{ type: "error", message: codexLiteral },
			{ type: "error", message: codexLiteral },
		]);
		const harness = controller(codexSpark, true);
		chaos.call("openai-codex/codex-spark");
		await harness.failover.handleAssistantError(assistantError(codexSpark, codexLiteral));
		chaos.call("openai-codex/gpt-5.6-sol");
		await harness.failover.handleAssistantError(assistantError(codexDefault, codexLiteral));
		expectBoundedOutbound(chaos, 2);
		expect(harness.warnings.at(-1)).toContain("wait for the limit window");
	});

	it("Abort during failover handling", () => {
		const chaos = createChaosProvider([{ type: "mid_stream_abort", message: "aborted" }]);
		chaos.call("openai-codex/codex-spark");
		const classified = classifyFailure({ message: "aborted", aborted: true, provider: "openai-codex" });
		expect(classified.reason).toBe("aborted");
		expectBoundedOutbound(chaos, 1);
		expectNoSilentTerminal({ ended: true, visibleMessages: [classified.message] });
	});
});
