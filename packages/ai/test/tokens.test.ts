import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";
import { stream } from "../src/stream.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { liveEnvApiKey, resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// OpenAI providers, OpenAI Codex, zai, and Amazon Bedrock only send usage in the final chunk,
	// so when aborted they have no token stats. Anthropic and Google send usage information early in the stream.
	// MiniMax and Kimi report input tokens but not output tokens differently on aborted requests.
	if (
		llm.api === "openai-completions" ||
		llm.api === "mistral-conversations" ||
		llm.api === "openai-responses" ||
		llm.api === "azure-openai-responses" ||
		llm.api === "openai-codex-responses" ||
		llm.provider === "zai" ||
		llm.provider === "amazon-bedrock" ||
		llm.provider === "vercel-ai-gateway"
	) {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "minimax") {
		// MiniMax M2.7 does not report token usage for aborted requests.
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "kimi-coding") {
		// Kimi reports input tokens early but output tokens only in the final chunk.
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Some providers (Copilot) have zero cost rates
		if (llm.cost.input > 0) {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	}
}

describe("Token Statistics on Abort", () => {
	describe.skipIf(!liveEnvApiKey("google"))("Google Provider", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm, { thinking: { enabled: true } });
		});
	});

	describe.skipIf(!liveEnvApiKey("openai"))("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("openai"))("OpenAI Responses Provider", () => {
		const llm = getModel("openai", "gpt-5.4-mini");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm, { reasoningEffort: "low" });
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm, azureOptions);
		});
	});

	describe.skipIf(!liveEnvApiKey("anthropic"))("Anthropic Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("xai"))("xAI Provider", () => {
		const llm = getModel("xai", "grok-4.6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("groq"))("Groq Provider", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("cerebras"))("Cerebras Provider", () => {
		const preferredCerebrasModelIds: string[] = ["gpt-oss-120b", "zai-glm-4.7", "llama3.1-8b"];
		const cerebrasModels = getModels("cerebras");
		const llm = cerebrasModels.find((model) => preferredCerebrasModelIds.includes(model.id)) ?? cerebrasModels[0];

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			if (!llm) {
				throw new Error("No Cerebras models available");
			}

			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider", () => {
		const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider", () => {
		const llm = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("huggingface"))("Hugging Face Provider", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("together"))("Together AI Provider", () => {
		const llm = getModel("together", "moonshotai/Kimi-K2.6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("zai"))("zAI Provider", () => {
		const llm = getModel("zai", "glm-5.2");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("mistral"))("Mistral Provider", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("minimax"))("MiniMax Provider", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("kimi-coding"))("Kimi For Coding Provider", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("vercel-ai-gateway"))("Vercel AI Gateway Provider", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("xiaomi"))("Xiaomi MiMo (API billing) Provider", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		// FIXME(xiaomi): Xiaomi's Anthropic-compatible stream does not populate
		// usage in the message_start event the way Anthropic does — usage only
		// arrives at message_stop. Aborting mid-stream therefore loses input/output
		// token counts. Non-streaming usage works (see total-tokens.test.ts).
		// Re-enable once upstream sends usage in message_start.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("xiaomi-token-plan-cn"))("Xiaomi MiMo Token Plan (CN) Provider", () => {
		const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("xiaomi-token-plan-ams"))("Xiaomi MiMo Token Plan (AMS) Provider", () => {
		const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!liveEnvApiKey("xiaomi-token-plan-sgp"))("Xiaomi MiMo Token Plan (SGP) Provider", () => {
		const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it.skipIf(!anthropicOAuthToken)(
			"should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4.1");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testTokensOnAbort(llm, { apiKey: openaiCodexToken });
			},
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});
});
