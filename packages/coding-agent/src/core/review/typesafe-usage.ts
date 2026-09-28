import { calculateCost, createEmptyUsage, getModels, type KnownProvider, type Usage } from "@caupulican/pi-ai";

export interface TypeSafeCostProvenance {
	readonly provider: string;
	readonly model: string;
}

export interface PricedTypeSafeUsage {
	readonly usage: Usage;
	readonly costStatus: "catalog_priced" | "unpriced";
	readonly costProvenance?: TypeSafeCostProvenance;
}

/** Price one exact provider/model receipt from the generated catalog; unknown identities stay explicit. */
export function priceTypeSafeUsage(
	provider: string,
	model: string,
	tokens: { readonly input_tokens: number; readonly output_tokens: number },
): PricedTypeSafeUsage {
	const usage = createEmptyUsage();
	usage.input = tokens.input_tokens;
	usage.output = tokens.output_tokens;
	usage.totalTokens = usage.input + usage.output;
	const catalogModel = getModels(provider as KnownProvider).find((candidate) => candidate.id === model);
	if (!catalogModel) return { usage, costStatus: "unpriced" };
	calculateCost(catalogModel, usage);
	return { usage, costStatus: "catalog_priced", costProvenance: { provider, model } };
}
