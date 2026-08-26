import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DocumentType, MetadataBearer } from "@smithy/types";
import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { createHttpProxyAgentsForTarget } from "../utils/node-http-proxy.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { createToolNameMap, type ToolNameMap } from "../utils/tool-names.ts";
import { getRecoverableBedrockSsoError } from "./bedrock-sso.ts";
import {
	applyProviderPayloadHook,
	commitSuccessfulAssistantParse,
	createAssistantMessage,
	mapStandardThinkingEffort,
	resolveCacheRetention,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: ThinkingLevel;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude's thinking content is returned in responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking content is redacted but the signature still travels back
	 *   for multi-turn continuity, reducing time-to-first-text-token.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.8 and Mythos Preview is
	 * "omitted". We default to "summarized" here to keep behavior consistent with
	 * older Claude 4 models. Only applies to Claude models on Bedrock.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** Key-value pairs attached to the inference request for cost allocation tagging.
	 * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
	 * Tags appear in AWS Cost Explorer split cost allocation data.
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** Bearer token for Bedrock API key authentication.
	 * When set, bypasses SigV4 signing and sends Authorization: Bearer <token> instead.
	 * Requires `bedrock:CallWithBearerToken` IAM permission on the token's identity.
	 * Set via AWS_BEARER_TOKEN_BEDROCK env var or pass directly.
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

const EMPTY_TEXT_PLACEHOLDER = "<empty>";

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const toolNameMap = createToolNameMap(context.tools ?? []);
		const output = createAssistantMessage(model);

		const blocks = output.content as Block[];

		const config: BedrockRuntimeClientConfig = {
			profile: options.profile?.trim() || undefined,
		};
		const configuredRegion = getConfiguredBedrockRegion(options);
		const configuredProfile = getConfiguredBedrockProfile(options);
		const recoveryProfile = configuredProfile ?? "default";
		const hasConfiguredProfile = configuredProfile !== undefined;
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasConfiguredProfile,
		);

		// Only pin standard AWS Bedrock runtime endpoints when no region/profile is configured.
		// This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
		// catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		// Resolve bearer token for Bedrock API key auth.
		const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
		const useBearerToken = bearerToken !== undefined && process.env.AWS_BEDROCK_SKIP_AUTH !== "1";

		// in Node.js/Bun environment only
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			// Region resolution: explicit option > env vars > SDK default chain.
			// When AWS_PROFILE is set, we leave region undefined so the SDK can
			// resolve it from AWS profile config. Otherwise fall back to us-east-1.
			if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasConfiguredProfile) {
				config.region = "us-east-1";
			}

			// Support proxies that don't need authentication
			if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			const proxyAgents = createHttpProxyAgentsForTarget(model.baseUrl);
			if (proxyAgents) {
				// Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
				// on `http2` module and has no support for http agent.
				// Use NodeHttpHandler to support HTTP(S) proxy agents.
				config.requestHandler = new NodeHttpHandler(proxyAgents);
			} else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
				// Some custom endpoints require HTTP/1.1 instead of HTTP/2
				config.requestHandler = new NodeHttpHandler();
			}
		} else {
			// Non-Node environment (browser): fall back to us-east-1 since
			// there's no config file resolution available.
			config.region =
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		if (useBearerToken) {
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		try {
			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			const commandInput = await applyProviderPayloadHook(
				{
					modelId: model.id,
					messages: convertMessages(context, model, cacheRetention, toolNameMap),
					system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
					inferenceConfig: {
						...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
						...(options.temperature !== undefined && { temperature: options.temperature }),
					},
					toolConfig: convertToolConfig(context.tools, options.toolChoice, toolNameMap),
					additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
					...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
				},
				model,
				options.onPayload,
			);
			let ssoRecoveryAttempted = false;
			while (true) {
				let receivedResponse = false;
				try {
					const client = new BedrockRuntimeClient(config);
					if (options.headers && Object.keys(options.headers).length > 0) {
						addCustomHeadersMiddleware(client, options.headers);
					}
					const command = new ConverseStreamCommand(commandInput);
					const response = await client.send(command, { abortSignal: options.signal });
					receivedResponse = true;
					if (response.$metadata.httpStatusCode !== undefined) {
						const responseHeaders: Record<string, string> = {};
						if (response.$metadata.requestId) {
							responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
						}
						await options?.onResponse?.(
							{ status: response.$metadata.httpStatusCode, headers: responseHeaders },
							model,
						);
					}

					if (!response.stream) {
						throw new Error("Bedrock returned a response without a stream");
					}
					for await (const item of response.stream) {
						if (item.messageStart) {
							if (item.messageStart.role !== ConversationRole.ASSISTANT) {
								throw new Error("Unexpected assistant message start but got user message start instead");
							}
							stream.push({ type: "start", partial: output });
						} else if (item.contentBlockStart) {
							handleContentBlockStart(item.contentBlockStart, blocks, output, stream, toolNameMap);
						} else if (item.contentBlockDelta) {
							handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
						} else if (item.contentBlockStop) {
							handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
						} else if (item.messageStop) {
							const mapped = mapStopReason(item.messageStop.stopReason);
							output.stopReason = mapped.stopReason;
							if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
							if (output.stopReason !== "error" && output.stopReason !== "aborted") {
								commitSuccessfulAssistantParse(output);
							}
						} else if (item.metadata) {
							handleMetadata(item.metadata, model, output);
						} else if (item.internalServerException) {
							throw item.internalServerException;
						} else if (item.modelStreamErrorException) {
							throw item.modelStreamErrorException;
						} else if (item.validationException) {
							throw item.validationException;
						} else if (item.throttlingException) {
							throw item.throttlingException;
						} else if (item.serviceUnavailableException) {
							throw item.serviceUnavailableException;
						}
					}

					if (output.stopReason === "error" || output.stopReason === "aborted") {
						throw new Error(output.errorMessage || "An unknown error occurred");
					}

					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
					break;
				} catch (error) {
					const ssoError = getRecoverableBedrockSsoError(error);
					if (
						!ssoRecoveryAttempted &&
						!receivedResponse &&
						!options.signal?.aborted &&
						options.interactionMode !== "background" &&
						options.onInteractiveAuthRecovery &&
						ssoError &&
						!useBearerToken &&
						process.env.AWS_BEDROCK_SKIP_AUTH !== "1" &&
						(await options.onInteractiveAuthRecovery({
							method: "aws-sso",
							providerId: model.provider,
							profile: recoveryProfile,
							...(ssoError.name ? { errorName: ssoError.name } : {}),
							errorMessage: ssoError.message,
							...(options.signal ? { signal: options.signal } : {}),
						}))
					) {
						ssoRecoveryAttempted = true;
						continue;
					}
					throw error;
				}
			}
		} catch (error) {
			terminateAssistantStreamWithError(stream, output, options.signal, error, {
				formatError: formatBedrockError,
				scratchFields: ["index", "partialJson"],
			});
		}
	})();

	return stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}`;
	}
	return core;
}

/**
 * Header keys that must never be overwritten by caller-supplied headers.
 * `host` and `x-amz-*` participate in the SigV4 canonical request; `authorization`
 * is owned by SigV4 or the bearer-token path (config.token + authSchemePreference).
 * Compared case-insensitively (caller key is lower-cased before lookup).
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * Attach caller-supplied headers to the outgoing Bedrock request via a Smithy
 * `build`-step middleware. The `build` step runs after request serialisation but
 * before SigV4 signing, so injected headers are covered by the signature. Reserved
 * SigV4 / auth headers (`x-amz-*`, `authorization`, `host`) are silently skipped;
 * all other caller headers override any existing same-named header on the request.
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning || options.reasoning === "off") {
		return streamBedrock(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return streamBedrock(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined means the caller did not request an output cap; let the helper use the model cap.
		// Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		return streamBedrock(model, context, {
			...base,
			maxTokens: adjusted.maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return streamBedrock(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	toolNameMap: ToolNameMap,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: toolNameMap.toOriginalName(start.toolUse.name || ""),
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one, as `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.redactedContent) {
				thinkingBlock.redacted = true;
				thinkingBlock.thinkingSignature = appendBase64Bytes(
					thinkingBlock.thinkingSignature,
					delta.reasoningContent.redactedContent,
				);
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			// Finalize in-place and strip the scratch buffer so replay only
			// carries parsed arguments.
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-4-6") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";
	return mapStandardThinkingEffort(model, level) as "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.
 * Amazon Nova models have automatic caching and don't need explicit cache points.
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") return true;
		return false;
	}
	// Claude 5 models (fable-5, opus-5, sonnet-5)
	if (candidates.some((s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5"))) return true;
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// Add cache point for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function sanitizeBedrockDocument(value: DocumentType): DocumentType {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

const BEDROCK_ROOT_SCHEMA_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const BEDROCK_TOOL_PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
const BEDROCK_OBJECT_SCHEMA_KEYS = new Set([
	"additionalProperties",
	"dependentRequired",
	"maxProperties",
	"minProperties",
	"patternProperties",
	"properties",
	"propertyNames",
	"required",
	"unevaluatedProperties",
]);

interface BedrockObjectSchemaProjection {
	properties: Record<string, unknown>;
	required: Set<string>;
}

interface NormalizedBedrockToolInputSchema {
	schema: unknown;
	constraintDescription?: string;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneBedrockSchemaValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (Array.isArray(value)) {
		const existing = seen.get(value);
		if (existing !== undefined) return existing;
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const entry of value) clone.push(cloneBedrockSchemaValue(entry, seen));
		return clone;
	}
	if (!isSchemaRecord(value)) return value;

	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	const clone: Record<string, unknown> = {};
	seen.set(value, clone);
	for (const [key, entry] of Object.entries(value)) {
		clone[key] = cloneBedrockSchemaValue(entry, seen);
	}
	return clone;
}

function resolveBedrockLocalSchemaRef(root: Record<string, unknown>, reference: string): unknown {
	const match = reference.match(/^#\/(\$defs|definitions)\/(.+)$/);
	if (!match) return undefined;
	let current: unknown = root[match[1]];
	for (const rawPart of match[2].split("/")) {
		if (!isSchemaRecord(current)) return undefined;
		const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
		current = current[part];
	}
	return current;
}

function bedrockSchemaRequired(schema: Record<string, unknown>): string[] {
	return Array.isArray(schema.required)
		? schema.required.filter(
				(key): key is string => typeof key === "string" && BEDROCK_TOOL_PROPERTY_NAME_PATTERN.test(key),
			)
		: [];
}

function bedrockSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
	if (!isSchemaRecord(schema.properties)) return {};
	return Object.fromEntries(
		Object.entries(schema.properties).filter(
			([key, value]) => BEDROCK_TOOL_PROPERTY_NAME_PATTERN.test(key) && isSchemaRecord(value),
		),
	);
}

function mergeMissingBedrockSchemaProperties(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (!(key in target)) target[key] = value;
	}
}

function intersectBedrockRequiredSets(projections: readonly BedrockObjectSchemaProjection[]): Set<string> {
	const common = new Set(projections[0]?.required ?? []);
	for (const projection of projections.slice(1)) {
		for (const key of common) if (!projection.required.has(key)) common.delete(key);
	}
	return common;
}

function projectBedrockObjectSchema(
	schema: Record<string, unknown>,
	root: Record<string, unknown>,
	visitedRefs = new Set<string>(),
): BedrockObjectSchemaProjection | undefined {
	if (schema.type !== undefined && schema.type !== "object") return undefined;

	let objectShapeProven = schema.type === "object" || [...BEDROCK_OBJECT_SCHEMA_KEYS].some((key) => key in schema);
	const properties = bedrockSchemaProperties(schema);
	const required = new Set(bedrockSchemaRequired(schema));

	if (typeof schema.$ref === "string") {
		if (visitedRefs.has(schema.$ref)) return undefined;
		const target = resolveBedrockLocalSchemaRef(root, schema.$ref);
		if (!isSchemaRecord(target)) return undefined;
		const nextVisitedRefs = new Set(visitedRefs);
		nextVisitedRefs.add(schema.$ref);
		const targetProjection = projectBedrockObjectSchema(target, root, nextVisitedRefs);
		if (!targetProjection) return undefined;
		objectShapeProven = true;
		mergeMissingBedrockSchemaProperties(properties, targetProjection.properties);
		for (const key of targetProjection.required) required.add(key);
	}

	for (const combinator of BEDROCK_ROOT_SCHEMA_COMBINATORS) {
		const branches = schema[combinator];
		if (branches === undefined) continue;
		if (!Array.isArray(branches) || branches.length === 0) return undefined;
		const branchProjections: BedrockObjectSchemaProjection[] = [];
		for (const branch of branches) {
			if (!isSchemaRecord(branch)) return undefined;
			const projection = projectBedrockObjectSchema(branch, root, visitedRefs);
			if (!projection) return undefined;
			branchProjections.push(projection);
		}
		objectShapeProven = true;
		for (const projection of branchProjections) {
			mergeMissingBedrockSchemaProperties(properties, projection.properties);
		}
		const combinatorRequired =
			combinator === "allOf"
				? new Set(branchProjections.flatMap((projection) => [...projection.required]))
				: intersectBedrockRequiredSets(branchProjections);
		for (const key of combinatorRequired) required.add(key);
	}

	return objectShapeProven ? { properties, required } : undefined;
}

/**
 * Bedrock requires an object root and Anthropic models on Bedrock reject root oneOf/anyOf/allOf
 * tool schemas. TypeBox unions used by tools such as write/edit therefore need a provider-only
 * object projection. The authoritative tool schema still validates every returned call after the
 * provider response, so broadening this wire description cannot broaden execution authority.
 */
function normalizeBedrockToolInputSchema(schema: unknown): NormalizedBedrockToolInputSchema {
	const detachedSchema = cloneBedrockSchemaValue(schema);
	if (!isSchemaRecord(detachedSchema)) return { schema: detachedSchema };
	// Never let a root combinator override an explicit non-object root type.
	if (detachedSchema.type !== undefined && detachedSchema.type !== "object") return { schema: detachedSchema };

	const combinators = BEDROCK_ROOT_SCHEMA_COMBINATORS.filter((key) => key in detachedSchema);
	// Collapsing multiple independent compositions into one object would describe neither schema.
	if (combinators.length > 1) return { schema: detachedSchema };
	if (combinators.length === 0) {
		if (!projectBedrockObjectSchema(detachedSchema, detachedSchema)) return { schema: detachedSchema };
		const normalized: Record<string, unknown> = { ...detachedSchema, type: "object" };
		if ("properties" in detachedSchema) {
			normalized.properties = bedrockSchemaProperties(detachedSchema);
			if ("required" in detachedSchema) {
				normalized.required = bedrockSchemaRequired(detachedSchema).filter((key) =>
					Object.hasOwn(normalized.properties as Record<string, unknown>, key),
				);
			}
		}
		return { schema: normalized };
	}

	const projection = projectBedrockObjectSchema(detachedSchema, detachedSchema);
	if (!projection) return { schema: detachedSchema };
	const required = [...projection.required].filter((key) => Object.hasOwn(projection.properties, key));
	const normalized: Record<string, unknown> = {
		...detachedSchema,
		type: "object",
		properties: projection.properties,
		required,
	};
	for (const combinator of BEDROCK_ROOT_SCHEMA_COMBINATORS) delete normalized[combinator];

	return {
		schema: normalized,
		constraintDescription: describeBedrockRootSchemaConstraint(detachedSchema, combinators),
	};
}

function isBedrockToolInputSchema(value: unknown): value is Record<string, unknown> {
	return (
		isSchemaRecord(value) &&
		value.type === "object" &&
		BEDROCK_ROOT_SCHEMA_COMBINATORS.every((combinator) => !(combinator in value))
	);
}

function describeBedrockRootSchemaConstraint(
	root: Record<string, unknown>,
	combinators: readonly (typeof BEDROCK_ROOT_SCHEMA_COMBINATORS)[number][],
): string {
	const preferred = combinators.includes("oneOf") ? "oneOf" : combinators.includes("anyOf") ? "anyOf" : "allOf";
	if (preferred === "allOf") {
		return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
	}

	const branches = root[preferred];
	const groups = Array.isArray(branches)
		? branches.flatMap((branch) => {
				if (!isSchemaRecord(branch)) return [];
				const projection = projectBedrockObjectSchema(branch, root);
				if (!projection) return [];
				const names = projection.required.size > 0 ? [...projection.required] : Object.keys(projection.properties);
				return names.length > 0 ? [`(${names.join(", ")})`] : [];
			})
		: [];
	const choice = preferred === "oneOf" ? "exactly one" : "at least one";
	const alternatives = groups.length > 0 ? `: ${groups.join(" or ")}` : "";
	return `Input constraint: provide parameters for ${choice} of the documented alternatives${alternatives}.`;
}

function isExplicitBedrockToolChoice(
	toolChoice: BedrockOptions["toolChoice"],
): toolChoice is { type: "tool"; name: string } {
	return typeof toolChoice === "object" && toolChoice !== null && toolChoice.type === "tool";
}

function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	toolNameMap: ToolNameMap,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				result.push({
					role: ConversationRole.USER,
					content,
				});
				break;
			}
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// Skip empty text blocks
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: {
									toolUseId: c.id,
									name: toolNameMap.toProviderName(c.name),
									input: sanitizeBedrockDocument(c.arguments),
								},
							});
							break;
						case "thinking": {
							if (c.redacted) {
								if (c.thinkingSignature?.trim()) {
									contentBlocks.push({
										reasoningContent: {
											redactedContent: base64ToBytes(c.thinkingSignature),
										},
									});
								}
								break;
							}

							// Bedrock Anthropic validates every replayed signed thinking block
							// byte-for-byte. Keep its opaque text unchanged across all history.
							if (
								supportsThinkingSignature(model) &&
								typeof c.thinkingSignature === "string" &&
								c.thinkingSignature.length > 0
							) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: {
											text: c.thinking,
											signature: c.thinkingSignature,
										},
									},
								});
								break;
							}

							// Skip empty thinking blocks
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// Only Anthropic models support the signature field in reasoningText.
							// For other models, we omit the signature to avoid errors like:
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// Signatures arrive after thinking deltas. If a partial or externally
								// persisted message lacks a signature, Bedrock rejects the replayed
								// reasoning block. Fall back to plain text, matching Anthropic.
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// Add current tool result with all content blocks combined
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: convertToolResultContent(m.content),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// Look ahead for consecutive toolResult messages
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: convertToolResultContent(nextMsg.content),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				continue;
		}
	}

	// Add cache point to the last user message for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	toolNameMap: ToolNameMap,
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = [];
	for (const tool of tools) {
		const normalizedInput = normalizeBedrockToolInputSchema(tool.parameters);
		if (!isBedrockToolInputSchema(normalizedInput.schema)) {
			throw new Error(`Bedrock tool "${tool.name}" requires an object input schema`);
		}
		bedrockTools.push({
			toolSpec: {
				name: toolNameMap.toProviderName(tool.name),
				description: normalizedInput.constraintDescription
					? `${normalizedInput.constraintDescription}\n\n${tool.description}`
					: tool.description,
				inputSchema: { json: normalizedInput.schema as DocumentType },
			},
		});
	}
	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (isExplicitBedrockToolChoice(toolChoice)) {
				const name = toolNameMap.toProviderName(toolChoice.name);
				if (!bedrockTools.some((tool) => tool.toolSpec?.name === name)) {
					throw new Error(`Bedrock tool "${toolChoice.name}" is not available in this request`);
				}
				bedrockToolChoice = { tool: { name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			return reason ? { stopReason: "error", errorMessage: reason } : { stopReason: "error" };
	}
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	if (typeof process === "undefined") {
		return options.region;
	}

	return options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function getConfiguredBedrockProfile(options: BedrockOptions): string | undefined {
	if (typeof process === "undefined") {
		return options.profile?.trim() || undefined;
	}

	return options.profile?.trim() || process.env.AWS_PROFILE?.trim() || undefined;
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasConfiguredProfile;
}

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, DocumentType> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock currently rejects the Claude thinking.display field.
		// Omit it there until the GovCloud Converse schema catches up.
		const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");
		const result: Record<string, DocumentType> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // Claude doesn't support xhigh, clamp to high
						max: 16384, // Claude doesn't support max, clamp to high
						ultra: 16384, // Ultra maps to Claude's strongest supported non-adaptive wire effort
					};

					// Custom budgets override defaults (extended levels are not in ThinkingBudgets, use high).
					const level =
						options.reasoning === "xhigh" || options.reasoning === "max" || options.reasoning === "ultra"
							? "high"
							: options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

function appendBase64Bytes(existingBase64: string | undefined, bytes: Uint8Array): string {
	if (!existingBase64) return bytesToBase64(bytes);

	const existing = base64ToBytes(existingBase64);
	const merged = new Uint8Array(existing.length + bytes.length);
	merged.set(existing);
	merged.set(bytes, existing.length);
	return bytesToBase64(merged);
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	return { source: { bytes: base64ToBytes(data) }, format };
}
