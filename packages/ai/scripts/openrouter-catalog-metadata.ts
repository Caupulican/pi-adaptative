import type { Model, ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

// OpenRouter's wire effort vocabulary; "off" is represented by "none", and
// "ultra" is a harness orchestration level rather than a provider effort.
const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface OpenRouterCatalogMetadata {
	/** Used only to select compatibility rules; never replaces the requested model ID. */
	targetId?: string;
	thinkingLevelMap?: ThinkingLevelMap;
	defaultThinkingLevel?: ThinkingLevel;
}

/** Negative router rates mean unavailable local pricing; positive reported usage.cost remains authoritative. */
export function parseOpenRouterCatalogCost(value: unknown): Model<"openai-completions">["cost"] {
	if (value != null && !isRecord(value)) throw new Error("Invalid OpenRouter price object");
	const pricing = isRecord(value) ? value : {};
	const rate = (field: string): number => {
		const raw = pricing[field];
		if (raw == null) return 0;
		if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !raw.trim())) {
			throw new Error(`Invalid OpenRouter ${field} price`);
		}
		const price = Number(raw);
		const scaled = price * 1_000_000;
		if (!Number.isFinite(price) || !Number.isFinite(scaled)) throw new Error(`Invalid OpenRouter ${field} price`);
		// Zero is the existing unavailable-price fallback, not a claim of free routing.
		return Math.max(0, scaled);
	};
	return { input: rate("prompt"), output: rate("completion"), cacheRead: rate("input_cache_read"), cacheWrite: rate("input_cache_write") };
}

export function parseOpenRouterCatalogMetadata(value: unknown): OpenRouterCatalogMetadata {
	const metadata: OpenRouterCatalogMetadata = {};
	if (!isRecord(value)) return metadata;
	if (isRecord(value.alias_target) && typeof value.alias_target.slug === "string" && value.alias_target.slug.trim()) {
		metadata.targetId = value.alias_target.slug;
	}
	if (!isRecord(value.reasoning)) return metadata;
	const reasoning = value.reasoning;
	const efforts = reasoning.supported_efforts;
	if (
		Array.isArray(efforts) &&
		efforts.every((effort): effort is string => typeof effort === "string") &&
		OPENROUTER_REASONING_EFFORTS.some((effort) => efforts.includes(effort))
	) {
		const thinkingLevelMap: ThinkingLevelMap = {};
		for (const effort of OPENROUTER_REASONING_EFFORTS) {
			thinkingLevelMap[effort] = efforts.includes(effort) ? effort : null;
		}
		metadata.thinkingLevelMap = thinkingLevelMap;
		metadata.defaultThinkingLevel = OPENROUTER_REASONING_EFFORTS.find(
			(effort) => effort === reasoning.default_effort && efforts.includes(effort),
		);
	}
	if (reasoning.mandatory === true) {
		metadata.thinkingLevelMap = { ...metadata.thinkingLevelMap, off: null };
	}
	return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
