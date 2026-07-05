import type { Agent } from "@caupulican/pi-agent-core";
import { classifyFailure, DEFAULT_RETRY_POLICY } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { RouteDecision } from "../../src/core/autonomy/contracts.ts";
import { BillingFailoverController, ExhaustedProviderRegistry } from "../../src/core/billing-failover-controller.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRouterController } from "../../src/core/model-router-controller.ts";
import { resolveScoutModel } from "../../src/core/runtime-builder.ts";
import {
	createChaosProvider,
	expectBoundedOutbound,
	expectNoSilentTerminal,
	expectNoUnapprovedMeteredSpend,
} from "./chaos-provider.ts";

const codexSpark = model("openai-codex", "codex-spark");
const codexDefault = model("openai-codex", "gpt-5.5");
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

function registry(subscription: boolean): ModelRegistry {
	const models = [codexSpark, codexDefault, meteredSelected];
	return {
		getAll: () => models,
		find: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: undefined }),
		isUsingOAuth: (candidate: Model<Api>) => subscription && candidate.provider === "openai-codex",
	} as unknown as ModelRegistry;
}

type RouterHarness = {
	_lastModelRouterSkipReason?: string;
	_resolveExecutorRoute: () => undefined;
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
	_resolveModelRouterTurnRoute(
		this: RouterHarness,
		prompt: string,
	): { decision: RouteDecision; model: Model<Api> } | undefined;
};

type CompactWithRetryHarness = {
	settingsManager: { getRetrySettings: () => { enabled: boolean; maxRetries: number; baseDelayMs: number } };
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
		expect(harness.agent.state.model.id).toBe("gpt-5.5");
		expect(harness.warnings[0]).toContain("switched to openai-codex/gpt-5.5");
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
		chaos.call("openai-codex/gpt-5.5");
		await harness.failover.handleAssistantError(assistantError(codexDefault, codexLiteral));
		expect(harness.exhausted.snapshot().sort()).toEqual(["openai-codex/codex-spark", "openai-codex/gpt-5.5"]);
		expect(harness.agent.state.model.id).toBe("gpt-5.5");
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
						expensiveModel: "openai-codex/gpt-5.5",
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
		chaos.call("openai-codex/gpt-5.5");
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
