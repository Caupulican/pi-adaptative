import type { GenerateContentConfig, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { clampThinkingLevel } from "../model-capabilities.ts";
import type {
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { calculateCost } from "../usage.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { createToolNameMap } from "../utils/tool-names.ts";
import type { GoogleApiType, GoogleThinkingEffort, GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	resolveDisabledGoogleThinkingConfig,
	resolveGoogleThinkingConfig,
	retainThoughtSignature,
	toGoogleGenAiThinkingConfig,
} from "./google-shared.ts";
import {
	applyProviderPayloadHook,
	completeAssistantStream,
	createAssistantMessage,
	executeWithAuthRecovery,
	finishTextOrThinkingBlock,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";
import { buildBaseOptions } from "./simple-options.ts";

// The stream consumes wire fields, not SDK response getters or client implementation details.
export type GoogleGenAiResponse = Pick<GenerateContentResponse, "candidates" | "usageMetadata" | "responseId">;

export interface GoogleGenAiClient {
	models: {
		generateContentStream: (params: GenerateContentParameters) => Promise<AsyncIterable<GoogleGenAiResponse>>;
	};
}

export interface GoogleGenAiOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleThinkingLevel;
	};
}

export function streamGoogleGenAi<TApi extends GoogleApiType>(
	model: Model<TApi>,
	context: Context,
	options: GoogleGenAiOptions | undefined,
	createClient: () => GoogleGenAiClient,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createAssistantMessage(model);

		try {
			let client = createClient();
			const params = await applyProviderPayloadHook(
				buildGoogleGenerateContentParameters(model, context, options),
				model,
				options?.onPayload,
			);
			const googleStream = await executeWithAuthRecovery(model.provider, options, async (replacementKey) => {
				if (replacementKey) {
					if (options) {
						options.apiKey = replacementKey;
					}
					client = createClient();
				}
				return client.models.generateContentStream(params);
			});
			const toolNameMap = createToolNameMap(context.tools ?? []);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			let generatedToolCallCount = 0;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							// This endpoint opens a Claude turn with an empty text part, then the
							// thought, then the answer. An empty part with no signature is not a block.
							if (part.text.length === 0 && !part.thoughtSignature) continue;
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								finishTextOrThinkingBlock(stream, output, currentBlock, blockIndex());
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								finishTextOrThinkingBlock(stream, output, currentBlock, blockIndex());
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId ||
								output.content.some((block) => block.type === "toolCall" && block.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++generatedToolCallCount}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: toolNameMap.toOriginalName(part.functionCall.name || ""),
								arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((block) => block.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			finishTextOrThinkingBlock(stream, output, currentBlock, blockIndex());
			completeAssistantStream(stream, output, options?.signal);
		} catch (error) {
			terminateAssistantStreamWithError(stream, output, options?.signal, error, {
				formatError: (caught) => formatProviderError(normalizeProviderError(caught)),
				scratchFields: ["index"],
			});
		}
	})();

	return stream;
}

export function buildGoogleGenerateContentParameters<TApi extends GoogleApiType>(
	model: Model<TApi>,
	context: Context,
	options: GoogleGenAiOptions = {},
): GenerateContentParameters {
	const toolNameMap = createToolNameMap(context.tools ?? []);
	const contents = convertMessages(model, context, toolNameMap);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools &&
			context.tools.length > 0 && {
				tools: convertTools(
					context.tools,
					// A non-Google upstream reads only the OpenAPI `parameters` field: without it Claude receives
					// no input_schema and GPT calls tools with no arguments.
					model.upstream !== undefined && model.upstream !== "google",
					toolNameMap,
				),
			}),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		config.thinkingConfig = toGoogleGenAiThinkingConfig(
			{
				...(options.thinking.level !== undefined ? { thinkingLevel: options.thinking.level } : {}),
				...(options.thinking.budgetTokens !== undefined ? { thinkingBudget: options.thinking.budgetTokens } : {}),
			},
			true,
		);
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = toGoogleGenAiThinkingConfig(resolveDisabledGoogleThinkingConfig(model.id));
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

export function buildGoogleSimpleOptions<TApi extends GoogleApiType>(
	model: Model<TApi>,
	options: SimpleStreamOptions | undefined,
	apiKey: string | undefined,
): GoogleGenAiOptions {
	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning || options.reasoning === "off") {
		return { ...base, thinking: { enabled: false } };
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return { ...base, thinking: { enabled: false } };
	}
	const effort = clampedReasoning as GoogleThinkingEffort;
	const thinkingConfig = resolveGoogleThinkingConfig(model.id, effort, options.thinkingBudgets);

	return {
		...base,
		thinking: {
			enabled: true,
			...(thinkingConfig.thinkingLevel !== undefined ? { level: thinkingConfig.thinkingLevel } : {}),
			...(thinkingConfig.thinkingBudget !== undefined ? { budgetTokens: thinkingConfig.thinkingBudget } : {}),
		},
	};
}
