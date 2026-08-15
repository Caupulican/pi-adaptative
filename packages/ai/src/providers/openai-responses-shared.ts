import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseOutputRefusal,
	ResponseOutputText,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { createToolNameMap, type ToolNameMap } from "../utils/tool-names.ts";
import { commitSuccessfulAssistantParse } from "./provider-runtime.ts";
import { joinTextContent, transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

const RESERVED_RESPONSES_TOOL_NAMES = new Set([
	"api_tool",
	"browser",
	"computer",
	"container",
	"file_search",
	"functions",
	"image_gen",
	"multi_tool_use",
	"python",
	"python_user_visible",
	"submodel_delegator",
	"terminal",
	"tool_search",
	"web",
]);

export function createOpenAIResponsesToolNameMap(tools: readonly Tool[]): ToolNameMap {
	return createToolNameMap(tools, { reservedNames: RESERVED_RESPONSES_TOOL_NAMES });
}

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	toolNameMap?: ToolNameMap;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	toolNameMap?: ToolNameMap;
}

export interface ConvertResponsesMessagesOptions {
	/** null omits image detail for transports such as ChatGPT Responses Lite. */
	imageDetail?: "auto" | null;
	toolNameMap?: ToolNameMap;
}

interface InputTokenDetailsWithOrchestration {
	cached_tokens?: number;
	cache_write_tokens?: number;
	orchestration_input_tokens?: number;
	orchestration_input_cached_tokens?: number;
}

interface OutputTokenDetailsWithOrchestration {
	orchestration_output_tokens?: number;
}

function createResponseInputImage(imageUrl: string, imageDetail: "auto" | null): ResponseInputImage {
	const inputImage: ResponseInputImage = {
		type: "input_image",
		detail: imageDetail ?? "auto",
		image_url: imageUrl,
	};
	if (imageDetail === null) {
		// Responses Lite requires the image detail property to be absent.
		delete (inputImage as Partial<ResponseInputImage>).detail;
	}
	return inputImage;
}

