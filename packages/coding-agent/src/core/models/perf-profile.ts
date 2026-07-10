import type { StreamFn, StreamIdleOptions } from "@caupulican/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ProviderResponse,
} from "@caupulican/pi-ai";

const PERF_EWMA_ALPHA = 0.3;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFERRED_HEADERS_MAX_GAP_MS = 100;
const DEFERRED_HEADERS_MIN_REQUEST_MS = 1_000;
export const DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS = 30 * 60 * 1000;

export interface ModelPerfProfile {
	prefillTokensPerSecond?: number;
	decodeTokensPerSecond?: number;
	loadMs?: number;
	samples: number;
	updatedAt: string;
}

export interface ModelPerfSample {
	promptTokens?: number;
	completionTokens?: number;
	headersToFirstTokenMs?: number;
	requestToFirstTokenMs?: number;
	firstTokenToDoneMs?: number;
	loadMs?: number;
	at?: string;
}

export interface AdaptiveStreamIdleInput {
	base: StreamIdleOptions;
	profile?: ModelPerfProfile;
	promptTokens: number;
	ceilingMs?: number;
	localClass?: boolean;
}

export interface ModelPerfProfileStreamRecorder {
	modelKey: (model: Model<Api>) => string | undefined;
	recordSample: (modelKey: string, sample: ModelPerfSample) => void;
	nowMs?: () => number;
	nowIso?: () => string;
}

export function isModelPerfProfile(value: unknown): value is ModelPerfProfile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const samples = record.samples;
	return (
		(record.prefillTokensPerSecond === undefined || isPositiveFiniteNumber(record.prefillTokensPerSecond)) &&
		(record.decodeTokensPerSecond === undefined || isPositiveFiniteNumber(record.decodeTokensPerSecond)) &&
		(record.loadMs === undefined || isPositiveFiniteNumber(record.loadMs)) &&
		typeof samples === "number" &&
		Number.isInteger(samples) &&
		samples >= 0 &&
		typeof record.updatedAt === "string"
	);
}

export function hasUsableModelPerfSample(sample: ModelPerfSample): boolean {
	return (
		prefillRateFromSample(sample) !== undefined ||
		decodeRateFromSample(sample) !== undefined ||
		isPositiveFiniteNumber(sample.loadMs)
	);
}

export function updateModelPerfProfile(
	current: ModelPerfProfile | undefined,
	sample: ModelPerfSample,
	at: string = sample.at ?? new Date().toISOString(),
): ModelPerfProfile | undefined {
	const prefillRate = prefillRateFromSample(sample);
	const decodeRate = decodeRateFromSample(sample);
	const loadMs = isPositiveFiniteNumber(sample.loadMs) ? sample.loadMs : undefined;
	if (prefillRate === undefined && decodeRate === undefined && loadMs === undefined) return current;

	const previousSamples = current?.samples ?? 0;
	return {
		...(prefillRate !== undefined && {
			prefillTokensPerSecond: updateEwma(current?.prefillTokensPerSecond, prefillRate, previousSamples),
		}),
		...(prefillRate === undefined && current?.prefillTokensPerSecond !== undefined
			? { prefillTokensPerSecond: current.prefillTokensPerSecond }
			: {}),
		...(decodeRate !== undefined && {
			decodeTokensPerSecond: updateEwma(current?.decodeTokensPerSecond, decodeRate, previousSamples),
		}),
		...(decodeRate === undefined && current?.decodeTokensPerSecond !== undefined
			? { decodeTokensPerSecond: current.decodeTokensPerSecond }
			: {}),
		...(loadMs !== undefined && { loadMs: updateEwma(current?.loadMs, loadMs, previousSamples) }),
		...(loadMs === undefined && current?.loadMs !== undefined ? { loadMs: current.loadMs } : {}),
		samples: previousSamples + 1,
		updatedAt: at,
	};
}

export function resolveAdaptiveStreamIdleOptions(input: AdaptiveStreamIdleInput): Partial<StreamIdleOptions> {
	const profile = input.profile;
	const result: Partial<StreamIdleOptions> = {};
	const localConnectDefaultMs = input.localClass
		? Math.max(input.base.connectMs, input.base.quietIdleMs)
		: input.base.connectMs;
	const quietCeilingMs = Math.max(input.base.quietIdleMs, input.ceilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS);
	const connectCeilingMs = Math.max(localConnectDefaultMs, input.ceilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS);

	const expectedPrefillMs = expectedPrefillFromProfile(profile, input.promptTokens);
	if (expectedPrefillMs !== undefined) {
		const quietIdleMs = adaptiveBound(input.base.quietIdleMs, quietCeilingMs, expectedPrefillMs);
		if (quietIdleMs > input.base.quietIdleMs) result.quietIdleMs = quietIdleMs;
	}

	if (input.localClass) {
		const expectedConnectWorkMs =
			expectedPrefillMs !== undefined ? expectedPrefillMs + (profile?.loadMs ?? 0) : profile?.loadMs;
		const connectMs =
			expectedConnectWorkMs !== undefined
				? adaptiveBound(localConnectDefaultMs, connectCeilingMs, expectedConnectWorkMs)
				: localConnectDefaultMs;
		if (connectMs > input.base.connectMs) result.connectMs = connectMs;
	}

	return result;
}

