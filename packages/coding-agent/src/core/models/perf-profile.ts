import type { StreamFn, StreamIdleOptions } from "@caupulican/pi-agent-core";
import {
	type Api,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ProviderResponse,
} from "@caupulican/pi-ai";

const PERF_EWMA_ALPHA = 0.3;
const CHARS_PER_TOKEN_ESTIMATE = 4;
export const DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS = 30 * 60 * 1000;

export interface ModelPerfProfile {
	prefillTokensPerSecond?: number;
	decodeTokensPerSecond?: number;
	samples: number;
	updatedAt: string;
}

export interface ModelPerfSample {
	promptTokens?: number;
	completionTokens?: number;
	headersToFirstTokenMs?: number;
	requestToFirstTokenMs?: number;
	firstTokenToDoneMs?: number;
	at?: string;
}

export interface AdaptiveStreamIdleInput {
	base: StreamIdleOptions;
	profile?: ModelPerfProfile;
	promptTokens: number;
	ceilingMs?: number;
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
		typeof samples === "number" &&
		Number.isInteger(samples) &&
		samples >= 0 &&
		typeof record.updatedAt === "string"
	);
}

export function hasUsableModelPerfSample(sample: ModelPerfSample): boolean {
	return prefillRateFromSample(sample) !== undefined || decodeRateFromSample(sample) !== undefined;
}

export function updateModelPerfProfile(
	current: ModelPerfProfile | undefined,
	sample: ModelPerfSample,
	at: string = sample.at ?? new Date().toISOString(),
): ModelPerfProfile | undefined {
	const prefillRate = prefillRateFromSample(sample);
	const decodeRate = decodeRateFromSample(sample);
	if (prefillRate === undefined && decodeRate === undefined) return current;

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
		samples: previousSamples + 1,
		updatedAt: at,
	};
}

export function resolveAdaptiveStreamIdleOptions(input: AdaptiveStreamIdleInput): Partial<StreamIdleOptions> {
	const profile = input.profile;
	const prefillRate = profile?.prefillTokensPerSecond;
	if (!profile || !prefillRate || profile.samples < 1 || input.promptTokens <= 0) return {};

	const expectedPrefillMs = (input.promptTokens / prefillRate) * 1000;
	if (!Number.isFinite(expectedPrefillMs) || expectedPrefillMs <= 0) return {};

	const targetMs = Math.ceil(Math.max(input.base.quietIdleMs, expectedPrefillMs * 3));
	const ceilingMs = Math.max(input.base.quietIdleMs, input.ceilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS);
	const quietIdleMs = Math.min(targetMs, ceilingMs);
	return quietIdleMs > input.base.quietIdleMs ? { quietIdleMs } : {};
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
		const inner = await streamFn(model, context, {
			...streamOptions,
			onResponse: async (response: ProviderResponse, responseModel: Model<Api>) => {
				responseHeadersAtMs ??= nowMs();
				await originalOnResponse?.(response, responseModel);
			},
		});
		const outer = createAssistantMessageEventStream();

		void (async () => {
			let terminalPushed = false;
			for await (const event of inner) {
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
						promptTokens: event.message.usage.input,
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
			outer.end();
		})();

		return outer;
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
	const sample: ModelPerfSample = {
		promptTokens: input.promptTokens,
		completionTokens: input.completionTokens,
		requestToFirstTokenMs: input.firstTokenAtMs - input.requestStartedAtMs,
		firstTokenToDoneMs: input.doneAtMs - input.firstTokenAtMs,
		at: input.nowIso(),
	};
	if (input.responseHeadersAtMs !== undefined) {
		sample.headersToFirstTokenMs = input.firstTokenAtMs - input.responseHeadersAtMs;
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

function prefillRateFromSample(sample: ModelPerfSample): number | undefined {
	const durationMs = sample.headersToFirstTokenMs ?? sample.requestToFirstTokenMs;
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
