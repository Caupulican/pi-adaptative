import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey, getEnvAuthHeaders } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
	TextToolProtocolParseEvent,
} from "./types.ts";
import { combineAbortSignals } from "./utils/abort-signals.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";
import {
	generateTextToolProtocolPrimer,
	normalizeTextToolProtocolOptions,
	parseTextToolCalls,
} from "./utils/tool-repair/text-protocol.ts";
import { TextProtocolLiveFilter } from "./utils/tool-repair/text-protocol-live-filter.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

let textToolProtocolBatchSequence = 0;

// Once a complete call exists, a short bounded suffix preserves adjacent parallel envelopes while
// preventing a small model from spending its remaining output budget on unusable trailing prose.
// Envelope bodies themselves are never counted, so large write/edit arguments remain unbounded here.
const TEXT_TOOL_PROTOCOL_TRAILING_PROSE_LIMIT = 128;

function nextTextToolProtocolCallIdPrefix(): string {
	textToolProtocolBatchSequence =
		textToolProtocolBatchSequence >= Number.MAX_SAFE_INTEGER ? 1 : textToolProtocolBatchSequence + 1;
	return `text-tool-${textToolProtocolBatchSequence}`;
}

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
	return Object.entries(headers ?? {}).some(
		([name, value]) => name.toLowerCase() === "authorization" && value.trim().length > 0,
	);
}

function withEnvAuth<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	if (hasAuthorizationHeader(options?.headers)) return options;
	const envHeaders = getEnvAuthHeaders(model.provider);
	if (envHeaders) return { ...options, headers: { ...envHeaders, ...options?.headers } } as TOptions;
	const apiKey = getEnvApiKey(model.provider);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function withTextProtocolUserReminder(message: Message): Message {
	if (message.role !== "user") return message;
	const reminder =
		"Tool-use reminder: if this request asks to read a file, call exactly one tool named read before answering; do not guess file contents.";
	if (typeof message.content === "string") return { ...message, content: `${message.content}\n\n${reminder}` };
	return { ...message, content: [...message.content, { type: "text", text: reminder }] };
}

function withTextProtocolUserReminders(messages: readonly Message[]): Message[] {
	// Apply the same transformation to historical user turns. A reminder added only
	// to the live turn disappears when that turn becomes history, changing the prior
	// request prefix and defeating provider prompt-cache reuse.
	return messages.map(withTextProtocolUserReminder);
}

function withTextToolProtocolContext(context: Context, options: StreamOptions | undefined): Context {
	const protocolOptions = normalizeTextToolProtocolOptions(options?.textToolCallProtocol);
	if (!protocolOptions || !context.tools?.length) return context;
	const primer = generateTextToolProtocolPrimer(context.tools, protocolOptions);
	if (!primer) return context;
	const { tools: _tools, ...providerContext } = context;
	const messages = context.messages.length
		? [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: "Tool-call instructions for this conversation are defined in the system prompt above. Do not answer this instruction; apply the system-prompt tool-call format to subsequent user requests. If the next user request asks to read a file, your first response must be a read tool call and nothing else.",
						},
					],
					timestamp: 0,
				},
				...withTextProtocolUserReminders(context.messages),
			]
		: context.messages;
	return {
		...providerContext,
		systemPrompt: context.systemPrompt ? `${context.systemPrompt}\n\n${primer}` : primer,
		messages,
	};
}

async function notifyTextToolProtocolParse(
	options: StreamOptions | undefined,
	event: TextToolProtocolParseEvent,
): Promise<void> {
	try {
		await options?.onTextToolProtocolParse?.(event);
	} catch {
		// Parse telemetry must not change provider stream semantics.
	}
}

// Rewrites any text or thinking block whose revealed prose is still behind its true streamed
// content so a forwarded event's `partial` snapshot never exposes held-back envelope markup. Some
// OpenAI-compatible local servers classify the model's entire phone envelope as reasoning.
function redactHeldProtocolContent(
	partial: AssistantMessage,
	revealedContent: ReadonlyMap<number, string>,
): AssistantMessage {
	if (revealedContent.size === 0) return partial;
	let changed = false;
	const content = partial.content.map((block, index) => {
		const revealed = revealedContent.get(index);
		if (revealed === undefined) return block;
		if (block.type === "text" && block.text !== revealed) {
			changed = true;
			return { ...block, text: revealed };
		}
		if (block.type !== "thinking" || block.thinking === revealed) return block;
		changed = true;
		return { ...block, thinking: revealed };
	});
	return changed ? { ...partial, content } : partial;
}

