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

/**
 * A completed model call's usage whose cost the provider stack already computed (a history summary call): the catalog
 * identity decides the status, the usage stays as it was measured, and nothing is priced twice.
 */
export function priceCompletedUsage(provider: string, model: string, usage: Usage): PricedTypeSafeUsage {
	// The receipt's usage shape: the measured counts and cost, without provider-specific details.
	const measured: Usage = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
			...(usage.cost.estimate !== undefined ? { estimate: usage.cost.estimate } : {}),
		},
	};
	const catalogModel = getModels(provider as KnownProvider).find((candidate) => candidate.id === model);
	if (!catalogModel) return { usage: measured, costStatus: "unpriced" };
	return { usage: measured, costStatus: "catalog_priced", costProvenance: { provider, model } };
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
