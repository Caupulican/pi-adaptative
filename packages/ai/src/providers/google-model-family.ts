import type { Api, Model } from "../types.ts";

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
