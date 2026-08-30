import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, Usage } from "./types.ts";

export { clampThinkingLevel, getSupportedThinkingLevels, resolveModelThinkingLevel } from "./model-capabilities.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

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

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
