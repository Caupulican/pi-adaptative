import { createAssistantMessageEventStream } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StreamIdleOptions, withStreamIdleWatchdog } from "../../src/reliability/watchdogs.ts";
import type { StreamFn } from "../../src/types.ts";
import {
	makeErrorAssistantMessage,
	makeStartEvent,
	makeTextDeltaEvent,
	makeThinkingDeltaEvent,
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

// Distinct values per phase so a test failing on the wrong bound is unambiguous.
const BOUNDS: Partial<StreamIdleOptions> = { connectMs: 120_000, activeIdleMs: 30_000, quietIdleMs: 90_000 };

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
		expect(result.errorMessage).toMatch(/stream stalled/);
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("quiet phase (connected, no content blocks yet) uses quietIdleMs, not activeIdleMs", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, BOUNDS);
		const stream = await wrapped({} as never, {} as never, {});
		fake.inner.push(makeStartEvent());
		await vi.advanceTimersByTimeAsync(89_999); // far past activeIdleMs — must still be alive
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.signal()?.aborted).toBe(true);
		const result = await stream.result();
		expect(result.errorMessage).toMatch(/stream stalled: no events for 90000ms/);
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
