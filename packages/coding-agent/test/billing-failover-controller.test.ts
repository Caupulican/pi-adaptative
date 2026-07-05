import type { Agent } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { BillingFailoverController, ExhaustedProviderRegistry } from "../src/core/billing-failover-controller.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

const failed = model("codex-spark");
const fallback = model("gpt-5.5");

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function message(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
		provider: "openai-codex",
		model: "codex-spark",
	} as unknown as AssistantMessage;
}

function registry(subscription: boolean, includeFallback = true): ModelRegistry {
	return {
		find: (provider: string, id: string) =>
			provider === "openai-codex" && id === "codex-spark"
				? failed
				: provider === "openai-codex" && id === "gpt-5.5" && includeFallback
					? fallback
					: undefined,
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => subscription,
	} as unknown as ModelRegistry;
}

describe("BillingFailoverController", () => {
	it("hops codex subscription usage limits once to the provider default", async () => {
		const warnings: string[] = [];
		const agent = { state: { model: failed } } as unknown as Agent;
		const controller = new BillingFailoverController({
			agent,
			modelRegistry: registry(true),
			exhausted: new ExhaustedProviderRegistry(),
			emit: (event) => warnings.push(event.message),
		});

		await expect(
			controller.handleAssistantError(message("You have hit your ChatGPT usage limit. Try again later.")),
		).resolves.toBe(true);
		expect(agent.state.model.id).toBe("gpt-5.5");
		expect(warnings).toEqual(["codex-spark quota reached — switched to openai-codex/gpt-5.5"]);
	});

	it("halts metered quota failures without changing models", async () => {
		const warnings: string[] = [];
		const agent = { state: { model: failed } } as unknown as Agent;
		const controller = new BillingFailoverController({
			agent,
			modelRegistry: registry(false),
			exhausted: new ExhaustedProviderRegistry(),
			emit: (event) => warnings.push(event.message),
		});

		await expect(controller.handleAssistantError(message("quota exceeded"))).resolves.toBe(true);
		expect(agent.state.model.id).toBe("codex-spark");
		expect(warnings[0]).toContain("switch models (/model), wait for the limit window, or re-send to retry");
	});

	it("does not re-hop into an exhausted fallback", async () => {
		const warnings: string[] = [];
		const exhausted = new ExhaustedProviderRegistry();
		exhausted.markExhausted("openai-codex/gpt-5.5");
		const agent = { state: { model: failed } } as unknown as Agent;
		const controller = new BillingFailoverController({
			agent,
			modelRegistry: registry(true),
			exhausted,
			emit: (event) => warnings.push(event.message),
		});

		await expect(controller.handleAssistantError(message("You have hit your ChatGPT usage limit."))).resolves.toBe(
			true,
		);
		expect(agent.state.model.id).toBe("codex-spark");
		expect(warnings[0]).toContain("wait for the limit window");
	});
});
