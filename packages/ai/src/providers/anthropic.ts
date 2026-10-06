import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
	isToolSchemaSearchDetails,
	measureToolSchemaDisclosureRequest,
	planToolSchemaDisclosure,
	searchDeferredToolSchemas,
	TOOL_SCHEMA_DISCLOSURE_BETA,
	TOOL_SCHEMA_SEARCH_NAME,
	type ToolSchemaDisclosurePlan,
} from "../tool-schema-disclosure.ts";
import type {
	AnthropicMessagesCompat,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { StreamingLineDecoder } from "../utils/streaming-lines.ts";
import { createToolNameMap, type ToolNameMap } from "../utils/tool-names.ts";

import { ANTHROPIC_MESSAGES_USER_AGENT } from "./anthropic-identity.ts";
import { AnthropicUsageAccumulator } from "./anthropic-usage.ts";
import { resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import {
	applyProviderPayloadHook,
	beginAssistantResponseStream,
	completeAssistantStream,
	createAssistantMessage,
	createProviderRetryOptions,
	createRetryFreeRequestOptions,
	executeWithAuthRecovery,
	mapStandardThinkingEffort,
	resolveCacheRetention,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";
import { joinTextContent, transformMessages } from "./transform-messages.ts";

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
	"ToolSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(joinTextContent(content));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	return {
		authFormat: model.compat?.authFormat ?? "api-key",
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimpleAnthropic()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimpleAnthropic()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasAuthorizationHeader(...headerSources: (Record<string, string> | undefined)[]): boolean {
	return headerSources.some((headers) =>
		Object.entries(headers ?? {}).some(
			([name, value]) => name.toLowerCase() === "authorization" && value.trim().length > 0,
		),
	);
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
	chars: number;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	const event: ServerSentEvent | null =
		!state.event && state.data.length === 0
			? null
			: {
					event: state.event,
					data: state.data.join("\n"),
					raw: [...state.raw],
				};
	state.event = null;
	state.data = [];
	state.raw = [];
	state.chars = 0;
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.chars += line.length + 1;
	if (state.chars > MAX_SSE_EVENT_CHARS) {
		throw new Error(`Anthropic SSE event exceeded the ${MAX_SSE_EVENT_CHARS} character limit`);
	}
	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [], chars: 0 };
	const lines = new StreamingLineDecoder(MAX_SSE_EVENT_CHARS);
	let complete = false;

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				complete = true;
				break;
			}

			for (const line of lines.push(decoder.decode(value, { stream: true }))) {
				const event = decodeSseLine(line, state);
				if (event) yield event;
			}
		}

		for (const line of lines.push(decoder.decode())) {
			const event = decodeSseLine(line, state);
			if (event) yield event;
		}
		const finalLine = lines.finish();
		if (finalLine !== undefined) {
			const event = decodeSseLine(finalLine, state);
			if (event) yield event;
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data.slice(0, 500));
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type !== sse.event) throw new Error("Anthropic SSE event discriminator mismatch");
			if (sawMessageEnd || (!sawMessageStart && event.type !== "message_start"))
				throw new Error("Anthropic stream has out-of-order message boundaries");
			if (event.type === "message_start") {
				if (sawMessageStart) throw new Error("Anthropic stream repeated message_start");
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
			const raw = sse.raw
				.slice(0, 4)
				.map((line) => line.slice(0, 125))
				.join("\\n");
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data.slice(0, 500)}; raw=${raw}`,
			);
		}
	}

	if (!sawMessageStart || !sawMessageEnd) {
		throw new Error("Anthropic stream ended without a complete message_start/message_stop sequence");
	}
}

function extractAnthropicHeaderValue(
	headers: Headers | Record<string, unknown> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	if ("get" in headers && typeof (headers as Headers).get === "function") {
		const val = (headers as Headers).get(name);
		return val === null ? undefined : val;
	}
	const target = name.toLowerCase();
	for (const [key, val] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === target) {
			if (typeof val === "string") return val;
			if (typeof val === "number") return String(val);
			if (Array.isArray(val) && typeof val[0] === "string") return val[0];
		}
	}
	return undefined;
}

function parseAnthropicHeaderFloat(
	headers: Headers | Record<string, unknown> | undefined,
	name: string,
): number | undefined {
	const val = extractAnthropicHeaderValue(headers, name);
	if (val === undefined) return undefined;
	const num = Number.parseFloat(val);
	return Number.isFinite(num) ? num : undefined;
}

function appendAnthropicSubscriptionRateLimitDiagnostics(
	output: AssistantMessage,
	headers: Headers | Record<string, unknown> | undefined,
): void {
	if (!headers) return;
	if (output.diagnostics?.some((d: AssistantMessageDiagnostic) => d.type === "anthropic_subscription_rate_limits")) {
		return;
	}
	const status = extractAnthropicHeaderValue(headers, "anthropic-ratelimit-unified-status");
	const reset = parseAnthropicHeaderFloat(headers, "anthropic-ratelimit-unified-reset");
	const reset5h = parseAnthropicHeaderFloat(headers, "anthropic-ratelimit-unified-5h-reset");
	const reset7d = parseAnthropicHeaderFloat(headers, "anthropic-ratelimit-unified-7d-reset");
	const fallback = extractAnthropicHeaderValue(headers, "anthropic-ratelimit-unified-fallback");
	const representativeClaim = extractAnthropicHeaderValue(headers, "anthropic-ratelimit-unified-representative-claim");
	const overageStatus = extractAnthropicHeaderValue(headers, "anthropic-ratelimit-unified-overage-status");
	const overageReset = parseAnthropicHeaderFloat(headers, "anthropic-ratelimit-unified-overage-reset");
	const overageDisabledReason = extractAnthropicHeaderValue(
		headers,
		"anthropic-ratelimit-unified-overage-disabled-reason",
	);

	if (
		status === undefined &&
		reset === undefined &&
		reset5h === undefined &&
		reset7d === undefined &&
		fallback === undefined &&
		representativeClaim === undefined &&
		overageStatus === undefined &&
		overageReset === undefined &&
		overageDisabledReason === undefined
	) {
		return;
	}

	const details: Record<string, unknown> = {
		...(status !== undefined ? { status } : {}),
		...(reset !== undefined ? { reset, resetsAt: reset } : {}),
		...(reset5h !== undefined ? { "5h-reset": reset5h, reset5h } : {}),
		...(reset7d !== undefined ? { "7d-reset": reset7d, reset7d } : {}),
		...(fallback !== undefined ? { fallback } : {}),
		...(representativeClaim !== undefined
			? { "representative-claim": representativeClaim, representativeClaim }
			: {}),
		...(overageStatus !== undefined ? { "overage-status": overageStatus, overageStatus } : {}),
		...(overageReset !== undefined ? { "overage-reset": overageReset, overageReset } : {}),
		...(overageDisabledReason !== undefined
			? { "overage-disabled-reason": overageDisabledReason, overageDisabledReason }
			: {}),
	};

	appendAssistantMessageDiagnostic(output, {
		type: "anthropic_subscription_rate_limits",
		timestamp: Date.now(),
		details,
	});
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createAssistantMessage(model);
		const usageAccumulator = new AnthropicUsageAccumulator(model, output.usage);
		const disclosureStartedAt = Date.now();
		let response: Response | undefined;

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			let apiKey = options?.apiKey;
			let copilotDynamicHeaders: Record<string, string> | undefined;
			const cacheRetention = options?.cacheRetention ?? resolveCacheRetention();
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			// A caller-owned SDK client also owns its default beta headers. Without a way to merge
			// those headers safely, keep its schemas eager instead of emitting an unusable deferred surface.
			const toolDisclosure = planToolSchemaDisclosure(
				options?.client ? { ...model, compat: { supportsToolSearch: false } } : model,
				context.tools ?? [],
			);

			const initClient = (key: string | undefined) => {
				if (!key && !hasAuthorizationHeader(model.headers, options?.headers)) {
					throw new Error(`No API key for provider: ${model.provider}`);
				}

				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				return createClient(
					model,
					key,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					toolDisclosure.enabled,
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
				);
			};

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const created = initClient(apiKey);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let toolNameMap = createToolNameMap(
				context.tools ?? [],
				isOAuth ? { normalizeName: toClaudeCodeName } : undefined,
			);
			let params = await applyProviderPayloadHook(
				buildParams(model, context, isOAuth, toolNameMap, toolDisclosure, options),
				model,
				options?.onPayload,
			);
			const requestOptions = createRetryFreeRequestOptions(options);
			const retryOptions = createProviderRetryOptions(options);

			const executeCreate = (c: Anthropic, p: typeof params) =>
				retryProviderRequest(
					() => c.messages.create({ ...p, stream: true }, requestOptions).asResponse(),
					retryOptions,
				);

			response = await executeWithAuthRecovery(model.provider, options, async (replacementKey) => {
				if (replacementKey) {
					apiKey = replacementKey;
					const created = initClient(apiKey);
					client = created.client;
					isOAuth = created.isOAuthToken;
					toolNameMap = createToolNameMap(
						context.tools ?? [],
						isOAuth ? { normalizeName: toClaudeCodeName } : undefined,
					);
					params = await applyProviderPayloadHook(
						buildParams(model, context, isOAuth, toolNameMap, toolDisclosure, options),
						model,
						options?.onPayload,
					);
				}
				return executeCreate(client, params);
			});
			appendAnthropicSubscriptionRateLimitDiagnostics(output, response.headers);
			await beginAssistantResponseStream(stream, output, response, model, options?.onResponse);

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];
			const startBlock = (block: Block, type: "text_start" | "thinking_start" | "toolcall_start"): void => {
				output.content.push(block);
				const contentIndex = output.content.length - 1;
				stream.push({ type, contentIndex, partial: output });
				// JSON/proxy consumers reconstruct content from deltas, not start-event snapshots.
				if (block.type !== "toolCall") {
					const delta = block.type === "text" ? block.text : block.thinking;
					if (delta)
						stream.push({
							type: block.type === "text" ? "text_delta" : "thinking_delta",
							contentIndex,
							delta,
							partial: output,
						});
				}
			};

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					// Initial input/cache counts remain available if this response aborts early.
					usageAccumulator.update(event.message.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text,
							index: event.index,
						};
						startBlock(block, "text_start");
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking,
							thinkingSignature: event.content_block.signature,
							index: event.index,
						};
						startBlock(block, "thinking_start");
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						startBlock(block, "thinking_start");
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: toolNameMap.toOriginalName(event.content_block.name),
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						startBlock(block, "toolcall_start");
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							// Signature deltas replace the authoritative value; they are not fragments.
							block.thinkingSignature = event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							if (block.partialJson.length > 0) {
								block.arguments = parseStreamingJson(block.partialJson);
							} else if (Object.keys(block.arguments).length > 0) {
								// A seed-only input has no JSON fragments; publish it once before toolcall_end.
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: JSON.stringify(block.arguments),
									partial: output,
								});
							}
							// Finalize in-place and strip the scratch buffer so replay only
							// carries parsed arguments.
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.stopReason = mapAnthropicStopReason(event.delta.stop_reason);
					}
					if (event.usage != null) {
						usageAccumulator.update(event.usage);
					}
				}
			}

			if (toolDisclosure.enabled) {
				appendAssistantMessageDiagnostic(output, {
					type: "tool_schema_disclosure",
					timestamp: Date.now(),
					details: {
						provider: model.provider,
						model: model.id,
						...measureToolSchemaDisclosureRequest(toolDisclosure, context.messages),
						providerResponseMs: Math.max(0, Date.now() - disclosureStartedAt),
					},
				});
			}
			completeAssistantStream(stream, output, options?.signal);
		} catch (error) {
			if (typeof error === "object" && error !== null && "headers" in error) {
				appendAnthropicSubscriptionRateLimitDiagnostics(output, (error as { headers?: Headers }).headers);
			}
			terminateAssistantStreamWithError(stream, output, options?.signal, error, {
				formatError: (caught) => (caught instanceof Error ? caught.message : JSON.stringify(caught)),
				scratchFields: ["index", "partialJson"],
			});
		} finally {
			// Cover response-hook failures before the SSE iterator acquires a reader as well.
			await response?.body?.cancel().catch(() => {});
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	return mapStandardThinkingEffort(model, level) as AnthropicEffort;
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey && !hasAuthorizationHeader(model.headers, options?.headers)) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning || options.reasoning === "off") {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

type AnthropicClientOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>;

function createAnthropicSdkClient(options: AnthropicClientOptions): Anthropic {
	return new Anthropic({ ...options, dangerouslyAllowBrowser: true });
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	useToolSchemaDisclosure: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (useToolSchemaDisclosure) betaFeatures.push(TOOL_SCHEMA_DISCLOSURE_BETA);
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (!apiKey && hasAuthorizationHeader(model.headers, optionsHeaders)) {
		const client = createAnthropicSdkClient({
			apiKey: null,
			authToken: null,
			baseURL: model.provider === "cloudflare-ai-gateway" ? resolveCloudflareBaseUrl(model) : model.baseUrl,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});
		return { client, isOAuthToken: false };
	}

	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = createAnthropicSdkClient({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model),
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Anthropic-compatible bearer endpoints and Copilot share the same SDK auth shape.
	if (getAnthropicCompat(model).authFormat === "bearer" || model.provider === "github-copilot") {
		const client = createAnthropicSdkClient({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	if (isOAuthToken(apiKey)) {
		const client = createAnthropicSdkClient({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": ANTHROPIC_MESSAGES_USER_AGENT,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const sessionAffinityHeaders: Record<string, string | null> =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const client = createAnthropicSdkClient({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	toolNameMap: ToolNameMap,
	toolDisclosure: ToolSchemaDisclosurePlan,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);
	const compat = getAnthropicCompat(model);
	const requestTools = toolDisclosure.enabled
		? context.tools
		: context.tools?.filter((tool) => tool.name !== TOOL_SCHEMA_SEARCH_NAME);
	if (
		!toolDisclosure.enabled &&
		options?.toolChoice &&
		typeof options.toolChoice !== "string" &&
		options.toolChoice.name === TOOL_SCHEMA_SEARCH_NAME
	) {
		throw new Error("Anthropic tool_search cannot be forced when deferred tool disclosure is unavailable.");
	}
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(
			context.messages,
			model,
			toolNameMap,
			toolDisclosure,
			cacheControl,
			compat.allowEmptySignature,
		),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// Subscription authentication requires its protocol identity.
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking (adaptive or budget-based),
	// and some newer Anthropic models reject it entirely.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (requestTools && requestTools.length > 0) {
		params.tools = convertTools(
			requestTools,
			toolNameMap,
			toolDisclosure,
			compat.supportsEagerToolInputStreaming,
			compat.supportsCacheControlOnTools ? cacheControl : undefined,
			options?.toolChoice && typeof options.toolChoice !== "string" ? options.toolChoice.name : undefined,
		);
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			const providerName = toolNameMap.toProviderName(options.toolChoice.name);
			params.tool_choice = { type: "tool", name: providerName };
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	toolNameMap: ToolNameMap,
	toolDisclosure: ToolSchemaDisclosurePlan,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							// Every signed block must replay unchanged, including older assistant turns.
							thinking: block.thinking,
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: toolNameMap.toProviderName(block.name),
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertToolResultContent(msg, toolNameMap, toolDisclosure),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertToolResultContent(nextMsg, toolNameMap, toolDisclosure),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertToolResultContent(
	message: ToolResultMessage,
	toolNameMap: ToolNameMap,
	toolDisclosure: ToolSchemaDisclosurePlan,
): NonNullable<ToolResultBlockParam["content"]> {
	if (
		message.toolName === TOOL_SCHEMA_SEARCH_NAME &&
		isToolSchemaSearchDetails(message.details) &&
		toolDisclosure.enabled
	) {
		const matches = searchDeferredToolSchemas(toolDisclosure, message.details.query, message.details.maxResults);
		if (matches.length > 0) {
			return matches.map((tool) => ({
				type: "tool_reference" as const,
				tool_name: toolNameMap.toProviderName(tool.name),
			}));
		}
		return "No matching deferred tools found.";
	}
	return convertContentBlocks(message.content);
}

function convertTools(
	tools: Tool[],
	toolNameMap: ToolNameMap,
	toolDisclosure: ToolSchemaDisclosurePlan,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
	forcedToolName?: string,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];
	const deferredToolNames = new Set(toolDisclosure.deferredToolNames);
	if (forcedToolName) deferredToolNames.delete(forcedToolName);
	const cacheControlIndex = cacheControl ? tools.findLastIndex((tool) => !deferredToolNames.has(tool.name)) : -1;

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };
		const deferred = toolDisclosure.enabled && deferredToolNames.has(tool.name);

		return {
			name: toolNameMap.toProviderName(tool.name),
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(deferred ? { defer_loading: true } : {}),
			...(cacheControl && index === cacheControlIndex ? { cache_control: cacheControl } : {}),
		};
	});
}

export function mapAnthropicStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			console.warn(`Unhandled Anthropic stop reason: ${reason}`);
			return "stop";
	}
}
