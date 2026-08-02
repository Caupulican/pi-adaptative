import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIClientHeaders, createOpenAIClient } from "../src/providers/openai-client.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	headers: { "x-model-header": "model" },
};

describe("OpenAI-compatible client headers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses the selected session-affinity format", () => {
		expect(
			buildOpenAIClientHeaders(model, "key", {
				session: { id: "session-1", format: "openrouter", includeLegacyAffinity: false },
			}),
		).toEqual({ "x-model-header": "model", "x-session-id": "session-1" });

		expect(
			buildOpenAIClientHeaders(model, "key", {
				session: { id: "session-2", format: "openai-nosession", includeLegacyAffinity: true },
			}),
		).toEqual({
			"x-model-header": "model",
			"x-client-request-id": "session-2",
			"x-session-affinity": "session-2",
		});
	});

	it("applies caller headers last and preserves Cloudflare auth ownership", () => {
		const cloudflareModel: Model<"openai-responses"> = {
			...model,
			provider: "cloudflare-ai-gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
			headers: { Authorization: "model-auth" },
		};

		expect(
			buildOpenAIClientHeaders(cloudflareModel, "cf-key", {
				callerHeaders: { Authorization: "caller-auth", "x-extra": "caller" },
			}),
		).toEqual({
			Authorization: "caller-auth",
			"cf-aig-authorization": "Bearer cf-key",
			"x-extra": "caller",
		});
	});

	it("resolves Cloudflare Workers AI base URL placeholders", () => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-1");
		const client = createOpenAIClient(
			{
				...model,
				provider: "cloudflare-workers-ai",
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
			},
			"key",
		);

		expect(client.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1");
	});
});
