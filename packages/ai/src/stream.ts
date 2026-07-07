import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	Context,
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

function withTextToolProtocolContext(context: Context, options: StreamOptions | undefined): Context {
	const protocolOptions = normalizeTextToolProtocolOptions(options?.textToolCallProtocol);
	if (!protocolOptions || !context.tools?.length) return context;
	const primer = generateTextToolProtocolPrimer(context.tools, protocolOptions);
	if (!primer) return context;
	return {
		...context,
		systemPrompt: context.systemPrompt ? `${context.systemPrompt}\n\n${primer}` : primer,
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
	if (!protocolOptions || !context.tools?.length) return stream;
	const wrapped = new AssistantMessageEventStream();
	void (async () => {
		for await (const event of stream) {
			if (event.type !== "done") {
				wrapped.push(event);
				continue;
			}
			const message = event.message;
			if (message.content.length !== 1 || message.content[0]?.type !== "text") {
				wrapped.push(event);
				continue;
			}
			const text = message.content[0].text;
			const parsed = parseTextToolCalls(text, context.tools ?? []);
			if (parsed.calls.length === 0) {
				if (parsed.failure) {
					await notifyTextToolProtocolParse(options, {
						provider: model.provider,
						model: model.id,
						variant: protocolOptions.variant ?? "tool-tag",
						status: "failed",
						callCount: 0,
						textLength: text.length,
						reason: parsed.failure,
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
				callCount: parsed.calls.length,
				textLength: text.length,
			});
			const content = parsed.text ? [{ type: "text" as const, text: parsed.text }, ...parsed.calls] : parsed.calls;
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
		protocolContext,
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
		protocolContext,
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
