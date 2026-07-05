import { describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "codex-spark",
	name: "Codex Spark",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

const apiKey = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
).toString("base64url")}.signature`;

describe("openai-codex terminal retry handling", () => {
	it("does not retry the catch-side friendly usage-limit literal", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("You have hit your ChatGPT usage limit. Try again in 2 hours.");
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const stream = streamOpenAICodexResponses(model, context, { apiKey, maxRetries: 3 });
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("You have hit your ChatGPT usage limit");
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
