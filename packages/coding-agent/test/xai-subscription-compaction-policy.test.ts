import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { CompactionSupport, type CompactionSupportDeps } from "../src/core/compaction-support.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function xaiModel(subscription: boolean): Model<"openai-responses"> {
	return {
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-responses",
		provider: "xai",
		baseUrl: subscription ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 32_000,
		...(subscription ? { compat: { requestFormat: "xai-cli" as const, supportsLongCacheRetention: false } } : {}),
	};
}

function supportFor(model: Model<Api>, settingsManager: SettingsManager): CompactionSupport {
	const deps: CompactionSupportDeps = {
		getModel: () => model,
		getSettingsManager: () => settingsManager,
		getModelRegistry: () => ({}) as ModelRegistry,
		isRawStream: () => false,
		getRequiredRequestAuth: async () => ({}),
		isModelExhausted: () => false,
		getStoredFitnessReport: () => undefined,
		estimateSummarizationInputTokens: () => 1_000,
		emitWarning: () => {},
		ensureModelReady: async () => {},
	};
	return new CompactionSupport(deps);
}

describe("xAI subscription compaction policy", () => {
	it("uses the installed CLI's 80% session-replacement policy", () => {
		const subscriptionModel = xaiModel(true);
		const support = supportFor(subscriptionModel, SettingsManager.inMemory());

		const settings = support.getAdaptedSettings();

		expect(settings.triggerPercent).toBe(0.8);
		expect(settings.strategy).toBe("session-replacement");
		expect(support.resolveModel(subscriptionModel)).toBe(subscriptionModel);
		expect(support.getLastSelectionReason()).toBe("session_replacement");
	});

	it("preserves an explicit trigger override for the subscription strategy", () => {
		const settingsManager = SettingsManager.inMemory({ compaction: { triggerPercent: 0.7 } });
		const support = supportFor(xaiModel(true), settingsManager);

		const settings = support.getAdaptedSettings();

		expect(settings.triggerPercent).toBe(0.7);
		expect(settings.strategy).toBe("session-replacement");
	});

	it("leaves xAI API-key models on the provider-neutral policy", () => {
		const support = supportFor(xaiModel(false), SettingsManager.inMemory());

		const settings = support.getAdaptedSettings();

		expect(settings.triggerPercent).toBe(0.6);
		expect(settings.strategy).toBeUndefined();
	});
});
