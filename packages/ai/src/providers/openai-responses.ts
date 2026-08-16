import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { createOpenAIClient } from "./openai-client.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	applyOpenAIServiceTierPricing,
	buildResponsesInstructions,
	convertResponsesMessages,
	convertResponsesTools,
	createOpenAIResponsesToolNameMap,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import {
	applyProviderPayloadHook,
	beginAssistantResponseStream,
	completeAssistantStream,
	createAssistantMessage,
	createProviderRetryOptions,
	createRetryFreeRequestOptions,
	resolveCacheRetention,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "fugu"]);
const FUGU_DEFAULT_TIMEOUT_MS = 7_200_000;
const FUGU_DEFAULT_MAX_RETRIES = 4;

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		requestFormat: model.compat?.requestFormat ?? "openai",
		supportsReasoningEffort: model.compat?.supportsReasoningEffort ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output = createAssistantMessage(model);

		try {
			// Create OpenAI client
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const client = createOpenAIClient(model, apiKey, {
				baseUrl: resolveBaseUrl(model),
				context,
				callerHeaders: options?.headers,
				session: cacheSessionId
					? { id: cacheSessionId, format: compat.sessionAffinityFormat, includeLegacyAffinity: false }
					: undefined,
			});
			const toolNameMap = createOpenAIResponsesToolNameMap(context.tools ?? []);
			const params = await applyProviderPayloadHook(buildParams(model, context, options), model, options?.onPayload);
			const requestOptions = createRetryFreeRequestOptions(
				options,
				model.provider === "fugu" ? FUGU_DEFAULT_TIMEOUT_MS : undefined,
			);
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				createProviderRetryOptions(options, model.provider === "fugu" ? FUGU_DEFAULT_MAX_RETRIES : 0),
			);
			await beginAssistantResponseStream(stream, output, response, model, options?.onResponse);

			await processResponsesStream(openaiStream, output, stream, model, {
				toolNameMap,
				serviceTier: options?.serviceTier,
				applyServiceTierPricing:
					model.provider === "fugu"
						? undefined
						: (usage, serviceTier) => applyOpenAIServiceTierPricing(usage, serviceTier, model),
			});

			completeAssistantStream(stream, output, options?.signal);
		} catch (error) {
			terminateAssistantStreamWithError(stream, output, options?.signal, error, {
				formatError: formatOpenAIResponsesError,
				scratchFields: ["index", "partialJson"],
			});
		}
	})();

	return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const requestedReasoning = options?.reasoning ?? model.defaultThinkingLevel;
	const clampedReasoning = requestedReasoning ? clampThinkingLevel(model, requestedReasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? "none" : clampedReasoning;

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function resolveFuguBaseUrl(): string | undefined {
	if (typeof process === "undefined") return undefined;
	const value = process.env.FUGU_BASE_URL?.trim();
	if (!value) return undefined;
	const baseUrl = value.replace(/\/+$/, "");
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function resolveBaseUrl(model: Model<"openai-responses">): string {
	if (isCloudflareProvider(model.provider)) return resolveCloudflareBaseUrl(model);
	if (model.provider === "fugu") return resolveFuguBaseUrl() ?? model.baseUrl;
	return model.baseUrl;
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const toolNameMap = createOpenAIResponsesToolNameMap(context.tools ?? []);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const compat = getCompat(model);
	const useXaiCliFormat = compat.requestFormat === "xai-cli";
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		requestFormat: compat.requestFormat,
		toolNameMap,
	});
	const isGpt56 = model.provider === "openai" && model.id.startsWith("gpt-5.6");
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		instructions: useXaiCliFormat ? undefined : buildResponsesInstructions(context),
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		...(cacheRetention !== "none" && isGpt56
			? { prompt_cache_options: options?.promptCacheOptions ?? { mode: "implicit" as const, ttl: "30m" as const } }
			: {}),
		...(isGpt56 ? {} : { prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention) }),
		store: false,
	};
	const safetyIdentifier = options?.metadata?.safety_identifier;
	if (typeof safetyIdentifier === "string" && safetyIdentifier.length > 0) {
		params.safety_identifier = safetyIdentifier;
	}

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined && model.provider !== "fugu") {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools, { strict: useXaiCliFormat ? null : undefined, toolNameMap });
	}
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning && compat.supportsReasoningEffort) {
		if (
			options?.reasoningEffort ||
			options?.reasoningSummary !== undefined ||
			options?.reasoningMode ||
			options?.reasoningContext
		) {
			const effort = options?.reasoningEffort
				? options.reasoningEffort === "none"
					? (model.thinkingLevelMap?.off ?? "none")
					: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			const reasoningDisabled = options?.reasoningEffort === "none";
			const supportsReasoningSummary = model.provider !== "fugu" || model.id === "fugu-ultra";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				...(supportsReasoningSummary && !reasoningDisabled && options?.reasoningSummary !== null
					? { summary: options?.reasoningSummary ?? (useXaiCliFormat ? "concise" : "auto") }
					: {}),
				...(options?.reasoningMode ? { mode: options.reasoningMode } : {}),
				...(options?.reasoningContext ? { context: options.reasoningContext } : {}),
			};
			if (supportsReasoningSummary && !reasoningDisabled) {
				params.include = ["reasoning.encrypted_content"];
			}
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		// xAI always returns encrypted reasoning items that must be echoed back on the next turn,
		// even when no reasoning effort was requested (e.g. thinkingLevelMap.off === null skips the
		// branch above entirely). Without this, encrypted reasoning silently drops across turns.
		if (model.provider === "xai") {
			params.include = ["reasoning.encrypted_content"];
		}
	}

	return params;
}
