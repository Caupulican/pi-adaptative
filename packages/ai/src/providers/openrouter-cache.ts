import type { OpenAICompletionsCompat } from "../types.ts";

export function detectOpenRouterCacheControlFormat(
	provider: string,
	modelId: string,
): OpenAICompletionsCompat["cacheControlFormat"] {
	return provider === "openrouter" && /^~?anthropic\//.test(modelId) ? "anthropic" : undefined;
}