function applyFuguUltraPricing<TApi extends Api>(model: Model<TApi>, usage: Usage): void {
	if (model.provider !== "fugu" || model.id !== "fugu-ultra") return;

	// Sakana pricing has a higher Fugu Ultra tier once context exceeds 272K tokens.
	// Source: https://console.sakana.ai/pricing
	const highContext = usage.input + usage.cacheRead > 272_000;
	const inputRate = highContext ? 10 : 5;
	const outputRate = highContext ? 45 : 30;
	const cacheReadRate = highContext ? 1 : 0.5;
	usage.cost.input = (inputRate / 1_000_000) * usage.input;
	usage.cost.output = (outputRate / 1_000_000) * usage.output;
	usage.cost.cacheRead = (cacheReadRate / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = 0;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead;
}

export function applyOpenAIServiceTierPricing<TApi extends Api>(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<TApi>, "id">,
): void {
	const multiplier =
		serviceTier === "flex" ? 0.5 : serviceTier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

// =============================================================================
// Message conversion
// =============================================================================

export function buildResponsesInstructions(context: Context): string | undefined {
	return context.systemPrompt ? sanitizeSurrogates(context.systemPrompt) : undefined;
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const imageDetail = options?.imageDetail === undefined ? "auto" : options.imageDetail;

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return createResponseInputImage(`data:${item.mimeType};base64,${item.data}`, imageDetail);
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: options?.toolNameMap?.toProviderName(toolCall.name) ?? toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = joinTextContent(msg.content);
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push(
							createResponseInputImage(`data:${block.mimeType};base64,${block.data}`, imageDetail),
						);
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: options?.toolNameMap?.toProviderName(tool.name) ?? tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================

const REASONING_SUMMARY_DELIMITER_ONLY = /^<!--\s*-->$/;
const REASONING_SUMMARY_EMPTY_HTML_COMMENT = /(?:\n\s*)*<!--\s*-->\s*$/;

function isReasoningSummaryDelimiterOnly(text: string): boolean {
	return REASONING_SUMMARY_DELIMITER_ONLY.test(text.trim());
}

function cleanReasoningSummaryText(text: string): string {
	if (isReasoningSummaryDelimiterOnly(text)) return "";
	return text.replace(REASONING_SUMMARY_EMPTY_HTML_COMMENT, "").trimEnd();
}

function normalizeReasoningSummaryText(parts: readonly { text?: string }[] | undefined): string {
	return (parts ?? [])
		.map((part) => cleanReasoningSummaryText(part.text ?? ""))
		.filter((text) => text.trim().length > 0)
		.join("\n\n");
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson?: string }) | null = null;
	let currentReasoningSummaryPartText = "";
	let sawTerminalResponseEvent = false;
	let committedSuccessfulTerminal = false;
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const ensureMessageOutputTextPart = (): ResponseOutputText | undefined => {
		if (currentItem?.type !== "message") return undefined;
		const lastPart = currentItem.content[currentItem.content.length - 1];
		if (lastPart?.type === "output_text") return lastPart;
		const part: ResponseOutputText = { type: "output_text", text: "", annotations: [] };
		currentItem.content.push(part);
		return part;
	};
	const ensureMessageRefusalPart = (): ResponseOutputRefusal | undefined => {
		if (currentItem?.type !== "message") return undefined;
		const lastPart = currentItem.content[currentItem.content.length - 1];
		if (lastPart?.type === "refusal") return lastPart;
		const part: ResponseOutputRefusal = { type: "refusal", refusal: "" };
		currentItem.content.push(part);
		return part;
	};
	const backfillReasoningSignatures = (responseOutput: ResponseReasoningItem[]): void => {
		for (const item of responseOutput) {
			if (!item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({ ...storedItem, encrypted_content: item.encrypted_content });
		}
	};
	const finalizedOutputItemKeys = new Set<string>();
	const functionCallBlocksByItemId = new Map<string, ToolCall & { partialJson?: string }>();
	const functionCallBlocksByCallId = new Map<string, ToolCall & { partialJson?: string }>();
	const outputItemKeys = (item: { type: string; id?: string | null; call_id?: string }): string[] => {
		if (item.type === "reasoning" || item.type === "message") {
			return item.id ? [`${item.type}:${item.id}`] : [];
		}
		if (item.type === "function_call") {
			const keys: string[] = [];
			if (item.id) keys.push(`function_call:id:${item.id}`);
			if (item.call_id) keys.push(`function_call:call:${item.call_id}`);
			keys.push(`function_call:${item.call_id ?? ""}|${item.id ?? ""}`);
			return keys;
		}
		return [];
	};
	const registerFunctionCallBlock = (
		item: { id?: string | null; call_id?: string },
		block: ToolCall & { partialJson?: string },
	): void => {
		if (item.id) functionCallBlocksByItemId.set(item.id, block);
		if (item.call_id) functionCallBlocksByCallId.set(item.call_id, block);
	};
	const findFunctionCallBlock = (
		item: ResponseFunctionToolCall,
	): (ToolCall & { partialJson?: string }) | undefined => {
		const id = `${item.call_id}|${item.id}`;
		const byExactId = output.content.find(
			(candidate): candidate is ToolCall & { partialJson?: string } =>
				candidate.type === "toolCall" && candidate.id === id,
		);
		if (byExactId) return byExactId;
		if (item.id) {
			const byItemId = functionCallBlocksByItemId.get(item.id);
			if (byItemId) return byItemId;
		}
		if (item.call_id) {
			const byCallId = functionCallBlocksByCallId.get(item.call_id);
			if (byCallId) return byCallId;
		}
		if (currentBlock?.type === "toolCall") return currentBlock;
		return undefined;
	};
	const contentIndexOf = (block: AssistantMessage["content"][number]): number => output.content.indexOf(block);
	const applyCompletedOutputItem = (
		item: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall,
		emit: boolean,
	): void => {
		const keys = outputItemKeys(item);
		if (keys.some((key) => finalizedOutputItemKeys.has(key))) return;

		if (item.type === "reasoning") {
			if (item.summary) {
				item.summary = item.summary
					.map((part) => ({ ...part, text: cleanReasoningSummaryText(part.text ?? "") }))
					.filter((part) => part.text.trim().length > 0);
			}
			const summaryText = normalizeReasoningSummaryText(item.summary);
			const contentText = item.content?.map((part) => part.text).join("\n\n") || "";
			let block = item.id ? reasoningBlocksById.get(item.id) : undefined;
			if (!block && currentBlock?.type === "thinking") block = currentBlock;
			const isNew = !block;
			if (!block) {
				block = { type: "thinking", thinking: "" };
				output.content.push(block);
			}
			block.thinking = summaryText || contentText || block.thinking;
			block.thinkingSignature = JSON.stringify(item);
			if (item.id) reasoningBlocksById.set(item.id, block);
			if (emit) {
				const contentIndex = contentIndexOf(block);
				if (isNew) {
					stream.push({ type: "thinking_start", contentIndex, partial: output });
				}
				stream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: output,
				});
			}
			if (currentBlock === block) currentBlock = null;
			for (const key of keys) finalizedOutputItemKeys.add(key);
			return;
		}

		if (item.type === "message") {
			const text = (item.content ?? [])
				.map((part) => (part.type === "output_text" ? part.text : part.refusal))
				.join("");
			let block: TextContent | undefined;
			if (currentBlock?.type === "text") {
				block = currentBlock;
			} else if (item.id) {
				block = output.content.find(
					(candidate): candidate is TextContent =>
						candidate.type === "text" && parseTextSignature(candidate.textSignature)?.id === item.id,
				);
			}
			// xAI/Grok emits message.added + deltas, then function_call items, then
			// message.done / response.output. currentBlock has already moved to the
			// tool; the live text block must be reused or the same sentence is stored
			// twice (unsigned before tools, signed after).
			if (!block) {
				block = [...output.content]
					.reverse()
					.find(
						(candidate): candidate is TextContent =>
							candidate.type === "text" &&
							!candidate.textSignature &&
							(candidate.text === "" ||
								text === "" ||
								text.startsWith(candidate.text) ||
								candidate.text.startsWith(text)),
					);
			}
			const isNew = !block;
			if (!block) {
				block = { type: "text", text: "" };
				output.content.push(block);
			}
			if (text.length > 0) block.text = text;
			if (item.id) block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
			if (emit) {
				const contentIndex = contentIndexOf(block);
				if (isNew) {
					stream.push({ type: "text_start", contentIndex, partial: output });
				}
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
			}
			if (currentBlock === block) currentBlock = null;
			for (const key of keys) finalizedOutputItemKeys.add(key);
			return;
		}

		const id = `${item.call_id}|${item.id}`;
		let block = findFunctionCallBlock(item);
		const isNew = !block;
		if (!block) {
			block = {
				type: "toolCall",
				id,
				name: options?.toolNameMap?.toOriginalName(item.name) ?? item.name,
				arguments: {},
			};
			output.content.push(block);
		} else {
			block.id = id;
			block.name = options?.toolNameMap?.toOriginalName(item.name) ?? item.name;
		}
		block.arguments = parseStreamingJson(block.partialJson || item.arguments || "{}");
		delete block.partialJson;
		registerFunctionCallBlock(item, block);
		if (emit) {
			const contentIndex = contentIndexOf(block);
			if (isNew) {
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
			}
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
		if (currentBlock === block) currentBlock = null;
		for (const key of keys) finalizedOutputItemKeys.add(key);
	};
	const applyResponseOutput = (
		responseOutput: NonNullable<
			Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"]["output"]
		>,
	): void => {
		for (const item of responseOutput) {
			if (item.type === "reasoning" || item.type === "message" || item.type === "function_call") {
				applyCompletedOutputItem(item, true);
			}
		}
		if (!currentBlock) return;
		const contentIndex = blockIndex();
		if (currentBlock.type === "text") {
			stream.push({ type: "text_end", contentIndex, content: currentBlock.text, partial: output });
		} else if (currentBlock.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex,
				content: currentBlock.thinking,
				partial: output,
			});
		} else {
			delete currentBlock.partialJson;
			stream.push({ type: "toolcall_end", contentIndex, toolCall: currentBlock, partial: output });
		}
		currentBlock = null;
	};
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures((response.output ?? []).filter((item) => item.type === "reasoning"));
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as InputTokenDetailsWithOrchestration | undefined;
			const outputDetails = response.usage.output_tokens_details as OutputTokenDetailsWithOrchestration | undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			let inputTokens = Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens);
			let outputTokens = response.usage.output_tokens || 0;
			let cacheReadTokens = cachedTokens;
			const totalTokens = response.usage.total_tokens || 0;
			if (model.provider === "fugu") {
				const orchestrationInputTokens = inputDetails?.orchestration_input_tokens || 0;
				const orchestrationInputCachedTokens = inputDetails?.orchestration_input_cached_tokens || 0;
				const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens || 0;
				inputTokens += orchestrationInputTokens;
				cacheReadTokens += orchestrationInputCachedTokens;
				outputTokens += orchestrationOutputTokens;
			}
			const providerCost = (response.usage as { cost?: number }).cost ?? 0;
			output.usage = {
				// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input.
				// Sakana Fugu Ultra also reports billable orchestration tokens in token details fields.
				// Source: https://console.sakana.ai/pricing#usage-field-details
				input: inputTokens,
				output: outputTokens,
				cacheRead: cacheReadTokens,
				cacheWrite: cacheWriteTokens,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: providerCost },
			};
		}
		calculateCost(model, output.usage, {
			// response.usage is absent on some streams; this call sits outside the guard above.
			providerSuppliedTotal: Boolean((response.usage as { cost?: number } | undefined)?.cost),
		});
		applyFuguUltraPricing(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		applyResponseOutput(response.output ?? []);
		// Map status to stop reason
		output.stopReason = mapStopReason(response?.status);
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
		if (output.stopReason !== "error" && output.stopReason !== "aborted") {
			committedSuccessfulTerminal = true;
			commitSuccessfulAssistantParse(output);
		}
	};

	try {
		for await (const event of openaiStream) {
			if (event.type === "response.created") {
				output.responseId = event.response.id;
			} else if (event.type === "response.output_item.added") {
				const item = event.item;
				if (item.type === "reasoning") {
					currentItem = item;
					currentBlock = { type: "thinking", thinking: "" };
					currentReasoningSummaryPartText = "";
					output.content.push(currentBlock);
					if (item.id) reasoningBlocksById.set(item.id, currentBlock);
					stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "message") {
					currentItem = item;
					currentBlock = { type: "text", text: "" };
					if (item.id) {
						currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
					}
					output.content.push(currentBlock);
					stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "function_call") {
					currentItem = item;
					currentBlock = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: options?.toolNameMap?.toOriginalName(item.name) ?? item.name,
						arguments: {},
						partialJson: item.arguments || "",
					};
					output.content.push(currentBlock);
					registerFunctionCallBlock(item, currentBlock);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				}
			} else if (event.type === "response.reasoning_summary_part.added") {
				if (currentItem && currentItem.type === "reasoning") {
					currentItem.summary = currentItem.summary || [];
					currentItem.summary.push(event.part);
					currentReasoningSummaryPartText = event.part.text ?? "";
				}
			} else if (event.type === "response.reasoning_summary_text.delta") {
				if (currentItem?.type === "reasoning") {
					currentItem.summary = currentItem.summary || [];
					const lastPart = currentItem.summary[currentItem.summary.length - 1];
					if (lastPart) {
						lastPart.text += event.delta;
						currentReasoningSummaryPartText += event.delta;
					}
				}
			} else if (event.type === "response.reasoning_summary_part.done") {
				if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
					currentItem.summary = currentItem.summary || [];
					const lastPart = currentItem.summary[currentItem.summary.length - 1];
					const partText = cleanReasoningSummaryText(lastPart?.text ?? currentReasoningSummaryPartText);
					if (lastPart) {
						lastPart.text = partText;
					}
					if (partText.trim().length > 0) {
						const delta = `${partText}\n\n`;
						currentBlock.thinking += delta;
						stream.push({
							type: "thinking_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
					currentReasoningSummaryPartText = "";
				}
			} else if (event.type === "response.reasoning_text.delta") {
				if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
					currentBlock.thinking += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			} else if (event.type === "response.content_part.added") {
				if (currentItem?.type === "message") {
					currentItem.content = currentItem.content || [];
					// Filter out ReasoningText, only accept output_text and refusal
					if (event.part.type === "output_text" || event.part.type === "refusal") {
						currentItem.content.push(event.part);
					}
				}
			} else if (event.type === "response.output_text.delta") {
				if (currentItem?.type === "message" && currentBlock?.type === "text") {
					const lastPart = ensureMessageOutputTextPart();
					if (lastPart) {
						currentBlock.text += event.delta;
						lastPart.text += event.delta;
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: event.delta,
							partial: output,
						});
					}
				}
			} else if (event.type === "response.refusal.delta") {
				if (currentItem?.type === "message" && currentBlock?.type === "text") {
					const lastPart = ensureMessageRefusalPart();
					if (lastPart) {
						currentBlock.text += event.delta;
						lastPart.refusal += event.delta;
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: event.delta,
							partial: output,
						});
					}
				}
			} else if (event.type === "response.function_call_arguments.delta") {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					currentBlock.partialJson = (currentBlock.partialJson ?? "") + event.delta;
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
					stream.push({
						type: "toolcall_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			} else if (event.type === "response.function_call_arguments.done") {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					const previousPartialJson = currentBlock.partialJson;
					currentBlock.partialJson = event.arguments;
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);

					if (previousPartialJson !== undefined && event.arguments.startsWith(previousPartialJson)) {
						const delta = event.arguments.slice(previousPartialJson.length);
						if (delta.length > 0) {
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta,
								partial: output,
							});
						}
					}
				}
			} else if (event.type === "response.output_item.done") {
				const item = event.item;
				if (item.type === "reasoning" || item.type === "message" || item.type === "function_call") {
					applyCompletedOutputItem(item, true);
				}
			} else if (event.type === "response.completed" || event.type === "response.incomplete") {
				finalizeResponse(event.response);
			} else if (event.type === "error") {
				throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
			} else if (event.type === "response.failed") {
				sawTerminalResponseEvent = true;
				const error = event.response?.error;
				const details = event.response?.incomplete_details;
				const msg = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: "Unknown error (no error details in response)";
				throw new Error(msg);
			}
		}
	} catch (error) {
		if (committedSuccessfulTerminal) return;
		throw error;
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
