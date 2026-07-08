import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StreamFn, type StreamIdleOptions, withStreamIdleWatchdog } from "@caupulican/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import {
	resolveAdaptiveStreamIdleOptions,
	updateModelPerfProfile,
	withModelPerfProfile,
} from "../src/core/models/perf-profile.ts";

const MODEL = { api: "openai-completions", provider: "faux", id: "slow-local" } as Model<Api>;
const CONTEXT = { messages: [{ role: "user", content: "hello" }] } as Context;
const BASE_IDLE: StreamIdleOptions = { connectMs: 500, activeIdleMs: 500, quietIdleMs: 1_000 };

function assistantMessage(inputTokens: number, outputTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function slowSuccessfulStreamFn(): StreamFn {
	return (model, _context, options) => {
		const inner = createAssistantMessageEventStream();
		setTimeout(() => {
			void options?.onResponse?.({ status: 200, headers: {} }, model);
		}, 100);
		setTimeout(() => {
			inner.push({ type: "text_delta", contentIndex: 0, delta: "o", partial: assistantMessage(1_000, 100) });
		}, 1_100);
		setTimeout(() => {
			inner.push({ type: "done", reason: "stop", message: assistantMessage(1_000, 100) });
		}, 2_100);
		return inner;
	};
}

function deferredHeadersSuccessfulStreamFn(firstTokenDelayMs: number): StreamFn {
	return (model, _context, options) => {
		const inner = createAssistantMessageEventStream();
		setTimeout(() => {
			void options?.onResponse?.({ status: 200, headers: {} }, model);
			inner.push({ type: "text_delta", contentIndex: 0, delta: "o", partial: assistantMessage(1_000, 100) });
		}, firstTokenDelayMs);
		setTimeout(() => {
			inner.push({ type: "done", reason: "stop", message: assistantMessage(1_000, 100) });
		}, firstTokenDelayMs + 100);
		return inner;
	};
}

function neverRespondingStreamFn(): { streamFn: StreamFn; signal: () => AbortSignal | undefined } {
	let receivedSignal: AbortSignal | undefined;
	return {
		streamFn: (_model, _context, options) => {
			receivedSignal = options?.signal;
			return createAssistantMessageEventStream();
		},
		signal: () => receivedSignal,
	};
}

describe("model perf profile", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("updates EWMA perf rates and resolves adaptive quiet bounds", () => {
		const first = updateModelPerfProfile(undefined, {
			promptTokens: 1_000,
			completionTokens: 100,
			headersToFirstTokenMs: 1_000,
			firstTokenToDoneMs: 2_000,
			loadMs: 1_000,
			at: "2026-07-08T00:00:00.000Z",
		});
		expect(first).toEqual({
			prefillTokensPerSecond: 1_000,
			decodeTokensPerSecond: 50,
			loadMs: 1_000,
			samples: 1,
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		expect(resolveAdaptiveStreamIdleOptions({ base: BASE_IDLE, promptTokens: 2_000 })).toEqual({});
		expect(resolveAdaptiveStreamIdleOptions({ base: BASE_IDLE, promptTokens: 2_000, localClass: true })).toEqual({
			connectMs: 1_000,
		});
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: first,
				promptTokens: 2_000,
				localClass: true,
				ceilingMs: 20_000,
			}),
		).toEqual({ quietIdleMs: 6_000, connectMs: 9_000 });
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: first,
				promptTokens: 2_000,
				ceilingMs: 20_000,
			}),
		).toEqual({ quietIdleMs: 6_000 });
	});

	it("records a successful stream sample so the next request uses profiled bounds", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "pi-perf-profile-"));
		dirs.push(agentDir);
		const store = ModelAdaptationStore.forAgentDir(agentDir, {
			fingerprint: () => ({ id: "host-a", cpu: "cpu", cores: 8, totalMemGb: 32 }),
		});
		const modelKey = "faux/slow-local";
		const profiled = withModelPerfProfile(slowSuccessfulStreamFn(), {
			modelKey: () => modelKey,
			recordSample: (key, sample) => {
				store.recordPerfSample(key, sample);
			},
			nowMs: () => Date.now(),
		});

		expect(
			resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: store.get(modelKey).perf,
				promptTokens: 2_000,
				ceilingMs: 20_000,
			}),
		).toEqual({});

		const stream = await profiled(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(2_100);
		await stream.result();

		expect(store.get(modelKey).perf).toMatchObject({
			prefillTokensPerSecond: 1_000,
			decodeTokensPerSecond: 100,
			samples: 1,
		});
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: store.get(modelKey).perf,
				promptTokens: 2_000,
				localClass: true,
				ceilingMs: 20_000,
			}),
		).toEqual({ quietIdleMs: 6_000, connectMs: 6_000 });
	});

	it("falls back to request-to-first-token timing when headers are deferred until the first token", async () => {
		vi.useFakeTimers();
		const agentDir = mkdtempSync(join(tmpdir(), "pi-perf-profile-"));
		dirs.push(agentDir);
		const store = ModelAdaptationStore.forAgentDir(agentDir, {
			fingerprint: () => ({ id: "host-a", cpu: "cpu", cores: 8, totalMemGb: 32 }),
		});
		const modelKey = "faux/slow-local";
		const profiled = withModelPerfProfile(deferredHeadersSuccessfulStreamFn(1_100), {
			modelKey: () => modelKey,
			recordSample: (key, sample) => {
				store.recordPerfSample(key, sample);
			},
			nowMs: () => Date.now(),
		});

		const stream = await profiled(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(1_200);
		await stream.result();

		expect(store.get(modelKey).perf?.prefillTokensPerSecond).toBeCloseTo(909.09, 2);
	});

	it("lets a profiled local deferred-headers stream outlive the stock connect bound", async () => {
		vi.useFakeTimers();
		const profiledLocal = withStreamIdleWatchdog(deferredHeadersSuccessfulStreamFn(2_500), () => ({
			...BASE_IDLE,
			...resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: {
					prefillTokensPerSecond: 1_000,
					samples: 1,
					updatedAt: "2026-07-08T00:00:00.000Z",
				},
				promptTokens: 1_000,
				localClass: true,
				ceilingMs: 20_000,
			}),
		}));

		const stream = await profiledLocal(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(2_600);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("keeps a remote no-profile no-headers stream on the stock connect bound", async () => {
		vi.useFakeTimers();
		const remote = neverRespondingStreamFn();
		const wrapped = withStreamIdleWatchdog(remote.streamFn, () => ({
			...BASE_IDLE,
			...resolveAdaptiveStreamIdleOptions({ base: BASE_IDLE, promptTokens: 1_000 }),
		}));

		const stream = await wrapped(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(BASE_IDLE.connectMs);
		const result = await stream.result();
		expect(result.errorMessage).toContain(`stream stalled: no events for ${BASE_IDLE.connectMs}ms (connect phase)`);
		expect(remote.signal()?.aborted).toBe(true);
	});
});