// Forwards one non-"done" stream event, holding back streamed text that falls inside (or
// might still grow into) a text-protocol envelope so raw markup like "<pi:call" never reaches
// a live consumer. Prose outside envelopes is forwarded as soon as it is provably safe; the
// "done" event swap remains the sole authority for final content.
function forwardTextProtocolStreamEvent(
	wrapped: AssistantMessageEventStream,
	event: Exclude<AssistantMessageEvent, { type: "done" }>,
	revealedContent: Map<number, string>,
	liveFilters: Map<number, TextProtocolLiveFilter>,
): void {
	if (event.type === "error") {
		wrapped.push(event);
		return;
	}
	if (event.type === "text_start" || event.type === "thinking_start") {
		revealedContent.set(event.contentIndex, "");
		liveFilters.set(event.contentIndex, new TextProtocolLiveFilter());
		wrapped.push({ ...event, partial: redactHeldProtocolContent(event.partial, revealedContent) });
		return;
	}
	if (event.type === "text_delta" || event.type === "thinking_delta") {
		const flushed = revealedContent.get(event.contentIndex) ?? "";
		const filter = liveFilters.get(event.contentIndex) ?? new TextProtocolLiveFilter();
		liveFilters.set(event.contentIndex, filter);
		const visible = filter.advance(event.delta);
		if (visible.length <= flushed.length) return; // held: possibly-envelope text never streams live
		revealedContent.set(event.contentIndex, visible);
		wrapped.push({
			...event,
			delta: visible.slice(flushed.length),
			partial: redactHeldProtocolContent(event.partial, revealedContent),
		});
		return;
	}
	if (event.type === "text_end" || event.type === "thinking_end") {
		const flushed = revealedContent.get(event.contentIndex) ?? "";
		const filter = liveFilters.get(event.contentIndex) ?? new TextProtocolLiveFilter();
		liveFilters.set(event.contentIndex, filter);
		const visible = filter.finish(event.content);
		if (visible.length > flushed.length) {
			// Catch up any newly-provable-safe tail (e.g. a suspected opener prefix that never
			// completed) so the deltas actually forwarded still sum to what text_end reports.
			revealedContent.set(event.contentIndex, visible);
			wrapped.push(
				event.type === "text_end"
					? {
							type: "text_delta",
							contentIndex: event.contentIndex,
							delta: visible.slice(flushed.length),
							partial: redactHeldProtocolContent(event.partial, revealedContent),
						}
					: {
							type: "thinking_delta",
							contentIndex: event.contentIndex,
							delta: visible.slice(flushed.length),
							partial: redactHeldProtocolContent(event.partial, revealedContent),
						},
			);
		}
		const finalVisible = revealedContent.get(event.contentIndex) ?? visible;
		wrapped.push({
			...event,
			content: finalVisible,
			partial: redactHeldProtocolContent(event.partial, revealedContent),
		});
		return;
	}
	wrapped.push({ ...event, partial: redactHeldProtocolContent(event.partial, revealedContent) });
}

interface TextToolProtocolMessageProjection {
	message: AssistantMessage;
	callCount: number;
	textLength: number;
	failure?: TextToolProtocolParseEvent["reason"];
	protocolAttempted: boolean;
}

function projectTextToolProtocolMessage(
	message: AssistantMessage,
	model: Model<Api>,
	tools: readonly NonNullable<Context["tools"]>[number][],
	callIdPrefix: string,
): TextToolProtocolMessageProjection {
	const content: AssistantMessage["content"] = [];
	let callCount = 0;
	let textLength = 0;
	let failure: TextToolProtocolParseEvent["reason"] | undefined;
	let protocolAttempted = false;
	for (const block of message.content) {
		if (block.type !== "text" && (block.type !== "thinking" || block.redacted)) {
			content.push(block);
			continue;
		}
		const protocolText = block.type === "text" ? block.text : block.thinking;
		textLength += protocolText.length;
		const parsed = parseTextToolCalls(protocolText, tools, {
			callIdPrefix,
			callIndexOffset: callCount,
		});
		protocolAttempted ||= parsed.attempted;
		if (parsed.calls.length === 0) {
			if (parsed.failure) failure ??= parsed.failure;
			content.push(block);
			continue;
		}
		callCount += parsed.calls.length;
		if (parsed.text) {
			content.push(block.type === "text" ? { ...block, text: parsed.text } : { ...block, thinking: parsed.text });
		}
		content.push(...parsed.calls);
	}
	if (callCount > 0) {
		return {
			message: { ...message, content, stopReason: "toolUse" },
			callCount,
			textLength,
			failure,
			protocolAttempted,
		};
	}
	const hasVisibleText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
	const promoteThinking =
		model.reasoning === false &&
		!protocolAttempted &&
		!hasVisibleText &&
		message.content.some((block) => block.type === "thinking" && !block.redacted);
	return {
		message: promoteThinking
			? {
					...message,
					content: message.content.flatMap((block) => {
						if (block.type === "thinking" && !block.redacted) {
							return [{ type: "text" as const, text: block.thinking }];
						}
						if (block.type === "text" && block.text.length === 0) return [];
						return [block];
					}),
				}
			: message,
		callCount,
		textLength,
		failure,
		protocolAttempted,
	};
}

