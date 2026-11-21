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
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import {
	appendProviderRetryDirective,
	type ProviderRetryOptions,
	type ProviderRetryTelemetry,
} from "../utils/provider-retry.ts";
import { buildBaseOptions } from "./simple-options.ts";

type ProviderRequestOptions = Pick<StreamOptions | ImagesOptions, "signal" | "timeoutMs">;
type ProviderRetrySource = Pick<StreamOptions | ImagesOptions, "signal" | "maxRetries" | "maxRetryDelayMs"> & {
	onRetry?: (telemetry: ProviderRetryTelemetry) => void;
	telemetry?: (telemetry: ProviderRetryTelemetry) => void;
};
type AssistantMessageOverrides = Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>;
type StreamingScratchField = "index" | "partialArgs" | "partialArgsComplete" | "partialJson" | "streamIndex";

const committedSuccessfulParses = new WeakSet<AssistantMessage>();
const MAX_CACHE_POLICY_SCAN_BLOCKS = 2048;

function isSuccessfulStopReason(stopReason: AssistantMessage["stopReason"]): boolean {
	return stopReason !== "aborted" && stopReason !== "error";
}

/** Mark a fully parsed assistant message so a later iterator abort cannot rewrite it. */
export function commitSuccessfulAssistantParse(output: AssistantMessage): void {
	if (!isSuccessfulStopReason(output.stopReason)) return;
	committedSuccessfulParses.add(output);
}

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

export function getAnthropicCacheControl(
	cacheRetention: CacheRetention | undefined,
	compat: { cacheControlFormat?: string; supportsLongCacheRetention: boolean },
) {
	if (compat.cacheControlFormat !== "anthropic") return undefined;
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") return undefined;
	return {
		type: "ephemeral" as const,
		...(retention === "long" && compat.supportsLongCacheRetention ? { ttl: "1h" as const } : {}),
	};
}

