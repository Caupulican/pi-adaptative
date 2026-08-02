import { clampThinkingLevel } from "../model-capabilities.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImagesOptions,
	Model,
	ProviderResponse,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
} from "../types.ts";
import { createEmptyUsage } from "../usage.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import type { ProviderRetryOptions } from "../utils/provider-retry.ts";
import { buildBaseOptions } from "./simple-options.ts";

type ProviderRequestOptions = Pick<StreamOptions | ImagesOptions, "signal" | "timeoutMs">;
type ProviderRetrySource = Pick<StreamOptions | ImagesOptions, "signal" | "maxRetries" | "maxRetryDelayMs">;
type AssistantMessageOverrides = Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>;
type StreamingScratchField = "index" | "partialArgs" | "partialArgsComplete" | "partialJson" | "streamIndex";

export function createAssistantMessage<TApi extends Api>(
	model: Model<TApi>,
	overrides: AssistantMessageOverrides = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

export function buildClampedSimpleOptions<TApi extends Api>(
	model: Model<TApi>,
	options: SimpleStreamOptions | undefined,
): {
	base: StreamOptions;
	clampedReasoning: ReturnType<typeof clampThinkingLevel> | undefined;
} {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return {
		base: buildBaseOptions(model, options, apiKey),
		clampedReasoning: options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined,
	};
}

export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") return "long";
	return "short";
}

export async function applyProviderPayloadHook<TPayload, TModel>(
	payload: TPayload,
	model: TModel,
	hook?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>,
): Promise<TPayload> {
	const replacement = await hook?.(payload, model);
	return replacement === undefined ? payload : (replacement as TPayload);
}

export function createRetryFreeRequestOptions(
	options: ProviderRequestOptions | undefined,
	defaultTimeoutMs?: number,
): { signal?: AbortSignal; timeout?: number; maxRetries: 0 } {
	const timeout = options?.timeoutMs ?? defaultTimeoutMs;
	return {
		...(options?.signal ? { signal: options.signal } : {}),
		...(timeout !== undefined ? { timeout } : {}),
		maxRetries: 0,
	};
}

export function createProviderRetryOptions(
	options: ProviderRetrySource | undefined,
	defaultMaxRetries?: number,
): ProviderRetryOptions {
	return {
		maxRetries: options?.maxRetries ?? defaultMaxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		signal: options?.signal,
	};
}

export async function beginAssistantResponseStream<TModel>(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	response: { status: number; headers: Headers },
	model: TModel,
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>,
): Promise<void> {
	await onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	stream.push({ type: "start", partial: output });
}

export function completeAssistantStream(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	signal?: AbortSignal,
): void {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error("An unknown error occurred");
	}
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

export function terminateAssistantStreamWithError(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	signal: AbortSignal | undefined,
	error: unknown,
	options: {
		formatError: (error: unknown) => string;
		scratchFields?: readonly StreamingScratchField[];
	},
): void {
	if (options.scratchFields) {
		for (const block of output.content) {
			const scratchBlock = block as typeof block & Partial<Record<StreamingScratchField, unknown>>;
			for (const field of options.scratchFields) delete scratchBlock[field];
		}
	}
	output.stopReason = signal?.aborted ? "aborted" : "error";
	output.errorMessage = options.formatError(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

export function finishTextOrThinkingBlock(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	block: TextContent | ThinkingContent | null | undefined,
	contentIndex: number,
): void {
	if (!block) return;
	if (block.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		return;
	}
	stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
}

export function mapStandardThinkingEffort(
	model: Pick<Model<Api>, "thinkingLevelMap">,
	level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | undefined,
): string {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped;
	if (level === "minimal" || level === "low") return "low";
	if (level === "medium") return "medium";
	return "high";
}
