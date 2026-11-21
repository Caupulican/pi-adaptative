import type { Api, Model } from "../types.ts";

export const ANTIGRAVITY_EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;

export function antigravityNamedVariant(id: string) {
	return ANTIGRAVITY_EFFORT_ORDER.find((variant) => id.endsWith(`-${variant}`));
}

/** Only the effort suffix may differ when replaying an AGY Gemini preset's signed history. */
export function sameAntigravityGeminiPresetFamily(source: string, target: string): boolean {
	if (!target.startsWith("gemini-")) return false;
	const variant = antigravityNamedVariant(target);
	const sourceVariant = antigravityNamedVariant(source);
	return (
		variant !== undefined &&
		sourceVariant !== undefined &&
		source.slice(0, -(sourceVariant.length + 1)) === target.slice(0, -(variant.length + 1))
	);
}

/** Shared family identity for catalog capabilities and Google request policy. */
export function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

export function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

export function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

export function isGemini4ArgonModel(modelId: string): boolean {
	return /(?:^|\/)gemini-4-argon(?:[-:]|$)/.test(modelId.toLowerCase());
}

/** Argon has three mandatory reasoning levels; provider adapters project their wire vocabulary. */
export function gemini4ArgonThinkingMetadata(
	googleWire: boolean,
): Pick<Model<Api>, "defaultThinkingLevel" | "thinkingLevelMap"> {
	return {
		defaultThinkingLevel: "medium",
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: googleWire ? "LOW" : "low",
			medium: googleWire ? "MEDIUM" : "medium",
			high: googleWire ? "HIGH" : "high",
		},
	};
}