export async function applyProviderPayloadHook<TPayload, TModel extends Pick<Model<Api>, "api" | "provider" | "id">>(
	payload: TPayload,
	model: TModel,
	hook?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>,
	capture?: ProviderCachePolicyCapture,
): Promise<TPayload> {
	const replacement = await hook?.(payload, model);
	const selected = replacement === undefined ? payload : (replacement as TPayload);
	if (capture) recordProviderCachePolicy(capture.message, model, selected, capture);
	return selected;
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
		...(options?.onRetry ? { onRetry: options.onRetry } : {}),
		...(options?.telemetry ? { telemetry: options.telemetry } : {}),
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

/**
 * Push the successful terminal event for a fully parsed assistant message.
 *
 * A late abort on `signal` must not discard that message: mid-stream abort is
 * the transport's job and is already converted by {@link terminateAssistantStreamWithError}.
 * Checking the signal here is a TOCTOU that drops completed-only / fast responses.
 */
export function completeAssistantStream(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	_signal?: AbortSignal,
): void {
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
	if (committedSuccessfulParses.has(output) && isSuccessfulStopReason(output.stopReason)) {
		completeAssistantStream(stream, output);
		return;
	}
	output.stopReason = signal?.aborted ? "aborted" : "error";
	const formattedError = options.formatError(error);
	output.errorMessage = signal?.aborted ? formattedError : appendProviderRetryDirective(formattedError, error);
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

export async function executeWithAuthRecovery<T>(
	providerId: string,
	options: StreamOptions | undefined,
	operation: (replacementKey?: string) => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const status = normalizeProviderError(error).status;
		if (status === 401 && options?.onAuthRejection) {
			const replacementKey = await options.onAuthRejection({
				providerId,
				status: 401,
				attempt: 1,
			});
			if (replacementKey) {
				return await operation(replacementKey);
			}
		}
		throw error;
	}
}

export interface ProviderCachePolicyCapture {
	message: AssistantMessage;
	accountScope?: string;
	cacheControlFormat: "anthropic" | "openai" | "unknown";
	supportsLongCacheRetention?: boolean;
}

export function recordProviderCachePolicy(
	message: AssistantMessage,
	model: Pick<Model<Api>, "api" | "provider" | "id">,
	payload: unknown,
	capture: Omit<ProviderCachePolicyCapture, "message">,
): void {
	try {
		const policy = providerCachePolicyFromPayload(model, payload, capture) ?? {
			kind: "unknown",
			wirePolicy: "invalid-selected-payload",
		};
		appendAssistantMessageDiagnostic(message, {
			type: "provider_cache_policy",
			timestamp: Date.now(),
			details: {
				api: model.api,
				provider: model.provider,
				modelId: model.id,
				...(capture.accountScope !== undefined ? { accountScope: capture.accountScope } : {}),
				...policy,
			},
		});
	} catch {}
}

export function providerCachePolicyFromPayload(
	model: Pick<Model<Api>, "api" | "provider" | "id">,
	payload: unknown,
	capture: Pick<ProviderCachePolicyCapture, "cacheControlFormat" | "supportsLongCacheRetention">,
): { kind: "fixed" | "automatic" | "disabled" | "unknown"; wirePolicy: string; ttlMs?: number } | undefined {
	if (payload === null || typeof payload !== "object") return;
	const body = payload as Record<string, unknown>;
	if (body.model !== undefined && body.model !== model.id) return;
	const controls = new Set<string>();
	let scanned = 0;
	let overflow = false;
	let hasBreakpoint = false;
	const collect = (value: unknown): void => {
		if (++scanned > MAX_CACHE_POLICY_SCAN_BLOCKS) {
			overflow = true;
			return;
		}
		if (value === null || typeof value !== "object") return;
		if ((value as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint !== undefined) hasBreakpoint = true;
		const control = (value as { cache_control?: unknown }).cache_control;
		if (control === undefined) return;
		if (control === null || typeof control !== "object") {
			controls.add("invalid");
			return;
		}
		const { type, ttl } = control as { type?: unknown; ttl?: unknown };
		controls.add(
			type !== "ephemeral"
				? "invalid"
				: ttl === undefined
					? "default"
					: ttl === "5m" || ttl === "1h"
						? ttl
						: "unsupported",
		);
	};
	collect(body);
	scan: for (const key of ["system", "tools", "messages", "input"]) {
		const values = body[key];
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			if (overflow) break scan;
			collect(value);
			if (value && typeof value === "object" && Array.isArray(value.content))
				for (const block of value.content) {
					if (overflow) break scan;
					collect(block);
				}
		}
	}
	const retention = body.prompt_cache_retention;
	const retentionTag =
		retention === undefined ? "unset" : retention === "24h" || retention === "in_memory" ? retention : "unsupported";
	const options = body.prompt_cache_options;
	let optionTag = "unset";
	let optionsKind: "automatic" | "disabled" | "unknown" = "unknown";
	if (options !== undefined && options !== null && typeof options === "object" && !Array.isArray(options)) {
		const value = options as Record<string, unknown>;
		const ttl =
			value.ttl === undefined ? "unset" : value.ttl === "30m" || value.ttl === "12h" ? value.ttl : "unsupported";
		const breakpoints =
			value.breakpoints === undefined || (Array.isArray(value.breakpoints) && value.breakpoints.length === 0)
				? "empty"
				: "unsupported";
		const valid = Object.keys(value).every((key) => ["mode", "ttl", "breakpoints"].includes(key));
		optionTag = JSON.stringify([
			value.mode === "implicit" || value.mode === "explicit" ? value.mode : "unsupported",
			ttl,
			breakpoints,
			valid,
		]);
		if (valid && breakpoints === "empty" && ttl !== "unsupported")
			optionsKind = value.mode === "explicit" ? "disabled" : value.mode === "implicit" ? "automatic" : "unknown";
	} else if (options !== undefined) optionTag = "invalid";
	if (overflow) controls.add("overflow");
	const format = capture.cacheControlFormat;
	const wirePolicy = JSON.stringify([
		format,
		[...controls].sort(),
		retentionTag,
		optionTag,
		typeof body.prompt_cache_key === "string",
		hasBreakpoint,
	]);
	if (controls.size) {
		const ttl = new Set(
			[...controls].map((value) =>
				value === "5m" || value === "default"
					? 300_000
					: value === "1h" && capture.supportsLongCacheRetention === true
						? 3_600_000
						: undefined,
			),
		);
		const known = format === "anthropic" && !hasBreakpoint && ttl.size === 1 && !ttl.has(undefined);
		return { kind: known ? "fixed" : "unknown", wirePolicy, ...(known ? { ttlMs: [...ttl][0] } : {}) };
	}
	if (format === "openai")
		return {
			kind: hasBreakpoint
				? "unknown"
				: options !== undefined
					? optionsKind
					: retentionTag === "unsupported"
						? "unknown"
						: "automatic",
			wirePolicy,
		};
	return { kind: format === "anthropic" ? "disabled" : "unknown", wirePolicy };
}
