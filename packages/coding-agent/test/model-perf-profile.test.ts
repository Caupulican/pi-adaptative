import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StreamFn, type StreamIdleOptions, withStreamIdleWatchdog } from "@caupulican/pi-agent-core";
import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Api, AssistantMessage, Context, Model } from "@caupulican/pi-ai/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import {
	estimateContextPromptTokens,
	resolveAdaptiveStreamIdleOptions,
	updateModelPerfProfile,
	withModelPerfProfile,
} from "../src/core/models/perf-profile.ts";

const MODEL = { api: "openai-completions", provider: "faux", id: "slow-local" } as Model<Api>;
const CONTEXT = { messages: [{ role: "user", content: "hello" }] } as Context;
const BASE_IDLE: StreamIdleOptions = {
	connectMs: 500,
	firstProgressMs: 500,
	activeIdleMs: 500,
	quietIdleMs: 1_000,
};

function assistantMessage(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: inputTokens,
			output: outputTokens,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
			totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
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

function deferredHeadersSuccessfulStreamFn(firstTokenDelayMs: number, headerLeadMs = 0): StreamFn {
	return (model, _context, options) => {
		const inner = createAssistantMessageEventStream();
		setTimeout(() => {
			void options?.onResponse?.({ status: 200, headers: {} }, model);
		}, firstTokenDelayMs - headerLeadMs);
		setTimeout(() => {
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

function headersThenSilentStreamFn(): StreamFn {
	return (model, _context, options) => {
		const inner = createAssistantMessageEventStream();
		setTimeout(() => {
			void options?.onResponse?.({ status: 200, headers: {} }, model);
		}, 100);
		return inner;
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
		).toEqual({ firstProgressMs: 6_000, quietIdleMs: 6_000, connectMs: 9_000 });
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: BASE_IDLE,
				profile: first,
				promptTokens: 2_000,
				ceilingMs: 20_000,
			}),
		).toEqual({ firstProgressMs: 6_000, quietIdleMs: 6_000 });
	});

	it("expands first-progress time from measured prefill instead of a fixed remote cap", () => {
		const base = { ...BASE_IDLE, firstProgressMs: 500 };
		const profile = {
			prefillTokensPerSecond: 1_000,
			samples: 1,
			updatedAt: "2026-08-20T00:00:00.000Z",
		};

		expect(resolveAdaptiveStreamIdleOptions({ base, promptTokens: 2_000 })).toEqual({});
		expect(
			resolveAdaptiveStreamIdleOptions({
				base,
				profile,
				promptTokens: 2_000,
				ceilingMs: 20_000,
			}),
		).toMatchObject({ firstProgressMs: 6_000 });
	});

	it("ladders a censored first-progress stall once without contaminating a much smaller prompt", () => {
		const first = updateModelPerfProfile(undefined, {
			promptTokens: 100_000,
			firstProgressStallMs: 120_000,
			at: "2026-08-20T00:00:00.000Z",
		});

		expect(first).toMatchObject({
			firstProgressStall: { elapsedMs: 120_000, promptTokens: 100_000, consecutive: 1 },
			samples: 0,
		});
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: { ...BASE_IDLE, firstProgressMs: 120_000 },
				profile: first,
				promptTokens: 100_000,
				ceilingMs: 600_000,
			}),
		).toMatchObject({ firstProgressMs: 240_000 });
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: { ...BASE_IDLE, firstProgressMs: 120_000 },
				profile: first,
				promptTokens: 10_000,
				ceilingMs: 600_000,
			}),
		).toEqual({});

		const second = updateModelPerfProfile(first, {
			promptTokens: 100_000,
			firstProgressStallMs: 240_000,
			at: "2026-08-20T00:04:00.000Z",
		});
		expect(second?.firstProgressStall).toMatchObject({ elapsedMs: 240_000, consecutive: 2 });
		expect(
			resolveAdaptiveStreamIdleOptions({
				base: { ...BASE_IDLE, firstProgressMs: 120_000 },
				profile: second,
				promptTokens: 100_000,
				ceilingMs: 600_000,
			}),
		).toMatchObject({ firstProgressMs: 480_000 });

		const recovered = updateModelPerfProfile(second, {
			promptTokens: 100_000,
			completionTokens: 100,
			requestToFirstTokenMs: 180_000,
			firstTokenToDoneMs: 1_000,
			at: "2026-08-20T00:07:00.000Z",
		});
		expect(recovered?.firstProgressStall).toBeUndefined();
	});

	it("persists the first-progress retry ladder across store instances", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-perf-profile-"));
		dirs.push(agentDir);
		const options = {
			fingerprint: () => ({ id: "host-a", cpu: "cpu", cores: 8, totalMemGb: 32 }),
		};
		ModelAdaptationStore.forAgentDir(agentDir, options).recordPerfSample("xai/grok-4.6", {
			promptTokens: 130_000,
			firstProgressStallMs: 343_176,
			at: "2026-08-20T23:23:09.000Z",
		});

		expect(ModelAdaptationStore.forAgentDir(agentDir, options).get("xai/grok-4.6").perf).toMatchObject({
			firstProgressStall: {
				elapsedMs: 343_176,
				promptTokens: 130_000,
				consecutive: 1,
			},
			samples: 0,
		});
	});

	it("estimates the serialized context without materializing one accumulated prompt string", () => {
		let contentReads = 0;
		const content = {
			get text() {
				contentReads++;
				return `line\n${"x".repeat(32_000)}\ud800`;
			},
			type: "text",
		};
		const context = {
			systemPrompt: "system\tprompt",
			messages: [{ role: "user", content: [content], timestamp: 1 }],
			tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
		} as unknown as Context;
		const baseline = JSON.stringify({
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
		});
		contentReads = 0;

		expect(estimateContextPromptTokens(context)).toBe(Math.ceil(baseline.length / 4));
		expect(contentReads).toBe(1);
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
		).toEqual({ firstProgressMs: 6_000, quietIdleMs: 6_000, connectMs: 6_000 });
	});

	it("records the watchdog first-progress stall through the profiled inner stream", async () => {
		vi.useFakeTimers();
		const samples: Array<{ promptTokens?: number; firstProgressStallMs?: number }> = [];
		const profiled = withModelPerfProfile(headersThenSilentStreamFn(), {
			modelKey: () => "faux/stalled",
			recordSample: (_key, sample) => samples.push(sample),
			nowMs: () => Date.now(),
		});
		const wrapped = withStreamIdleWatchdog(profiled, {
			...BASE_IDLE,
			connectMs: 500,
			firstProgressMs: 500,
		});

		const stream = await wrapped(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(600);
		const result = await stream.result();

		expect(result.errorMessage).toContain("(first-progress phase)");
		expect(samples).toEqual([
			expect.objectContaining({ promptTokens: expect.any(Number), firstProgressStallMs: 500 }),
		]);
	});

	it("profiles the full prompt footprint including cache reads and writes", async () => {
		vi.useFakeTimers();
		const samples: Array<{ promptTokens?: number }> = [];
		const profiled = withModelPerfProfile(
			(model, _context, options) => {
				const inner = createAssistantMessageEventStream();
				setTimeout(() => {
					void options?.onResponse?.({ status: 200, headers: {} }, model);
				}, 100);
				setTimeout(() => {
					inner.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "o",
						partial: assistantMessage(100, 10, 800, 100),
					});
				}, 1_100);
				setTimeout(() => {
					inner.push({ type: "done", reason: "stop", message: assistantMessage(100, 10, 800, 100) });
				}, 1_200);
				return inner;
			},
			{
				modelKey: () => "faux/cached",
				recordSample: (_key, sample) => samples.push(sample),
				nowMs: () => Date.now(),
			},
		);

		const stream = await profiled(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(1_200);
		await stream.result();

		expect(samples).toMatchObject([{ promptTokens: 1_000 }]);
	});

	it("turns a premature inner end into a terminal profiling error", async () => {
		const profiled = withModelPerfProfile(
			() => {
				const inner = createAssistantMessageEventStream();
				inner.end();
				return inner;
			},
			{ modelKey: () => "faux/premature", recordSample: vi.fn() },
		);

		const result = await (await profiled(MODEL, CONTEXT, {})).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event");
	});

	it("turns rejected provider setup into a terminal profiling error", async () => {
		const profiled = withModelPerfProfile(
			async () => {
				throw new Error("socket setup failed");
			},
			{ modelKey: () => "faux/rejected", recordSample: vi.fn() },
		);

		const result = await (await profiled(MODEL, CONTEXT, {})).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event: socket setup failed");
	});

	it("turns iterator failures into terminal profiling errors", async () => {
		const profiled = withModelPerfProfile(
			() => {
				const inner = createAssistantMessageEventStream();
				inner[Symbol.asyncIterator] = () => ({
					next: async () => {
						throw new Error("iterator failed");
					},
				});
				return inner;
			},
			{ modelKey: () => "faux/iterator", recordSample: vi.fn() },
		);

		const result = await (await profiled(MODEL, CONTEXT, {})).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event: iterator failed");
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

	it("treats a tiny positive header lead after a long wait as deferred headers", async () => {
		vi.useFakeTimers();
		const samples: Array<{ headersToFirstTokenMs?: number; requestToFirstTokenMs?: number }> = [];
		const profiled = withModelPerfProfile(deferredHeadersSuccessfulStreamFn(2_500, 5), {
			modelKey: () => "faux/deferred-positive-gap",
			recordSample: (_key, sample) => samples.push(sample),
			nowMs: () => Date.now(),
		});

		const stream = await profiled(MODEL, CONTEXT, {});
		await vi.advanceTimersByTimeAsync(2_600);
		await stream.result();

		expect(samples).toMatchObject([{ requestToFirstTokenMs: 2_500 }]);
		expect(samples[0]?.headersToFirstTokenMs).toBeUndefined();
		expect(
			updateModelPerfProfile(undefined, { ...samples[0], promptTokens: 1_000 })?.prefillTokensPerSecond,
		).toBeCloseTo(400, 2);
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
