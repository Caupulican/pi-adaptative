import type { Api, Model, ModelServiceTier, ModelThinkingLevel } from "./types.ts";

/** Scheduling entitlement comes from exact advertised metadata, not a model-name heuristic. */
export function isModelServiceTierAdvertised<TApi extends Api>(
	model: Model<TApi>,
	tier: string,
	serviceTiers: readonly ModelServiceTier[] | undefined = model.serviceTiers,
): boolean {
	return serviceTiers?.some((candidate) => candidate.id === tier) ?? false;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max" || level === "ultra") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let index = requestedIndex; index < EXTENDED_THINKING_LEVELS.length; index++) {
		const candidate = EXTENDED_THINKING_LEVELS[index];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index--) {
		const candidate = EXTENDED_THINKING_LEVELS[index];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/** Resolve caller intent and model metadata to one supported level. */
export function resolveModelThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	requestedLevel: ModelThinkingLevel | undefined,
	fallbackLevel: ModelThinkingLevel = "medium",
): ModelThinkingLevel {
	return clampThinkingLevel(model, requestedLevel ?? model.defaultThinkingLevel ?? fallbackLevel);
}
