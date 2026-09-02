import { createAssistantMessageEventStream } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../../src/reliability/classifier.ts";
import { isStreamStallError, type StreamIdleOptions, withStreamIdleWatchdog } from "../../src/reliability/watchdogs.ts";
import type { StreamFn } from "../../src/types.ts";
import {
	makeErrorAssistantMessage,
	makeStartEvent,
	makeTextDeltaEvent,
	makeThinkingDeltaEvent,
	makeThinkingStartEvent,
} from "./stream-fixtures.ts";

// Minimal fake inner stream we can drive by hand. Emits nothing until told.
function makeFakeStreamFn() {
	const inner = createAssistantMessageEventStream();
	let receivedSignal: AbortSignal | undefined;
	const streamFn: StreamFn = (_model, _context, options) => {
		receivedSignal = options?.signal;
		return inner;
	};
	return { inner, streamFn, signal: () => receivedSignal };
}

function makeResponseAwareFakeStreamFn(responseDelayMs: number) {
	const inner = createAssistantMessageEventStream();
	let receivedSignal: AbortSignal | undefined;
	const streamFn: StreamFn = (model, _context, options) => {
		receivedSignal = options?.signal;
		setTimeout(() => {
			void options?.onResponse?.({ status: 200, headers: {} }, model);
		}, responseDelayMs);
		return inner;
	};
	return { inner, streamFn, signal: () => receivedSignal };
}

// Distinct values per phase so a test failing on the wrong bound is unambiguous.
const BOUNDS: Partial<StreamIdleOptions> = {
	connectMs: 120_000,
	firstProgressMs: 45_000,
	activeIdleMs: 30_000,
	quietIdleMs: 90_000,
};

describe("withStreamIdleWatchdog output repetition guard", () => {
	it("ends a response whose trailing window repeats the configured number of times, before any cap", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, {
			...BOUNDS,
			outputRepetitionRepeats: 4,
			outputRepetitionWindowChars: 40,
		});
		const stream = await wrapped({} as never, {} as never, {});
		const sentence = "Use id=step-2 with status=completed and evidence (not s2). ";
		let text = "";
		const partial = () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "x",
			provider: "x",
			model: "x",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		});
		fake.inner.push({ type: "start", partial: partial() });
		// Three repetitions are still fine; the fourth is the runaway.
		for (let index = 0; index < 3; index++) {
			text += sentence;
			fake.inner.push({ type: "text_delta", contentIndex: 0, delta: sentence, partial: partial() });
		}
		text += sentence;
		fake.inner.push({ type: "text_delta", contentIndex: 0, delta: sentence, partial: partial() });
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/output runaway: the last 40 characters repeated 4 times/);
		expect(fake.signal()?.aborted).toBe(true);
		expect(classifyFailure({ message: result.errorMessage ?? "" }).reason).toBe("runaway_output");
	});

	it("catches a loop inside a streaming tool call's arguments", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, {
			...BOUNDS,
			outputRepetitionRepeats: 4,
			outputRepetitionWindowChars: 20,
		});
		const stream = await wrapped({} as never, {} as never, {});
		let selector = "s1";
		const partial = () => ({
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "call-1",
					name: "task_steps",
					arguments: { action: "update", id: selector },
				},
			],
			api: "x",
			provider: "x",
			model: "x",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		});
		fake.inner.push({ type: "start", partial: partial() });
		for (let index = 0; index < 60; index++) {
			selector += "-1";
			fake.inner.push({ type: "toolcall_delta", contentIndex: 0, delta: "-1", partial: partial() });
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/output runaway/);
	});

	it("leaves ordinary long output alone", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, {
			...BOUNDS,
			outputRepetitionRepeats: 4,
			outputRepetitionWindowChars: 40,
		});
		const stream = await wrapped({} as never, {} as never, {});
		let text = "";
		const partial = () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "x",
			provider: "x",
			model: "x",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		});
		fake.inner.push({ type: "start", partial: partial() });
		for (let index = 0; index < 40; index++) {
			const delta = `line ${index}: a different sentence about item ${index * 7} every time.\n`;
			text += delta;
			fake.inner.push({ type: "text_delta", contentIndex: 0, delta, partial: partial() });
		}
		fake.inner.push({ type: "done", reason: "stop", message: partial() });
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});
});