export function estimateContextPromptTokens(context: Context): number {
	const serialized = JSON.stringify({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools,
	});
	if (!serialized) return 0;
	return Math.ceil(serialized.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function withModelPerfProfile(streamFn: StreamFn, recorder: ModelPerfProfileStreamRecorder): StreamFn {
	return async (model, context, streamOptions) => {
		const nowMs = recorder.nowMs ?? Date.now;
		const nowIso = recorder.nowIso ?? (() => new Date().toISOString());
		const requestStartedAtMs = nowMs();
		let responseHeadersAtMs: number | undefined;
		let firstTokenAtMs: number | undefined;
		const originalOnResponse = streamOptions?.onResponse;
		const outer = createAssistantMessageEventStream();
		let latest = emptyAssistantMessage(model);
		let inner: Awaited<ReturnType<StreamFn>>;
		try {
			inner = await streamFn(model, context, {
				...streamOptions,
				onResponse: async (response: ProviderResponse, responseModel: Model<Api>) => {
					responseHeadersAtMs ??= nowMs();
					await originalOnResponse?.(response, responseModel);
				},
			});
		} catch (error) {
			outer.push(perfStreamFailure(latest, streamOptions?.signal?.aborted === true, error));
			return outer;
		}

		void (async () => {
			let terminalPushed = false;
			try {
				for await (const event of inner) {
					latest = assistantMessageFromEvent(event);
					if (firstTokenAtMs === undefined && isFirstTokenEvent(event)) {
						firstTokenAtMs = nowMs();
					}
					if (event.type === "done") {
						terminalPushed = true;
						recordSuccessfulStreamSample({
							completionTokens: event.message.usage.output,
							doneAtMs: nowMs(),
							firstTokenAtMs,
							model,
							nowIso,
							promptTokens:
								event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite,
							recorder,
							requestStartedAtMs,
							responseHeadersAtMs,
						});
					} else if (event.type === "error") {
						terminalPushed = true;
					}
					outer.push(event);
					if (terminalPushed) return;
				}
				outer.push(perfStreamFailure(latest, streamOptions?.signal?.aborted === true));
			} catch (error) {
				outer.push(perfStreamFailure(latest, streamOptions?.signal?.aborted === true, error));
			}
		})();

		return outer;
	};
}

function assistantMessageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function perfStreamFailure(latest: AssistantMessage, aborted: boolean, error?: unknown): AssistantMessageEvent {
	const stopReason = aborted ? "aborted" : "error";
	const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`;
	return {
		type: "error",
		reason: stopReason,
		error: {
			...latest,
			stopReason,
			errorMessage: aborted
				? `stream aborted before terminal event${detail}`
				: `stream ended without terminal event${detail}`,
		},
	};
}

function recordSuccessfulStreamSample(input: {
	model: Model<Api>;
	recorder: ModelPerfProfileStreamRecorder;
	requestStartedAtMs: number;
	responseHeadersAtMs: number | undefined;
	firstTokenAtMs: number | undefined;
	doneAtMs: number;
	promptTokens: number;
	completionTokens: number;
	nowIso: () => string;
}): void {
	if (input.firstTokenAtMs === undefined) return;
	const modelKey = input.recorder.modelKey(input.model);
	if (!modelKey) return;
	const requestToFirstTokenMs = input.firstTokenAtMs - input.requestStartedAtMs;
	const sample: ModelPerfSample = {
		promptTokens: input.promptTokens,
		completionTokens: input.completionTokens,
		requestToFirstTokenMs,
		firstTokenToDoneMs: input.doneAtMs - input.firstTokenAtMs,
		at: input.nowIso(),
	};
	if (input.responseHeadersAtMs !== undefined) {
		const headersToFirstTokenMs = input.firstTokenAtMs - input.responseHeadersAtMs;
		const headersWereEffectivelyDeferred =
			requestToFirstTokenMs >= DEFERRED_HEADERS_MIN_REQUEST_MS &&
			headersToFirstTokenMs <= DEFERRED_HEADERS_MAX_GAP_MS;
		if (!headersWereEffectivelyDeferred) sample.headersToFirstTokenMs = headersToFirstTokenMs;
	}
	if (!hasUsableModelPerfSample(sample)) return;
	try {
		input.recorder.recordSample(modelKey, sample);
	} catch {
		// Perf profiling must never fail the user turn.
	}
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	return (
		(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
		event.delta.length > 0
	);
}

function expectedPrefillFromProfile(profile: ModelPerfProfile | undefined, promptTokens: number): number | undefined {
	const prefillRate = profile?.prefillTokensPerSecond;
	if (!profile || profile.samples < 1 || !prefillRate || promptTokens <= 0) return undefined;
	const expectedPrefillMs = (promptTokens / prefillRate) * 1000;
	return Number.isFinite(expectedPrefillMs) && expectedPrefillMs > 0 ? expectedPrefillMs : undefined;
}

function adaptiveBound(defaultMs: number, ceilingMs: number, expectedMs: number): number {
	return Math.min(Math.ceil(Math.max(defaultMs, expectedMs * 3)), ceilingMs);
}

function prefillRateFromSample(sample: ModelPerfSample): number | undefined {
	const durationMs = isPositiveFiniteNumber(sample.headersToFirstTokenMs)
		? sample.headersToFirstTokenMs
		: sample.requestToFirstTokenMs;
	return tokensPerSecond(sample.promptTokens, durationMs);
}

function decodeRateFromSample(sample: ModelPerfSample): number | undefined {
	return tokensPerSecond(sample.completionTokens, sample.firstTokenToDoneMs);
}

function tokensPerSecond(tokens: number | undefined, durationMs: number | undefined): number | undefined {
	if (!isPositiveFiniteNumber(tokens) || !isPositiveFiniteNumber(durationMs)) return undefined;
	return tokens / (durationMs / 1000);
}

function updateEwma(previous: number | undefined, next: number, previousSamples: number): number {
	if (previous === undefined || previousSamples === 0) return next;
	return previous * (1 - PERF_EWMA_ALPHA) + next * PERF_EWMA_ALPHA;
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
