import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

// OpenRouter's wire effort vocabulary; "off" is represented by "none", and
// "ultra" is a harness orchestration level rather than a provider effort.
const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface OpenRouterCatalogMetadata {
	/** Used only to select compatibility rules; never replaces the requested model ID. */
	targetId?: string;
	thinkingLevelMap?: ThinkingLevelMap;
	defaultThinkingLevel?: ThinkingLevel;
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
