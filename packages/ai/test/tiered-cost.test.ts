import { describe, expect, it } from "vitest";
import { calculateCost, getModel } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";

describe("P2l: calculateCost multi-tiered pricing", () => {
	const baseModel: Model<"openai-completions"> = {
		id: "tiered-model",
		name: "Tiered Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 3.0,
			output: 15.0,
			cacheRead: 0.75,
			cacheWrite: 3.0,
			tiers: [
				{
					inputTokensAbove: 200_000,
					input: 6.0,
					output: 30.0,
					cacheRead: 1.5,
					cacheWrite: 6.0,
				},
				{
					inputTokensAbove: 500_000,
					input: 12.0,
					output: 60.0,
					cacheRead: 3.0,
					cacheWrite: 12.0,
				},
			],
		},
		contextWindow: 1_000_000,
		maxTokens: 4096,
	};

	it("uses base pricing when input tokens are below the first tier", () => {
		const usage: Usage = {
			input: 100_000,
			output: 10_000,
			cacheRead: 50_000,
			cacheWrite: 0,
			totalTokens: 160_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const cost = calculateCost(baseModel, usage);
		// Input: 100k * 3/1M = 0.30
		// Output: 10k * 15/1M = 0.15
		// CacheRead: 50k * 0.75/1M = 0.0375
		// Total = 0.4875
		expect(cost.input).toBeCloseTo(0.3);
		expect(cost.output).toBeCloseTo(0.15);
		expect(cost.cacheRead).toBeCloseTo(0.0375);
		expect(cost.total).toBeCloseTo(0.4875);
	});

	it("applies the matching tier request-wide when total input tokens exceed tier threshold", () => {
		const usage: Usage = {
			input: 250_000,
			output: 10_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 260_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const cost = calculateCost(baseModel, usage);
		// 250k > 200k (tier 1): input = 6.0, output = 30.0
		// Input: 250k * 6/1M = 1.50
		// Output: 10k * 30/1M = 0.30
		// Total = 1.80
		expect(cost.input).toBeCloseTo(1.5);
		expect(cost.output).toBeCloseTo(0.3);
		expect(cost.total).toBeCloseTo(1.8);
	});

	it("applies the highest matching tier when multiple thresholds are exceeded", () => {
		const usage: Usage = {
			input: 600_000,
			output: 10_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 610_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const cost = calculateCost(baseModel, usage);
		// 600k > 500k (tier 2): input = 12.0, output = 60.0
		// Input: 600k * 12/1M = 7.20
		// Output: 10k * 60/1M = 0.60
		// Total = 7.80
		expect(cost.input).toBeCloseTo(7.2);
		expect(cost.output).toBeCloseTo(0.6);
		expect(cost.total).toBeCloseTo(7.8);
	});

	describe("E5: catalog entries carry the models.dev context tier", () => {
		// gpt-5.6 ships with the 272k context tier from models.dev and no legacy longContextPricing:
		// the tier path prices it request-wide above the threshold and the legacy multiplier never runs.
		const gpt56 = getModel("openai", "gpt-5.6");

		it("carries the single 272k tier and no legacy multiplier", () => {
			expect(gpt56.longContextPricing).toBeUndefined();
			expect(gpt56.cost.tiers).toEqual([
				{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
			]);
		});

		it("prices a below-threshold request at the base rate", () => {
			const usage: Usage = {
				input: 100_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const cost = calculateCost(gpt56, usage);
			expect(cost.input).toBeCloseTo(0.4); // 100k * 4/1e6
			expect(cost.output).toBeCloseTo(0.2); // 10k * 20/1e6
			expect(cost.cacheRead).toBe(0);
			expect(cost.cacheWrite).toBe(0);
			expect(cost.total).toBeCloseTo(0.6);
		});

		it("prices an above-threshold request at the tier rate for the whole request", () => {
			const usage: Usage = {
				input: 300_000,
				output: 20_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 320_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const cost = calculateCost(gpt56, usage);
			// Total input 300k > 272k: input 300k*8/1e6, output 20k*30/1e6.
			expect(cost.input).toBeCloseTo(2.4);
			expect(cost.output).toBeCloseTo(0.6);
			expect(cost.total).toBeCloseTo(3.0);
		});
	});

	describe("E5: cost.tiers vs legacy longContextPricing precedence decision", () => {
		// Decision: when a model configures BOTH, tiers take precedence outright and
		// longContextPricing is skipped entirely — they do not compose. `tiers` is documented as
		// longContextPricing's generalization (a single threshold is its degenerate case), so
		// running the legacy multiplier on top of tier-adjusted rates would double-count the same
		// "large request" signal. See the comment in `calculateCost` (models.ts) for the rationale.
		// No shipped catalog model currently sets both fields, so this is a forward-looking guard.
		it("applies only the matching tier, ignoring a legacy longContextPricing also present on the model", () => {
			const modelWithBoth: Model<"openai-completions"> = {
				...baseModel,
				id: "tiered-model-with-legacy-longcontext",
				longContextPricing: { thresholdTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 },
			};
			const usage: Usage = {
				input: 250_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 260_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			const cost = calculateCost(modelWithBoth, usage);

			// Tier 1 (inputTokensAbove 200_000): input=6.0, output=30.0 — NOT further multiplied by
			// the legacy 2x/1.5x, which would otherwise give input=3.0/output=0.45 if composed.
			expect(cost.input).toBeCloseTo(1.5);
			expect(cost.output).toBeCloseTo(0.3);
			expect(cost.total).toBeCloseTo(1.8);
		});
	});
});
