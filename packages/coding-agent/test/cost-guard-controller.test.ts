import type { Api, Context, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { CostGuardSettings } from "../src/core/cost-guard.ts";
import { CostGuardController } from "../src/core/cost-guard-controller.ts";

const MODEL = {
	api: "openai-responses",
	provider: "test",
	id: "cost-controller",
	name: "Cost Controller",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} as Model<Api>;

const CONTEXT: Context = { systemPrompt: "test", messages: [], tools: [] };

describe("CostGuardController", () => {
	it("attributes only spawned spend recorded after the current turn baseline", () => {
		let spawnedCost = 5;
		const settings: CostGuardSettings = { enabled: true, maxTurnUsd: 1, action: "warn" };
		const controller = new CostGuardController({
			getSettings: () => settings,
			getCompactionReserveTokens: () => 0,
			getSpawnedUsageCost: () => spawnedCost,
			isUnmeteredSubscription: () => false,
		});

		controller.beginForegroundTurn();
		spawnedCost = 7;
		controller.resolveRequestReasoning(MODEL, CONTEXT, "high", undefined);
		expect(controller.getLastDecision()).toMatchObject({ backgroundUsd: 2, totalUsd: 2, over: true });

		controller.beginForegroundTurn();
		controller.resolveRequestReasoning(MODEL, CONTEXT, "high", undefined);
		expect(controller.getLastDecision()).toMatchObject({ backgroundUsd: 0, totalUsd: 0, over: false });
	});

	it("owns request-local downgrade and invalidates stale UI decisions", () => {
		const settings: CostGuardSettings = { enabled: true, maxTurnUsd: 0.01, action: "downgrade" };
		const controller = new CostGuardController({
			getSettings: () => settings,
			getCompactionReserveTokens: () => 1_000,
			getSpawnedUsageCost: () => 0,
			isUnmeteredSubscription: () => false,
		});

		expect(controller.resolveRequestReasoning(MODEL, CONTEXT, "high", undefined)).toBe("medium");
		expect(controller.getLastDecision()?.over).toBe(true);
		controller.invalidateDecision();
		expect(controller.getLastDecision()).toBeUndefined();
	});

	it("skips unmetered subscription requests and hides decisions when disabled", () => {
		const settings: CostGuardSettings = { enabled: true, maxTurnUsd: 0.01, action: "warn" };
		const controller = new CostGuardController({
			getSettings: () => settings,
			getCompactionReserveTokens: () => 1_000,
			getSpawnedUsageCost: () => 0,
			isUnmeteredSubscription: () => true,
		});

		expect(controller.resolveRequestReasoning(MODEL, CONTEXT, "high", undefined)).toBe("high");
		expect(controller.getLastDecision()).toBeUndefined();
		expect(controller.getEnabledMaxTurnUsd()).toBe(0.01);

		settings.enabled = false;
		expect(controller.getEnabledMaxTurnUsd()).toBeUndefined();
		expect(controller.getLastDecision()).toBeUndefined();
	});
});
