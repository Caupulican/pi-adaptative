import { describe, expect, it } from "vitest";
import { downgradeReasoning, estimateTurnCostUsd, evaluateCostGuard } from "../src/core/cost-guard.ts";

/**
 * Proactive per-turn cost guard (Hermes-parity superiority #34): estimate the turn's USD cost before
 * submitting, and trip a warn/downgrade decision over a user ceiling. Disabled by default.
 */
describe("estimateTurnCostUsd", () => {
	// Model costs are dollars per million tokens (e.g. $3/M input, $15/M output, $0.30/M cache-read).
	const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

	it("bills full input + max output", () => {
		const usd = estimateTurnCostUsd({ inputTokens: 100_000, maxOutputTokens: 4_000, cost });
		expect(usd).toBeCloseTo(100_000 * 3e-6 + 4_000 * 15e-6, 9); // 0.30 + 0.06 = 0.36
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
		// 10k fresh @ 3e-6 + 90k cached @ 0.3e-6 = 0.03 + 0.027 = 0.057
		expect(usd).toBeCloseTo(0.057, 9);
	});

	it("clamps cached tokens to the input total", () => {
		const usd = estimateTurnCostUsd({ inputTokens: 1_000, cachedInputTokens: 999_999, maxOutputTokens: 0, cost });
		expect(usd).toBeCloseTo(1_000 * 0.3e-6, 12); // all treated as cached, none negative
	});
});

describe("evaluateCostGuard", () => {
	it("is never over when disabled (maxTurnUsd <= 0)", () => {
		expect(evaluateCostGuard(999, { maxTurnUsd: 0, action: "warn" }).over).toBe(false);
	});

	it("trips only above the ceiling", () => {
		const s = { maxTurnUsd: 1.5, action: "downgrade" as const };
		expect(evaluateCostGuard(1.49, s).over).toBe(false);
		expect(evaluateCostGuard(1.51, s).over).toBe(true);
		expect(evaluateCostGuard(1.51, s).action).toBe("downgrade");
	});
});

describe("downgradeReasoning", () => {
	it("steps one level down the cost ladder", () => {
		expect(downgradeReasoning("high")).toBe("medium");
		expect(downgradeReasoning("medium")).toBe("low");
		expect(downgradeReasoning("xhigh")).toBe("high");
	});

	it("floors at off and never raises", () => {
		expect(downgradeReasoning("off")).toBe("off");
	});

	it("leaves an unrecognized level unchanged", () => {
		expect(downgradeReasoning("turbo")).toBe("turbo");
	});
});
