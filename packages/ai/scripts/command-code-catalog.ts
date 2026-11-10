/**
 * Command Code's model catalogue as pi models. The service publishes the catalogue its own client lists models
 * from: which models exist, what each takes as input, its context window, output cap, reasoning efforts and
 * list price. It needs no key. The generator reads it (generate-models.ts), so the daily catalog refresh and
 * `npm run sync:command-code-models` both follow the service's list.
 *
 * Left out: a model the service's client hides from its picker, an alias of another model, and a model with no
 * list price (a price is never invented).
 */

import type { Model, ModelCost, ModelCostTier, ThinkingLevelMap } from "../src/types.ts";

export const COMMAND_CODE_PROVIDER = "command-code";
export const COMMAND_CODE_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client";
const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
/** The catalogue layout this reader understands. */
const CATALOG_SCHEMA_VERSION = 1;
/** The output cap the service's client asks for when a model declares none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
/** pi's thinking levels the route has an effort of the same name for. */
const NAMED_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

interface CatalogRates {
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost?: number;
}

interface CatalogPricing extends CatalogRates {
	/** Ordered by `maxContext`; the last tier has none and takes every larger request. */
	contextTiers?: { maxContext?: number; rates: CatalogRates }[];
}

export interface CommandCodeCatalogModel {
	id: string;
	name: string;
	hidden: boolean;
	contextWindow: number;
	maxOutputTokens: number | null;
	/** `null` when the service declares no limit on what the model takes. */
	inputModalities: string[] | null;
	reasoningEfforts: string[];
	pricing: CatalogPricing | undefined;
	/** The model family the service forwards the model to, when its catalogue names one pi knows. */
	upstream: Model<"command-code-generate">["upstream"];
}

/** The catalogue's family labels (`display.group`) that name a family pi knows; any other label names none. */
const UPSTREAM_BY_GROUP: Record<string, NonNullable<Model<"command-code-generate">["upstream"]>> = {
	OpenAI: "openai",
	Anthropic: "anthropic",
	Google: "google",
};

