/**
 * The attribution headers a provider request carries when the model is served by a gateway that asks for them (OpenCode,
 * OpenRouter, Cloudflare): the identity this harness announces to the gateway, and the session it belongs to.
 */
import type { Api, Model } from "@caupulican/pi-ai";

export function getAttributionHeaders(model: Model<Api>, sessionId?: string): Record<string, string> | undefined {
	if (
		sessionId &&
		(model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai"))
	) {
		return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
	}

	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		return {
			"HTTP-Referer": "https://github.com/Caupulican/pi-adaptative",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		model.baseUrl.includes("api.cloudflare.com") ||
		model.baseUrl.includes("gateway.ai.cloudflare.com")
	) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}
