import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
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
import { AssistantMessageEventStream } from "./utils/event-stream.ts";
import {
	generateTextToolProtocolPrimer,
	normalizeTextToolProtocolOptions,
	parseTextToolCalls,
} from "./utils/tool-repair/text-protocol.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
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

interface TextProtocolEnvelopePattern {
	opener: string;
	closer: string;
}

// Priority order matters: a fenced "```tool_call" block must be matched before the shorter
// "```tool" opener it starts with, or the scanner would treat "_call" as the fence body.
const TEXT_PROTOCOL_ENVELOPE_PATTERNS: readonly TextProtocolEnvelopePattern[] = [
	{ opener: "<pi:call", closer: "</pi:call>" },
	{ opener: "<tool_call", closer: "</tool_call>" },
	{ opener: "```tool_call", closer: "```" },
	{ opener: "```tool", closer: "```" },
	{ opener: "```json", closer: "```" },
	{ opener: "<function", closer: "</function>" },
];

// All recognized openers start with one of these characters; texts without either can never
// contain (or be growing into) an envelope, so the scan can short-circuit immediately.
const TEXT_PROTOCOL_ENVELOPE_TRIGGER = /[<`]/;

function findEarliestEnvelopeOpener(
	text: string,
	fromIndex: number,
): { index: number; pattern: TextProtocolEnvelopePattern } | undefined {
	let best: { index: number; pattern: TextProtocolEnvelopePattern } | undefined;
	for (const pattern of TEXT_PROTOCOL_ENVELOPE_PATTERNS) {
		const index = text.indexOf(pattern.opener, fromIndex);
		if (index === -1) continue;
		if (!best || index < best.index) best = { index, pattern };
	}
	return best;
}

// The tail of `text` (from fromIndex to the end) is where new streamed characters land next.
// If that tail is itself a strict prefix of some opener, it might still grow into a full
// envelope tag, so it is not yet safe to reveal.
function longestPendingOpenerPrefixLength(text: string, fromIndex: number): number {
	const tail = text.slice(fromIndex);
	let longest = 0;
	for (const pattern of TEXT_PROTOCOL_ENVELOPE_PATTERNS) {
		const maxLength = Math.min(tail.length, pattern.opener.length - 1);
		for (let length = maxLength; length > 0; length--) {
			if (pattern.opener.startsWith(tail.slice(tail.length - length))) {
				longest = Math.max(longest, length);
				break;
			}
		}
	}
	return longest;
}

// Walks confirmed prose/envelope spans left to right over the FULL text seen so far and
// returns the PROSE-ONLY text that is safe to reveal live: a closed envelope span is
// permanently dropped (never later flushed as its own raw markup), while a still-open or
// merely-pending span halts the scan, leaving everything from there on unrevealed until the
// stream proves what it is. Recomputing over the whole text on every event (rather than
// tracking incremental cursor state) makes the scan self-correcting: a false-positive opener
// candidate (e.g. "```typescript") is released the moment more characters prove it does not
// match, and the result is always a prefix-extension of the previous call's result, so a
// simple length-based diff against the last computed value yields the next delta to forward.
function computeVisibleProseText(text: string): string {
	if (!TEXT_PROTOCOL_ENVELOPE_TRIGGER.test(text)) return text;
	let pos = 0;
	let visible = "";
	while (pos < text.length) {
		const match = findEarliestEnvelopeOpener(text, pos);
		if (!match) {
			const pendingLength = longestPendingOpenerPrefixLength(text, pos);
			return visible + text.slice(pos, text.length - pendingLength);
		}
		visible += text.slice(pos, match.index);
		const bodyStart = match.index + match.pattern.opener.length;
		const closerIndex = text.indexOf(match.pattern.closer, bodyStart);
		if (closerIndex === -1) return visible; // envelope still open: nothing further confirmed
		pos = closerIndex + match.pattern.closer.length; // envelope resolved+suppressed: keep scanning
	}
	return visible;
}

// Rewrites any text content block whose revealed prose is still behind its true streamed text
// so a forwarded event's `partial` snapshot never exposes held-back or suppressed envelope
// markup, even on events unrelated to the block being held (e.g. a later thinking/toolcall
// event still carries the earlier text block in its `partial.content`).
function redactHeldText(partial: AssistantMessage, revealedText: ReadonlyMap<number, string>): AssistantMessage {
	if (revealedText.size === 0) return partial;
	let changed = false;
	const content = partial.content.map((block, index) => {
		if (block.type !== "text") return block;
		const revealed = revealedText.get(index);
		if (revealed === undefined || block.text === revealed) return block;
		changed = true;
		return { ...block, text: revealed };
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
	revealedText: Map<number, string>,
): void {
	if (event.type === "error") {
		wrapped.push(event);
		return;
	}
	if (event.type === "text_start") {
		revealedText.set(event.contentIndex, "");
		wrapped.push({ ...event, partial: redactHeldText(event.partial, revealedText) });
		return;
	}
	if (event.type === "text_delta") {
		const block = event.partial.content[event.contentIndex];
		const fullText = block?.type === "text" ? block.text : "";
		const flushed = revealedText.get(event.contentIndex) ?? "";
		const visible = computeVisibleProseText(fullText);
		if (visible.length <= flushed.length) return; // held: possibly-envelope text never streams live
		revealedText.set(event.contentIndex, visible);
		wrapped.push({
			...event,
			delta: visible.slice(flushed.length),
			partial: redactHeldText(event.partial, revealedText),
		});
		return;
	}
	if (event.type === "text_end") {
		const flushed = revealedText.get(event.contentIndex) ?? "";
		const visible = computeVisibleProseText(event.content);
		if (visible.length > flushed.length) {
			// Catch up any newly-provable-safe tail (e.g. a suspected opener prefix that never
			// completed) so the deltas actually forwarded still sum to what text_end reports.
			revealedText.set(event.contentIndex, visible);
			wrapped.push({
				type: "text_delta",
				contentIndex: event.contentIndex,
				delta: visible.slice(flushed.length),
				partial: redactHeldText(event.partial, revealedText),
			});
		}
		const finalVisible = revealedText.get(event.contentIndex) ?? visible;
		wrapped.push({
			...event,
			content: finalVisible,
			partial: redactHeldText(event.partial, revealedText),
		});
		return;
	}
	wrapped.push({ ...event, partial: redactHeldText(event.partial, revealedText) });
}

function withTextToolProtocolResult(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: StreamOptions | undefined,
): AssistantMessageEventStream {
	const protocolOptions = normalizeTextToolProtocolOptions(options?.textToolCallProtocol);
	const tools = context.tools ?? [];
	if (!protocolOptions || tools.length === 0) return stream;
	const wrapped = new AssistantMessageEventStream();
	void (async () => {
		const revealedText = new Map<number, string>();
		for await (const event of stream) {
			if (event.type !== "done") {
				forwardTextProtocolStreamEvent(wrapped, event, revealedText);
				continue;
			}
			const message = event.message;
			const content: AssistantMessage["content"] = [];
			let callCount = 0;
			let textLength = 0;
			let failure: TextToolProtocolParseEvent["reason"] | undefined;
			for (const block of message.content) {
				if (block.type !== "text") {
					content.push(block);
					continue;
				}
				textLength += block.text.length;
				const parsed = parseTextToolCalls(block.text, tools);
				if (parsed.calls.length === 0) {
					if (parsed.failure) failure ??= parsed.failure;
					content.push(block);
					continue;
				}
				callCount += parsed.calls.length;
				if (parsed.text) content.push({ ...block, text: parsed.text });
				content.push(...parsed.calls);
			}
			if (callCount === 0) {
				if (failure) {
					await notifyTextToolProtocolParse(options, {
						provider: model.provider,
						model: model.id,
						variant: protocolOptions.variant ?? "tool-tag",
						status: "failed",
						callCount: 0,
						textLength,
						reason: failure,
					});
				}
				wrapped.push(event);
				continue;
			}
			await notifyTextToolProtocolParse(options, {
				provider: model.provider,
				model: model.id,
				variant: protocolOptions.variant ?? "tool-tag",
				status: "parsed",
				callCount,
				textLength,
			});
			wrapped.push({
				type: "done",
				reason: "toolUse",
				message: { ...message, content, stopReason: "toolUse" },
			});
		}
	})();
	return wrapped;
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
	const resolvedOptions = withEnvApiKey(model, options) as StreamOptions;
	const protocolContext = withTextToolProtocolContext(context, resolvedOptions);
	return withTextToolProtocolResult(
		provider.stream(model, protocolContext, resolvedOptions),
		model,
		context,
		resolvedOptions,
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
	const resolvedOptions = withEnvApiKey(model, options);
	const protocolContext = withTextToolProtocolContext(context, resolvedOptions);
	return withTextToolProtocolResult(
		provider.streamSimple(model, protocolContext, resolvedOptions),
		model,
		context,
		resolvedOptions,
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
