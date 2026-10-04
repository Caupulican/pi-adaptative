import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model } from "./types.ts";

export {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isModelServiceTierAdvertised,
	resolveModelThinkingLevel,
} from "./model-capabilities.ts";
export { calculateCost } from "./usage.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	modelRegistry.set(provider, new Map(Object.entries(models)));
}

/** The catalog model, or undefined when the provider does not list that id. */
export function getModel(provider: KnownProvider, modelId: string): Model<Api> | undefined {
	return modelRegistry.get(provider)?.get(modelId);
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels(provider: KnownProvider): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? Array.from(models.values()) : [];
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