function readUpstream(display: unknown): CommandCodeCatalogModel["upstream"] {
	const group = isRecord(display) ? display.group : undefined;
	return typeof group === "string" && Object.hasOwn(UPSTREAM_BY_GROUP, group) ? UPSTREAM_BY_GROUP[group] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readRates(value: unknown): CatalogRates | undefined {
	if (!isRecord(value)) return undefined;
	const { inputCost, outputCost, cacheReadCost, cacheWriteCost } = value;
	if (!isRate(inputCost) || !isRate(outputCost) || !isRate(cacheReadCost)) return undefined;
	if (cacheWriteCost !== undefined && cacheWriteCost !== null && !isRate(cacheWriteCost)) return undefined;
	return { inputCost, outputCost, cacheReadCost, ...(isRate(cacheWriteCost) ? { cacheWriteCost } : {}) };
}

function readPricing(value: unknown): CatalogPricing | undefined {
	const rates = readRates(value);
	if (!rates || !isRecord(value) || value.contextTiers === undefined) return rates;
	if (!Array.isArray(value.contextTiers) || value.contextTiers.length === 0) return undefined;
	const tiers: NonNullable<CatalogPricing["contextTiers"]> = [];
	for (const [index, entry] of value.contextTiers.entries()) {
		const tierRates = isRecord(entry) ? readRates(entry.rates) : undefined;
		if (!isRecord(entry) || !tierRates) return undefined;
		const last = index === value.contextTiers.length - 1;
		// Every tier but the last is bounded, each bound past the one before it.
		if (last ? entry.maxContext !== undefined : !isCount(entry.maxContext)) return undefined;
		if (!last && (entry.maxContext as number) <= (tiers.at(-1)?.maxContext ?? 0)) return undefined;
		tiers.push({ ...(last ? {} : { maxContext: entry.maxContext as number }), rates: tierRates });
	}
	return { ...rates, contextTiers: tiers };
}

/** One catalogue entry, or the reason it cannot be read. */
function readModel(value: unknown): CommandCodeCatalogModel | string {
	if (!isRecord(value)) return "an entry is not an object";
	const { id, name, hidden, context_length, maxOutputTokens, inputModalities, reasoningEfforts } = value;
	if (typeof id !== "string" || !id) return "an entry has no id";
	if (typeof name !== "string" || !name) return `${id}: no name`;
	if (hidden !== undefined && typeof hidden !== "boolean") return `${id}: hidden is not a boolean`;
	if (!isCount(context_length)) return `${id}: no context window`;
	if (maxOutputTokens !== null && !isCount(maxOutputTokens)) return `${id}: unreadable output cap`;
	if (inputModalities !== null && !isStrings(inputModalities)) return `${id}: unreadable input modalities`;
	if (reasoningEfforts !== null && !isStrings(reasoningEfforts)) return `${id}: unreadable reasoning efforts`;
	return {
		id,
		name,
		hidden: hidden === true,
		contextWindow: context_length,
		maxOutputTokens,
		inputModalities,
		reasoningEfforts: reasoningEfforts ?? [],
		pricing: readPricing(value.pricing),
		upstream: readUpstream(value.display),
	};
}

/** The models of a catalogue body. A body in another layout is refused; an unreadable entry is reported and left out. */
export function readCommandCodeCatalog(body: unknown, warn: (message: string) => void): CommandCodeCatalogModel[] {
	if (!isRecord(body)) throw new Error("Command Code catalogue: the body is not an object");
	if (body.schemaVersion !== CATALOG_SCHEMA_VERSION) {
		throw new Error(`Command Code catalogue: schema version ${String(body.schemaVersion)} is not ${CATALOG_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(body.data)) throw new Error("Command Code catalogue: no model list");
	const models: CommandCodeCatalogModel[] = [];
	for (const entry of body.data) {
		const model = readModel(entry);
		if (typeof model === "string") warn(`Command Code catalogue: ${model}; left out`);
		else models.push(model);
	}
	return models;
}

/** pi's cost of a catalogue price: the first tier is the base rate, each later tier starts past the one before it. */
function toCost(pricing: CatalogPricing): ModelCost {
	const rate = (rates: CatalogRates): Omit<ModelCost, "tiers"> => ({
		input: rates.inputCost,
		output: rates.outputCost,
		cacheRead: rates.cacheReadCost,
		// The service bills no cache write where it lists no rate for one.
		cacheWrite: rates.cacheWriteCost ?? 0,
	});
	const tiers = pricing.contextTiers ?? [];
	const base = rate({ ...pricing, ...tiers[0]?.rates });
	const above: ModelCostTier[] = [];
	for (let index = 1; index < tiers.length; index++) {
		const inputTokensAbove = tiers[index - 1].maxContext;
		if (inputTokensAbove === undefined) break;
		above.push({ inputTokensAbove, ...rate({ ...pricing, ...tiers[index].rates }) });
	}
	return above.length > 0 ? { ...base, tiers: above } : base;
}

/**
 * Which of pi's thinking levels a model takes. An effort the route has a name for is sent under that name; a level
 * the model lists no effort for is marked unsupported, so pi moves the request to the nearest level it does take.
 */
function toThinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = { minimal: null };
	for (const level of NAMED_EFFORTS) {
		if (efforts.includes(level)) {
			// pi offers these two only where a model names them.
			if (level === "xhigh" || level === "max") map[level] = level;
		} else if (level !== "xhigh" && level !== "max") map[level] = null;
	}
	return map;
}

/** The catalogue's models as pi lists them. */
export function commandCodeModels(
	catalog: readonly CommandCodeCatalogModel[],
	warn: (message: string) => void,
): Model<"command-code-generate">[] {
	const models: Model<"command-code-generate">[] = [];
	for (const entry of catalog) {
		if (entry.hidden) continue;
		if (!entry.pricing) {
			warn(`Command Code catalogue: ${entry.id} has no list price; left out`);
			continue;
		}
		const reasoning = entry.reasoningEfforts.length > 0;
		const takesImages = entry.inputModalities === null || entry.inputModalities.includes("image");
		models.push({
			id: entry.id,
			name: entry.name,
			api: "command-code-generate",
			provider: COMMAND_CODE_PROVIDER,
			baseUrl: COMMAND_CODE_BASE_URL,
			reasoning,
			...(reasoning ? { thinkingLevelMap: toThinkingLevelMap(entry.reasoningEfforts) } : {}),
			input: takesImages ? ["text", "image"] : ["text"],
			...(entry.upstream ? { upstream: entry.upstream } : {}),
			cost: toCost(entry.pricing),
			contextWindow: entry.contextWindow,
			maxTokens: Math.min(entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, entry.contextWindow),
		});
	}
	return models;
}

/** The service's live catalogue as pi models. */
export async function fetchCommandCodeModels(): Promise<Model<"command-code-generate">[]> {
	console.log("Fetching models from the Command Code catalogue...");
	const response = await fetch(COMMAND_CODE_CATALOG_URL, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`Model catalog request failed (${response.status}): ${COMMAND_CODE_CATALOG_URL}`);
	const warn = (message: string) => console.warn(message);
	const models = commandCodeModels(readCommandCodeCatalog(await response.json(), warn), warn);
	console.log(`Fetched ${models.length} catalog models from Command Code`);
	return models;
}
