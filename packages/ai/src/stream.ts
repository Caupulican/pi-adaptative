import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
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
							text: `Tool-call instructions for this conversation:\n${primer}\n\nDo not answer this instruction. Apply it to subsequent user requests. If the next user request asks to read a file, your first response must be a read tool call and nothing else.`,
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
		for await (const event of stream) {
			if (event.type !== "done") {
				wrapped.push(event);
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
