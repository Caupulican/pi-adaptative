import { describe, expect, it } from "vitest";
import {
	type CompactionEconomicsInput,
	planIdlePreparation,
	priceCompaction,
	switchCostUsd,
} from "../src/core/compaction/early-compaction-economics.ts";

// deepseek-v4-flash catalog prices (USD per million tokens).
const PRICES = { cacheReadUsdPerMillion: 0.0177212, coldUsdPerMillion: 0.088606, outputUsdPerMillion: 0.177212 };

const BASE: CompactionEconomicsInput = {
	prefixTokens: 24_000,
	compactedTokens: 3_000,
	summaryOutputTokens: 1_300,
	remainingRequests: 4,
	retained: { retained: 0.85, standardError: 0.06 },
	summarizerSharesLane: true,
	...PRICES,
};

const usd = (tokens: number, perMillion: number) => (tokens / 1_000_000) * perMillion;

describe("early compaction price", () => {
	it("prices the summary at the output price and includes the summarizer's read of the prefix", () => {
		const verdict = priceCompaction({ ...BASE, retained: { retained: 1, standardError: 0 } });
		expect(verdict.proceed).toBe(true);
		if (!verdict.proceed) return;
		// Compact: the summarizer reads the cached prefix, writes the summary, the next request writes the
		// compacted prefix cold, and three more read it from cache.
		const expected =
			usd(24_000, PRICES.cacheReadUsdPerMillion) +
			usd(1_300, PRICES.outputUsdPerMillion) +
			usd(3_000, PRICES.coldUsdPerMillion) +
			3 * usd(3_000, PRICES.cacheReadUsdPerMillion);
		expect(verdict.compactUsd).toBeCloseTo(expected, 12);
		expect(verdict.resumeUsd).toBeCloseTo(4 * usd(24_000, PRICES.cacheReadUsdPerMillion), 12);
	});

	it("declines on a warm short gap when the summarizer would read the prefix cold on another lane", () => {
		const verdict = priceCompaction({
			...BASE,
			summarizerSharesLane: false,
			retained: { retained: 0.95, standardError: 0.02 },
			remainingRequests: 2,
		});
		expect(verdict.proceed).toBe(false);
		if (!verdict.proceed) expect(verdict.reason).toBe("insufficient_savings");
	});

	it("proceeds past the curve's knee: an expired cache makes resuming pay the prefix cold", () => {
		const verdict = priceCompaction({
			...BASE,
			summarizerSharesLane: false,
			retained: { retained: 0, standardError: 0 },
			remainingRequests: 10,
		});
		expect(verdict.proceed).toBe(true);
	});

	it("declines by the lower bound when the curve is too uncertain to rule out a warm cache", () => {
		const sure = priceCompaction({
			...BASE,
			summarizerSharesLane: false,
			retained: { retained: 0.1, standardError: 0 },
			remainingRequests: 5,
		});
		const unsure = priceCompaction({
			...BASE,
			summarizerSharesLane: false,
			retained: { retained: 0.1, standardError: 0.9 },
			remainingRequests: 5,
		});
		expect(sure.proceed).toBe(true);
		expect(unsure.proceed).toBe(false);
		// No evidence at all spans every share.
		const { retained: _unused, ...noCurve } = BASE;
		expect(priceCompaction({ ...noCurve, summarizerSharesLane: false, remainingRequests: 5 }).proceed).toBe(false);
	});

	it("has no evidence without prices", () => {
		const verdict = priceCompaction({ ...BASE, outputUsdPerMillion: undefined });
		expect(verdict).toMatchObject({ proceed: false, reason: "insufficient_evidence" });
	});
});

describe("switch cost", () => {
	it("is zero on a price-free model and scales with the tokens the destination must write", () => {
		expect(switchCostUsd({ cost: { input: 0, cacheWrite: 0 } }, 100_000)).toBe(0);
		const opus = { cost: { input: 5, cacheWrite: 6.25 } };
		expect(switchCostUsd(opus, 100_000)).toBeCloseTo(0.625, 12);
		expect(switchCostUsd(opus, 200_000)).toBeCloseTo(1.25, 12);
		// A small brief instead of the prefix costs only the brief.
		expect(switchCostUsd(opus, 100_000, 2_000)).toBeCloseTo(0.0125, 12);
		// Without a cache-write price a miss costs the input price.
		expect(switchCostUsd({ cost: { input: 0.3 } }, 1_000_000)).toBeCloseTo(0.3, 12);
		expect(switchCostUsd({}, 1_000)).toBeUndefined();
	});
});

describe("idle preparation plan", () => {
	// Anthropic-like prices: a cold prefix costs twelve times a cached one.
	const PLAN = {
		prefixTokens: 100_000,
		compactedTokens: 20_000,
		summaryOutputTokens: 1_000,
		remainingRequests: 5,
		summarizerSharesLane: true,
		cacheReadUsdPerMillion: 0.5,
		coldUsdPerMillion: 6.25,
		outputUsdPerMillion: 25,
		candidateTimesMs: [1_000, 60_000, 240_000, 600_000],
	};
	// Warm until five minutes, gone after.
	const ttlCurve = (gapMs: number) => ({ retained: gapMs < 300_000 ? 1 : 0, standardError: 0 });

	it("prepares at the last warm moment before the owner usually returns cold", () => {
		const plan = planIdlePreparation({
			...PLAN,
			retainedAt: ttlCurve,
			returnGapsMs: [900_000, 1_200_000, 1_800_000],
		});
		expect(plan?.prepareAtMs).toBe(240_000);
		expect(plan?.valueUsd).toBeGreaterThan(0);
	});

	it("plans nothing when the owner comes back while the cache is still warm", () => {
		expect(planIdlePreparation({ ...PLAN, retainedAt: ttlCurve, returnGapsMs: [30_000, 60_000] })).toBeUndefined();
	});

	it("plans nothing when the lane never loses its cache, or nothing is known about returns", () => {
		const alwaysWarm = () => ({ retained: 1, standardError: 0 });
		expect(planIdlePreparation({ ...PLAN, retainedAt: alwaysWarm, returnGapsMs: [1_800_000] })).toBeUndefined();
		expect(planIdlePreparation({ ...PLAN, retainedAt: ttlCurve, returnGapsMs: [] })).toBeUndefined();
	});

	it("plans nothing when a preparation could only read the prefix cold", () => {
		const coldFromStart = () => ({ retained: 0, standardError: 0 });
		expect(planIdlePreparation({ ...PLAN, retainedAt: coldFromStart, returnGapsMs: [1_800_000] })).toBeUndefined();
	});

	it("continuing from a prepared summary costs only the compacted prefix", () => {
		const verdict = priceCompaction({
			...PLAN,
			retained: { retained: 0, standardError: 0 },
			summaryPrepared: true,
		});
		expect(verdict.proceed).toBe(true);
		if (!verdict.proceed) return;
		expect(verdict.compactUsd).toBeCloseTo(usd(20_000, 6.25) + 4 * usd(20_000, 0.5), 12);
	});
});
