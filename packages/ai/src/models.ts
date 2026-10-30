import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model } from "./types.ts";

export {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isModelServiceTierAdvertised,
	resolveModelThinkingLevel,
} from "./model-capabilities.ts";
export { calculateCost } from "./usage.ts";

/** The catalog model, or undefined when the provider does not list that id. */
export function getModel(provider: KnownProvider, modelId: string): Model<Api> | undefined {
	const providerModels = Object.hasOwn(MODELS, provider) ? MODELS[provider] : undefined;
	return providerModels && Object.hasOwn(providerModels, modelId) ? providerModels[modelId] : undefined;
}

export function getProviders(): KnownProvider[] {
	return Object.keys(MODELS) as KnownProvider[];
}

export function getModels(provider: KnownProvider): Model<Api>[] {
	const providerModels = Object.hasOwn(MODELS, provider) ? MODELS[provider] : undefined;
	return providerModels ? Object.values(providerModels) : [];
}

/** Resolve a catalog price without inventing rates for an unknown model or an aggregate report. */
export function resolveCatalogPricing(provider: string, modelId: string): Model<Api> | undefined {
	if (provider === "google-antigravity") {
		const upstream = modelId.startsWith("gemini-")
			? "google"
			: modelId.startsWith("claude-")
				? "anthropic"
				: "openai";
		return getModel(upstream, modelId) ?? getModel(upstream, modelId.replace(/-(?:low|medium|high)$/, ""));
	}
	if (!Object.hasOwn(MODELS, provider)) return undefined;
	return getModel(provider as KnownProvider, modelId);
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
