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
} from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";
import { generateTextToolProtocolPrimer, parseTextToolCalls } from "./utils/tool-repair/text-protocol.ts";

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
	if (!options?.textToolCallProtocol || !context.tools?.length) return context;
	const primer = generateTextToolProtocolPrimer(context.tools);
	if (!primer) return context;
	return {
		...context,
		systemPrompt: context.systemPrompt ? `${context.systemPrompt}\n\n${primer}` : primer,
	};
}

function withTextToolProtocolResult(
	stream: AssistantMessageEventStream,
	context: Context,
	options: StreamOptions | undefined,
): AssistantMessageEventStream {
	if (!options?.textToolCallProtocol || !context.tools?.length) return stream;
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
			const parsed = parseTextToolCalls(message.content[0].text, context.tools ?? []);
			if (parsed.calls.length === 0) {
				wrapped.push(event);
				continue;
			}
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
