import type { Api, Model } from "@caupulican/pi-ai";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Shared loopback classification for local execution, routing, and cache-warm decisions. */
export function isLoopbackModelEndpoint(baseUrl: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** Local execution: a local-runtime provider or a loopback endpoint. */
export function isLocalExecutionModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (model.provider === "ollama" || model.provider === "transformers" || model.provider === "llama-cpp") {
		return true;
	}
	return isLoopbackModelEndpoint(model.baseUrl);
}
