import type { Api, Model, ModelCost, ModelCostTier, Usage } from "./types.ts";

/** Zero is an authoritative reported cost; only absent/null costs use model-rate estimates. */
export function parseProviderReportedCost(value: unknown, previous?: number): number | undefined {
	const reported = value == null ? previous : value;
	if (reported === undefined) return undefined;
	if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0)
		throw new Error("Invalid provider-reported cost");
	return reported;
}

/** The same whole-request rates govern projected admission and measured usage. */
export function resolveModelCost(
	model: Pick<Model<Api>, "cost" | "longContextPricing">,
	totalInputTokens: number,
): ModelCost {
	// Multi-tiered pricing (highest matching threshold wins for entire request) takes precedence
	// over the legacy single-threshold `longContextPricing` when a model configures both: `tiers`
	// is documented as `longContextPricing`'s generalization (a single threshold is its degenerate
	// case), so applying the legacy multiplier ON TOP of tier-adjusted rates would double-count the
	// same "large request" signal. No shipped catalog model currently sets both fields.
	const hasTiers = !!model.cost.tiers && model.cost.tiers.length > 0;
	let activeTier: ModelCostTier | undefined;
	if (hasTiers) {
		for (const tier of model.cost.tiers!)
			if (
				totalInputTokens > tier.inputTokensAbove &&
				(!activeTier || tier.inputTokensAbove > activeTier.inputTokensAbove)
			)
				activeTier = tier;
	}
	const longContextPricing = model.longContextPricing;
	const useLegacy = !hasTiers && longContextPricing && totalInputTokens > longContextPricing.thresholdTokens;
	const inputMultiplier = useLegacy ? longContextPricing.inputMultiplier : 1;
	const outputMultiplier = useLegacy ? longContextPricing.outputMultiplier : 1;
	return {
		input: (activeTier?.input ?? model.cost.input) * inputMultiplier,
		output: (activeTier?.output ?? model.cost.output) * outputMultiplier,
		cacheRead: (activeTier?.cacheRead ?? model.cost.cacheRead) * inputMultiplier,
		cacheWrite: (activeTier?.cacheWrite ?? model.cost.cacheWrite) * inputMultiplier,
	};
}

export function calculateCost<TApi extends Api>(
	model: Model<TApi>,
	usage: Usage,
	options: { providerSuppliedTotal?: boolean } = {},
): Usage["cost"] {
	const effectiveCost = resolveModelCost(model, usage.input + usage.cacheRead + usage.cacheWrite);
	usage.cost.input = (effectiveCost.input / 1000000) * usage.input;
	usage.cost.output = (effectiveCost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (effectiveCost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (effectiveCost.cacheWrite / 1000000) * usage.cacheWrite;

	if (!options.providerSuppliedTotal) {
		usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	}
	return usage.cost;
}

/** Create a mutable, fully initialized usage record with no shared nested state. */
export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
