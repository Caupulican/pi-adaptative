import type { Api, Model } from "@caupulican/pi-ai/types";
import { type Static, Type } from "typebox";
import { MODEL_DEFAULT_THINKING_LEVEL_SCHEMA } from "./orchestration/thinking-level-schema.ts";

// Schema for OpenRouter routing preferences
export const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

export const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Schema for Vercel AI Gateway routing preferences
export const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for thinking level support and provider-specific values
export const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);

export const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
	max: Type.Optional(ThinkingLevelMapValueSchema),
	ultra: Type.Optional(ThinkingLevelMapValueSchema),
});

export const SessionAffinityCompatFields = {
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
};

export const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	thinkingTokenBudgetField: Type.Optional(
		Type.Union([
			Type.Literal("thinking_token_budget"),
			Type.Literal("thinking_budget"),
			Type.Literal("thinking_budget_tokens"),
		]),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	...SessionAffinityCompatFields,
});

export const OpenAIResponsesCompatSchema = Type.Object(SessionAffinityCompatFields);

export const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
});

export const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

export const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	input: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Number()),
	cacheRead: Type.Optional(Type.Number()),
	cacheWrite: Type.Optional(Type.Number()),
});

export const ModelCostSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

export const SharedModelConfigurationFields = {
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	defaultThinkingLevel: Type.Optional(MODEL_DEFAULT_THINKING_LEVEL_SCHEMA),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	contextWindow: Type.Optional(Type.Number()),
	textToolCallProtocol: Type.Optional(Type.Boolean()),
	maxTokens: Type.Optional(Type.Number()),
	samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
};

// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
export const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	...SharedModelConfigurationFields,
	cost: Type.Optional(ModelCostSchema),
});

// Schema for per-model overrides (all fields optional, merged with built-in model)
export const ModelOverrideSchema = Type.Object({
	...SharedModelConfigurationFields,
	cost: Type.Optional(Type.Partial(ModelCostSchema)),
});

export type ModelOverride = Static<typeof ModelOverrideSchema>;

export const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

export const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

export type ModelsConfig = Static<typeof ModelsConfigSchema>;

/** Provider override config (baseUrl, compat) without request auth/headers */
export interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

export interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}
