import type { OpenAICompletionsCompat } from "../types.ts";

export function detectOpenRouterCacheControlFormat(
	provider: string,
	modelId: string,
): OpenAICompletionsCompat["cacheControlFormat"] {
	return provider === "openrouter" && /^~?anthropic\//.test(modelId) ? "anthropic" : undefined;
}

export function resolveCachePolicyFormat(
	provider: string,
	modelId: string,
	configured: OpenAICompletionsCompat["cacheControlFormat"],
): "anthropic" | "openai" | "unknown" {
	if (provider === "openai" || (provider === "openrouter" && /^~?openai\//.test(modelId)))
		return configured === "anthropic" ? "unknown" : "openai";
	return configured ?? "unknown";
}
