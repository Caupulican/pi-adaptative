import { classifyFailure } from "@caupulican/pi-agent-core";
import {
	type Api,
	type FauxModelDefinition,
	fauxAssistantMessage,
	type Model,
	type ModelThinkingLevel,
	resolveModelThinkingLevel,
} from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { MIN_VIABLE_WORKER_TOKEN_BUDGET } from "../src/core/delegation/worker-authority-resolver.ts";
import { resolveModelToolProtocol } from "../src/core/model-tool-protocol.ts";
import type { OrchestrationThinkingLevel } from "../src/core/orchestration/contracts.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";
import { completedWorkerOutput } from "./worker-output-fixture.ts";

interface ProviderContractCase {
	name: string;
	api: Api;
	provider: string;
	baseUrl: string;
	model: FauxModelDefinition;
	requestedThinking: ModelThinkingLevel;
	profileThinking: OrchestrationThinkingLevel;
	expectedThinking: ModelThinkingLevel;
	expectedTextProtocol: boolean | undefined;
}

const PROVIDER_CASES: readonly ProviderContractCase[] = [
	{
		name: "Codex subscription",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		model: {
			id: "codex-contract-model",
			reasoning: true,
			defaultThinkingLevel: "high",
			thinkingLevelMap: { xhigh: "xhigh", max: "max", ultra: "max" },
			contextWindow: 128_000,
			maxTokens: 16_384,
		},
		requestedThinking: "ultra",
		profileThinking: "ultra",
		expectedThinking: "ultra",
		expectedTextProtocol: undefined,
	},
	{
		name: "Anthropic native",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		model: {
			id: "anthropic-contract-model",
			reasoning: true,
			defaultThinkingLevel: "high",
			thinkingLevelMap: { xhigh: "xhigh" },
			contextWindow: 200_000,
			maxTokens: 16_384,
		},
		requestedThinking: "high",
		profileThinking: "high",
		expectedThinking: "high",
		expectedTextProtocol: undefined,
	},
	{
		name: "xAI Responses",
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		model: {
			id: "grok-contract-model",
			reasoning: true,
			defaultThinkingLevel: "high",
			thinkingLevelMap: { xhigh: "xhigh" },
			contextWindow: 256_000,
			maxTokens: 16_384,
		},
		requestedThinking: "xhigh",
		profileThinking: "xhigh",
		expectedThinking: "xhigh",
		expectedTextProtocol: undefined,
	},
	{
		name: "Amazon Bedrock Converse",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		model: {
			id: "bedrock-contract-model",
			reasoning: true,
			defaultThinkingLevel: "high",
			contextWindow: 200_000,
			maxTokens: 16_384,
		},
		requestedThinking: "high",
		profileThinking: "high",
		expectedThinking: "high",
		expectedTextProtocol: undefined,
	},
	{
		name: "Responses-compatible API",
		api: "openai-responses",
		provider: "compatible-api",
		baseUrl: "https://compatible.example/v1",
		model: {
			id: "compatible-contract-model",
			reasoning: false,
			textToolCallProtocol: true,
			contextWindow: 64_000,
			maxTokens: 8_192,
		},
		requestedThinking: "high",
		profileThinking: "off",
		expectedThinking: "off",
		expectedTextProtocol: true,
	},
	{
		name: "local OpenAI-compatible runtime",
		api: "openai-completions",
		provider: "local-compatible",
		baseUrl: "http://127.0.0.1:11434/v1",
		model: {
			id: "local-contract-model",
			reasoning: true,
			textToolCallProtocol: true,
			defaultThinkingLevel: "low",
			contextWindow: 32_768,
			maxTokens: 4_096,
		},
		requestedThinking: "low",
		profileThinking: "low",
		expectedThinking: "low",
		expectedTextProtocol: true,
	},
];

function contractModel(entry: ProviderContractCase): Model<Api> {
	return {
		id: entry.model.id,
		name: entry.name,
		api: entry.api,
		provider: entry.provider,
		baseUrl: entry.baseUrl,
		reasoning: entry.model.reasoning ?? false,
		textToolCallProtocol: entry.model.textToolCallProtocol,
		defaultThinkingLevel: entry.model.defaultThinkingLevel,
		thinkingLevelMap: entry.model.thinkingLevelMap,
		input: entry.model.input ?? ["text"],
		cost: entry.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.model.contextWindow ?? 32_768,
		maxTokens: entry.model.maxTokens ?? 4_096,
	};
}

describe("provider-neutral model contract matrix", () => {
	it.each(PROVIDER_CASES)(
		"preserves routing, reasoning, worker results, and retry semantics for $name",
		async (entry) => {
			const model = contractModel(entry);
			expect(resolveModelThinkingLevel(model, entry.requestedThinking)).toBe(entry.expectedThinking);
			expect(resolveModelToolProtocol({ model, adaptation: {} }).protocol).toBe(entry.expectedTextProtocol);
			expect(classifyFailure({ message: "network connection lost", provider: entry.provider })).toMatchObject({
				reason: "network",
				retryable: true,
			});

			const profile = createTestWorkerOrchestrationProfile({
				profileId: `${entry.model.id}-worker`,
				model: {
					provider: model.provider,
					id: model.id,
					maxTokens: Math.max(model.maxTokens, MIN_VIABLE_WORKER_TOKEN_BUDGET),
				},
				thinkingLevel: entry.profileThinking,
			});
			const harness = await createHarness({
				fauxProvider: { api: entry.api, provider: entry.provider },
				models: [entry.model],
				settings: { workerDelegation: { enabled: true } },
				workerOrchestrationProfile: profile,
			});
			try {
				expect(harness.session.systemPrompt).toContain("PI DELEGATION");
				let observed:
					| {
							api: string;
							provider: string;
							reasoning: ModelThinkingLevel | undefined;
							textProtocol: boolean | object | undefined;
							toolNames: string[];
							textProtocolPrimer: boolean;
					  }
					| undefined;
				harness.setResponses([
					(context, options, _state, selectedModel) => {
						observed = {
							api: selectedModel.api,
							provider: selectedModel.provider,
							reasoning: options?.reasoning,
							textProtocol: options?.textToolCallProtocol,
							toolNames: context.tools?.map((tool) => tool.name) ?? [],
							textProtocolPrimer: context.systemPrompt?.includes("Text tool-call protocol is enabled.") ?? false,
						};
						return fauxAssistantMessage(completedWorkerOutput("provider-neutral worker completed", []));
					},
				]);

				const run = await harness.session.runWorkerDelegationOnce({ instructions: "Exercise the provider matrix" });

				expect(run.record?.status).toBe("succeeded");
				expect(run.outcome?.claim).toMatchObject({
					status: "completed",
					summary: "provider-neutral worker completed",
				});
				expect(observed).toEqual({
					api: entry.api,
					provider: entry.provider,
					reasoning: entry.profileThinking,
					textProtocol: entry.expectedTextProtocol,
					toolNames: entry.expectedTextProtocol ? [] : ["read", "memory"],
					textProtocolPrimer: entry.expectedTextProtocol === true,
				});
			} finally {
				harness.cleanup();
			}
		},
	);
});
