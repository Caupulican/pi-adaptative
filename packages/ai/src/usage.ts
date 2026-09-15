import type { Api, Model, Usage } from "./types.ts";

export function calculateCost<TApi extends Api>(
	model: Model<TApi>,
	usage: Usage,
	options: { providerSuppliedTotal?: boolean } = {},
): Usage["cost"] {
	const totalInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;

	// Multi-tiered pricing (highest matching threshold wins for entire request) takes precedence
	// over the legacy single-threshold `longContextPricing` when a model configures both: `tiers`
	// is documented as `longContextPricing`'s generalization (a single threshold is its degenerate
	// case), so applying the legacy multiplier ON TOP of tier-adjusted rates would double-count the
	// same "large request" signal. No shipped catalog model currently sets both fields.
	const hasTiers = !!model.cost.tiers && model.cost.tiers.length > 0;
	let effectiveCost = model.cost;
	if (hasTiers) {
		const matchingTiers = model.cost
			.tiers!.filter((tier) => totalInputTokens > tier.inputTokensAbove)
			.sort((a, b) => b.inputTokensAbove - a.inputTokensAbove);
		if (matchingTiers.length > 0) {
			const activeTier = matchingTiers[0];
			effectiveCost = {
				input: activeTier.input ?? model.cost.input,
				output: activeTier.output ?? model.cost.output,
				cacheRead: activeTier.cacheRead ?? model.cost.cacheRead,
				cacheWrite: activeTier.cacheWrite ?? model.cost.cacheWrite,
			};
		}
	}

	usage.cost.input = (effectiveCost.input / 1000000) * usage.input;
	usage.cost.output = (effectiveCost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (effectiveCost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (effectiveCost.cacheWrite / 1000000) * usage.cacheWrite;

	// Legacy single-threshold longContextPricing (degenerate case) only applies when the model has
	// no tiers configured — see the precedence note above.
	const longContextPricing = model.longContextPricing;
	if (!hasTiers && longContextPricing && totalInputTokens > longContextPricing.thresholdTokens) {
		usage.cost.input *= longContextPricing.inputMultiplier;
		usage.cost.cacheRead *= longContextPricing.inputMultiplier;
		usage.cost.cacheWrite *= longContextPricing.inputMultiplier;
		usage.cost.output *= longContextPricing.outputMultiplier;
	}

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