describe("withStreamIdleWatchdog (phase-aware)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("aborts with a retryable stall error when no event arrives within connectMs", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		vi.advanceTimersByTime(120_000);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/stream stalled: no events for 120000ms \(connect phase\)/);
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("switches to the quiet bound when response headers arrive before the first stream event", async () => {
		const fake = makeResponseAwareFakeStreamFn(1_000);
		const wrapped = withStreamIdleWatchdog(fake.streamFn, {
			connectMs: 2_000,
			activeIdleMs: 1_000,
			quietIdleMs: 10_000,
		});
		const stream = await wrapped({} as never, {} as never, {});

		await vi.advanceTimersByTimeAsync(2_001);
		expect(fake.signal()?.aborted).toBe(false);

		fake.inner.push(makeStartEvent());
		fake.inner.push({ type: "done", reason: "stop", message: makeErrorAssistantMessage("stop", undefined) });
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("first-progress phase bounds connected streams with no generated content", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		fake.inner.push(makeStartEvent());
		await vi.advanceTimersByTimeAsync(44_999); // past activeIdleMs, but below firstProgressMs
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.signal()?.aborted).toBe(true);
		expect(isStreamStallError(fake.signal()?.reason)).toBe(true);
		expect(fake.signal()?.reason).toMatchObject({ phase: "first-progress", elapsedMs: 45_000 });
		const result = await stream.result();
		expect(result.errorMessage).toContain("stream stalled: no events for 45000ms (first-progress phase)");
	});

	it("does not treat transport headers or empty thinking frames as model progress", async () => {
		const fake = makeResponseAwareFakeStreamFn(1_000);
		const bounds = {
			connectMs: 120_000,
			firstProgressMs: 10_000,
			activeIdleMs: 30_000,
			quietIdleMs: 90_000,
		};
		const wrapped = withStreamIdleWatchdog(fake.streamFn, bounds);
		const stream = await wrapped({} as never, {} as never, {});
		await vi.advanceTimersByTimeAsync(1_000);
		fake.inner.push(makeStartEvent());
		fake.inner.push(makeThinkingStartEvent());

		await vi.advanceTimersByTimeAsync(9_999);
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.signal()?.aborted).toBe(true);
		const result = await stream.result();
		expect(result.errorMessage).toContain("no events for 10000ms (first-progress phase)");
	});

	it("unlocks the long quiet bound only after non-empty thinking progress", async () => {
		const fake = makeResponseAwareFakeStreamFn(1_000);
		const bounds = {
			connectMs: 120_000,
			firstProgressMs: 10_000,
			activeIdleMs: 30_000,
			quietIdleMs: 90_000,
		};
		const wrapped = withStreamIdleWatchdog(fake.streamFn, bounds);
		await wrapped({} as never, {} as never, {});
		await vi.advanceTimersByTimeAsync(1_000);
		fake.inner.push(makeStartEvent());
		fake.inner.push(makeThinkingStartEvent());
		fake.inner.push(makeThinkingDeltaEvent());

		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(80_000);
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("thinking blocks keep the quiet bound: silence after a thinking delta outlives activeIdleMs", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		await wrapped({} as never, {} as never, {});
		fake.inner.push(makeStartEvent());
		fake.inner.push(makeThinkingDeltaEvent());
		await vi.advanceTimersByTimeAsync(30_000); // activeIdleMs elapses — must NOT stall while thinking
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000); // total 90s silence → quiet stall
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("active phase (latest block is text) uses activeIdleMs", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		fake.inner.push(makeStartEvent());
		fake.inner.push(makeTextDeltaEvent());
		await vi.advanceTimersByTimeAsync(29_999);
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.signal()?.aborted).toBe(true);
		const result = await stream.result();
		expect(result.errorMessage).toMatch(/stream stalled: no events for 30000ms/);
	});

	it("switching thinking → text switches the bound from quiet to active", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		await wrapped({} as never, {} as never, {});
		fake.inner.push(makeThinkingDeltaEvent());
		fake.inner.push(makeTextDeltaEvent());
		await vi.advanceTimersByTimeAsync(30_000); // active bound now applies
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("resolver form re-resolves options on every request (live tuning)", async () => {
		const fake1 = makeFakeStreamFn();
		const live: Partial<StreamIdleOptions> = { connectMs: 50_000 };
		const wrapped1 = withStreamIdleWatchdog(fake1.streamFn, () => live);
		await wrapped1({} as never, {} as never, {});
		vi.advanceTimersByTime(49_999);
		expect(fake1.signal()?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(fake1.signal()?.aborted).toBe(true);

		live.connectMs = 10_000; // tune down; next request must pick it up
		const fake2 = makeFakeStreamFn();
		const wrapped2 = withStreamIdleWatchdog(fake2.streamFn, () => live);
		await wrapped2({} as never, {} as never, {});
		vi.advanceTimersByTime(10_000);
		expect(fake2.signal()?.aborted).toBe(true);
	});

	it("caller abort is not a stall: propagates the inner abort result untouched", async () => {
		const fake = makeFakeStreamFn();
		const ac = new AbortController();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, { signal: ac.signal });
		ac.abort();
		const aborted = makeErrorAssistantMessage("aborted", "user aborted");
		fake.inner.push({ type: "error", reason: "aborted", error: aborted });
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toMatch(/stream stalled/);
		expect(isStreamStallError(fake.signal()?.reason)).toBe(false);
	});

	it("settles as aborted when caller abort makes the inner stream end without a terminal event", async () => {
		const fake = makeFakeStreamFn();
		const ac = new AbortController();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, { signal: ac.signal });
		ac.abort();
		fake.inner.end();

		const timedOut = "timed-out" as const;
		const race = Promise.race([
			stream.result(),
			new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 1)),
		]);
		await vi.advanceTimersByTimeAsync(1);
		const result = await race;

		expect(result).not.toBe(timedOut);
		if (result === timedOut) return;
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("stream aborted before terminal event");
	});

	it("turns inner stream end without terminal event into an error result", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		fake.inner.push(makeStartEvent());
		fake.inner.push(makeTextDeltaEvent());
		fake.inner.end();
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event");
		expect(classifyFailure({ message: result.errorMessage ?? "" })).toMatchObject({
			reason: "stream_stall",
			retryable: true,
		});
	});

	it("converts rejected stream setup into a terminal retryable error", async () => {
		const wrapped = withStreamIdleWatchdog(async () => {
			throw new Error("socket connection was closed");
		}, BOUNDS);

		const result = await (await wrapped({} as never, {} as never, {})).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event: socket connection was closed");
		expect(classifyFailure({ message: result.errorMessage ?? "" }).retryable).toBe(true);
	});

	it("bounds a never-resolving async stream setup and resolves ready on the connect stall", async () => {
		const wrapped = withStreamIdleWatchdog(async () => await new Promise<never>(() => {}), {
			connectMs: 100,
			activeIdleMs: 1_000,
			quietIdleMs: 1_000,
		});

		const returned = wrapped({} as never, {} as never, {});
		expect(returned).toBeInstanceOf(Promise);

		await vi.advanceTimersByTimeAsync(100);
		const stream = await returned;
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream stalled: no events for 100ms (connect phase)");
	});

	it("settles a pre-aborted request without starting async stream setup", async () => {
		const setup = vi.fn(async () => await new Promise<never>(() => {}));
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		const wrapped = withStreamIdleWatchdog(setup, BOUNDS);

		const returned = wrapped({} as never, {} as never, { signal: controller.signal });
		expect(returned).toBeInstanceOf(Promise);

		const stream = await returned;
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("stream aborted before terminal event during stream setup");
		expect(setup).not.toHaveBeenCalled();
	});

	it("does not pump a stream whose async setup resolves after a connect stall", async () => {
		const inner = createAssistantMessageEventStream();
		const iterator = vi.spyOn(inner, Symbol.asyncIterator);
		let resolveSetup: ((stream: typeof inner) => void) | undefined;
		const wrapped = withStreamIdleWatchdog(
			() =>
				new Promise<typeof inner>((resolve) => {
					resolveSetup = resolve;
				}),
			{ connectMs: 100, activeIdleMs: 1_000, quietIdleMs: 1_000 },
		);

		const returned = wrapped({} as never, {} as never, {});
		await vi.advanceTimersByTimeAsync(100);
		const stream = await returned;
		await stream.result();

		resolveSetup?.(inner);
		await Promise.resolve();
		expect(iterator).not.toHaveBeenCalled();
	});

	it("converts an async-iterator failure into a terminal retryable error", async () => {
		const inner = createAssistantMessageEventStream();
		inner[Symbol.asyncIterator] = () => ({
			next: async () => {
				throw new Error("terminated");
			},
		});
		const wrapped = withStreamIdleWatchdog(() => inner, BOUNDS);

		const result = await (await wrapped({} as never, {} as never, {})).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended without terminal event: terminated");
		expect(classifyFailure({ message: result.errorMessage ?? "" }).retryable).toBe(true);
	});

	it("delivers a done event that was already queued before the pump started", async () => {
		const inner = createAssistantMessageEventStream();
		const done = makeErrorAssistantMessage("stop", undefined);
		inner.push(makeStartEvent());
		inner.push({ type: "done", reason: "stop", message: done });
		const wrapped = withStreamIdleWatchdog(() => inner, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result).toBe(done);
	});

	it("disarms after clean completion — no late aborts", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		const done = makeErrorAssistantMessage("stop", undefined);
		fake.inner.push({ type: "done", reason: "stop", message: done });
		await stream.result();
		vi.advanceTimersByTime(700_000);
		expect(fake.signal()?.aborted).toBe(false);
	});
});
