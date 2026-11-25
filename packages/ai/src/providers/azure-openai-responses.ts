import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { canReuseProviderInput } from "../history-work.ts";
import type { Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { type AzureRouteOptions, resolveAzureConfig, resolveDeploymentName } from "./openai-endpoints.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	buildResponsesInstructions,
	convertResponsesMessages,
	convertResponsesTools,
	createOpenAIResponsesToolNameMap,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import {
	applyProviderPayloadHook,
	beginAssistantResponseStream,
	buildClampedSimpleOptions,
	completeAssistantStream,
	createAssistantMessage,
	createProviderRetryOptions,
	createRetryFreeRequestOptions,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";

const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]);

function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions, AzureRouteOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);
		const output = createAssistantMessage(model);

		try {
			// Create Azure OpenAI client
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options);
			const toolNameMap = createOpenAIResponsesToolNameMap(context.tools ?? []);
			const params = await applyProviderPayloadHook(
				buildParams(model, context, options, deploymentName),
				model,
				options?.onPayload,
			);
			const requestOptions = createRetryFreeRequestOptions(options);
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				createProviderRetryOptions(options),
			);
			await beginAssistantResponseStream(stream, output, response, model, options?.onResponse);

			await processResponsesStream(openaiStream, output, stream, model, { toolNameMap });

			completeAssistantStream(stream, output, options?.signal);
		} catch (error) {
			terminateAssistantStreamWithError(stream, output, options?.signal, error, {
				formatError: formatAzureOpenAIError,
				scratchFields: ["index", "partialJson"],
			});
		}
	})();

	return stream;
};

export const streamSimpleAzureOpenAIResponses: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const { base, clampedReasoning } = buildClampedSimpleOptions(model, options);
	const reasoningEffort =
		clampedReasoning === "off" ? undefined : clampedReasoning === "ultra" ? "max" : clampedReasoning;

	return streamAzureOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	const headers = { ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
		baseURL: baseUrl,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const toolNameMap = createOpenAIResponsesToolNameMap(context.tools ?? []);
	const messages = convertResponsesMessages(
		model,
		context,
		AZURE_TOOL_CALL_PROVIDERS,
		canReuseProviderInput(context.messages, options?.onPayload) ? { reuseAcceptedPrefix: true } : { toolNameMap },
	);

	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		instructions: buildResponsesInstructions(context),
		input: messages,
		stream: true,
		prompt_cache_key: options?.cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools, { toolNameMap });
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary !== undefined) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				...(options?.reasoningSummary !== null ? { summary: options?.reasoningSummary ?? "auto" } : {}),
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}
