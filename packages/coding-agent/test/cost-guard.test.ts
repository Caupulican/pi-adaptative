import { describe, expect, it } from "vitest";
import {
	DEFAULT_COST_GUARD_SETTINGS,
	downgradeReasoning,
	estimateTurnCostUsd,
	evaluateCostGuard,
} from "../src/core/cost-guard.ts";

/**
 * Proactive per-turn cost guard (Hermes-parity superiority #34): estimate the turn's USD cost before
 * submitting, and trip a warn/downgrade decision over a user projection threshold.
 */
describe("estimateTurnCostUsd", () => {
	// Model costs are dollars per million tokens (e.g. $3/M input, $15/M output, $0.30/M cache-read).
	const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

	it("bills full input + max output", () => {
		const usd = estimateTurnCostUsd({ inputTokens: 100_000, maxOutputTokens: 4_000, cost });
		expect(usd).toBeCloseTo(100_000 * 3.75e-6 + 4_000 * 15e-6, 9); // 0.375 + 0.06 = 0.435
	});

	it("does not inflate per-million model costs into per-token costs", () => {
		const usd = estimateTurnCostUsd({
			inputTokens: 272_000,
			maxOutputTokens: 128_000,
			cost: { input: 15, output: 120 },
		});

		expect(usd).toBeCloseTo(19.44, 9);
	});

	it("bills cached input at the cache-read rate", () => {
		const usd = estimateTurnCostUsd({ inputTokens: 100_000, cachedInputTokens: 90_000, maxOutputTokens: 0, cost });
		// 10K fresh may write @ 3.75e-6; 90K cached reads @ 0.3e-6. Each token is charged once.
		expect(usd).toBeCloseTo(0.0645, 9);
	});

	it("clamps cached tokens to the input total", () => {
		const usd = estimateTurnCostUsd({ inputTokens: 1_000, cachedInputTokens: 999_999, maxOutputTokens: 0, cost });
		expect(usd).toBeCloseTo(1_000 * 0.3e-6, 12); // all treated as cached, none negative
	});

	it("applies full-request long-context multipliers above the model threshold", () => {
		const usd = estimateTurnCostUsd({
			inputTokens: 300_000,
			cachedInputTokens: 50_000,
			maxOutputTokens: 1_000,
			cost: { input: 5, output: 30, cacheRead: 0.5 },
			longContextPricing: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
		});

		expect(usd).toBeCloseTo(2.595, 9);
	});

	it("projects a 300K GPT-5.6 Sol cache miss at the possible write rate without double-counting", () => {
		const usd = estimateTurnCostUsd({
			inputTokens: 300_000,
			maxOutputTokens: 0,
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			longContextPricing: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
		});

		// 300K fresh tokens are charged once at the possible $6.25/M write rate, then the
		// GPT-5.6 long-context input multiplier applies: 300K * $6.25/M * 2 = $3.75.
		expect(usd).toBeCloseTo(3.75, 9);
	});
});

describe("evaluateCostGuard", () => {
	it("exports the same warning-only default used by SettingsManager", () => {
		expect(DEFAULT_COST_GUARD_SETTINGS).toEqual({ maxTurnUsd: 2.5, action: "warn" });
	});

	it("is never over when disabled (maxTurnUsd <= 0)", () => {
		expect(evaluateCostGuard(999, { maxTurnUsd: 0, action: "warn" }).over).toBe(false);
	});

	it("trips only above the projection threshold", () => {
		const s = { maxTurnUsd: 1.5, action: "downgrade" as const };
		expect(evaluateCostGuard(1.49, s).over).toBe(false);
		expect(evaluateCostGuard(1.51, s).over).toBe(true);
		expect(evaluateCostGuard(1.51, s).action).toBe("downgrade");
	});
});

describe("downgradeReasoning", () => {
	it("steps one level down the cost ladder", () => {
		expect(downgradeReasoning("ultra")).toBe("max");
		expect(downgradeReasoning("max")).toBe("xhigh");
		expect(downgradeReasoning("xhigh")).toBe("high");
		expect(downgradeReasoning("high")).toBe("medium");
		expect(downgradeReasoning("medium")).toBe("low");
	});

	it("floors at off and never raises", () => {
		expect(downgradeReasoning("off")).toBe("off");
	});

	it("skips unsupported cheaper levels instead of relying on an upward provider clamp", () => {
		expect(downgradeReasoning("low", ["off", "low", "medium", "high", "xhigh", "max", "ultra"])).toBe("off");
		expect(downgradeReasoning("low", ["low", "medium", "high", "xhigh", "max", "ultra"])).toBe("low");
	});

	it("skips cheaper labels that map to the same provider effort", () => {
		const supported = ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
		expect(downgradeReasoning("ultra", supported, { ultra: "max", max: "max", xhigh: "xhigh" })).toBe("xhigh");
	});

	it("leaves an unrecognized level unchanged", () => {
		expect(downgradeReasoning("turbo")).toBe("turbo");
	});
});