interface TextToolProtocolStreamControl {
	abortController: AbortController;
	cleanup(): void;
}

function withTextToolProtocolResult(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: StreamOptions | undefined,
	control?: TextToolProtocolStreamControl,
): AssistantMessageEventStream {
	const protocolOptions = normalizeTextToolProtocolOptions(options?.textToolCallProtocol);
	const tools = context.tools ?? [];
	if (!protocolOptions || tools.length === 0) return stream;
	const wrapped = new AssistantMessageEventStream();
	const callIdPrefix = nextTextToolProtocolCallIdPrefix();
	void (async () => {
		const revealedContent = new Map<number, string>();
		const liveFilters = new Map<number, TextProtocolLiveFilter>();
		let completedEnvelopeCount = 0;
		let trailingProseLength = 0;
		let completedProjection: TextToolProtocolMessageProjection | undefined;
		try {
			for await (const event of stream) {
				if (event.type !== "done") {
					if (event.type === "text_delta" || event.type === "thinking_delta") {
						if (completedProjection) trailingProseLength += event.delta.length;
					}
					forwardTextProtocolStreamEvent(wrapped, event, revealedContent, liveFilters);
					const observedEnvelopeCount = [...liveFilters.values()].reduce(
						(total, filter) => total + filter.completedEnvelopeCount,
						0,
					);
					if (observedEnvelopeCount > completedEnvelopeCount && "partial" in event) {
						completedEnvelopeCount = observedEnvelopeCount;
						const projection = projectTextToolProtocolMessage(event.partial, model, tools, callIdPrefix);
						if (projection.callCount > 0) {
							completedProjection = projection;
							trailingProseLength = 0;
						}
					}
					const holdingPotentialEnvelope = [...liveFilters.values()].some(
						(filter) => filter.holdingPotentialEnvelope,
					);
					if (
						completedProjection &&
						trailingProseLength > TEXT_TOOL_PROTOCOL_TRAILING_PROSE_LIMIT &&
						!holdingPotentialEnvelope &&
						control
					) {
						control.abortController.abort("text-tool-protocol-call-complete");
						await notifyTextToolProtocolParse(options, {
							provider: model.provider,
							model: model.id,
							variant: protocolOptions.variant ?? "tool-tag",
							status: "parsed",
							callCount: completedProjection.callCount,
							textLength: completedProjection.textLength,
						});
						wrapped.push({ type: "done", reason: "toolUse", message: completedProjection.message });
						return;
					}
					continue;
				}
				const projection = projectTextToolProtocolMessage(event.message, model, tools, callIdPrefix);
				if (projection.callCount === 0) {
					if (projection.failure) {
						await notifyTextToolProtocolParse(options, {
							provider: model.provider,
							model: model.id,
							variant: protocolOptions.variant ?? "tool-tag",
							status: "failed",
							callCount: 0,
							textLength: projection.textLength,
							reason: projection.failure,
						});
					}
					wrapped.push({ ...event, message: projection.message });
					continue;
				}
				await notifyTextToolProtocolParse(options, {
					provider: model.provider,
					model: model.id,
					variant: protocolOptions.variant ?? "tool-tag",
					status: "parsed",
					callCount: projection.callCount,
					textLength: projection.textLength,
				});
				wrapped.push({ type: "done", reason: "toolUse", message: projection.message });
			}
		} finally {
			control?.cleanup();
		}
	})();
	return wrapped;
}

function startTextToolProtocolStream<TOptions extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: TOptions | undefined,
	startProviderStream: (
		providerContext: Context,
		providerOptions: TOptions | undefined,
	) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const protocolOptions = normalizeTextToolProtocolOptions(options?.textToolCallProtocol);
	if (!protocolOptions || !context.tools?.length) return startProviderStream(context, options);
	const abortController = new AbortController();
	const combined = combineAbortSignals([options?.signal, abortController.signal]);
	const providerOptions = { ...options, signal: combined.signal } as TOptions;
	const protocolContext = withTextToolProtocolContext(context, providerOptions);
	return withTextToolProtocolResult(
		startProviderStream(protocolContext, providerOptions),
		model,
		context,
		providerOptions,
		{ abortController, cleanup: combined.cleanup },
	);
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	const resolvedOptions = withEnvAuth(model, options);
	return startTextToolProtocolStream(model, context, resolvedOptions, (providerContext, providerOptions) =>
		provider.stream(model, providerContext, providerOptions),
	);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	const resolvedOptions = withEnvAuth(model, options);
	return startTextToolProtocolStream(model, context, resolvedOptions, (providerContext, providerOptions) =>
		provider.streamSimple(model, providerContext, providerOptions),
	);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
