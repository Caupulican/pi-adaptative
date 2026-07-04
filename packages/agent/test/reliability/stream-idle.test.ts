import { createAssistantMessageEventStream } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStreamIdleWatchdog } from "../../src/reliability/watchdogs.ts";
import type { StreamFn } from "../../src/types.ts";
import { makeErrorAssistantMessage, makeTextStartEvent } from "./stream-fixtures.ts";

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

describe("withStreamIdleWatchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("aborts and yields a retryable stall error when no event arrives within connectMs", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, { idleMs: 30_000, connectMs: 120_000 });
		const stream = await wrapped({} as never, {} as never, {});
		vi.advanceTimersByTime(120_000);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/stream stalled/);
		expect(fake.signal()?.aborted).toBe(true);
	});

	it("applies idleMs after the first event and forwards events unchanged", async () => {
		const fake = makeFakeStreamFn();
		const events: unknown[] = [];
		const wrapped = withStreamIdleWatchdog(fake.streamFn, { idleMs: 30_000, connectMs: 120_000 });
		const stream = await wrapped({} as never, {} as never, {});
		const consumed = (async () => {
			for await (const ev of stream) events.push(ev);
		})();
		fake.inner.push(makeTextStartEvent());
		await vi.advanceTimersByTimeAsync(29_999);
		fake.inner.push(makeTextStartEvent());
		await vi.advanceTimersByTimeAsync(29_999);
		expect(fake.signal()?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.signal()?.aborted).toBe(true);
		const result = await stream.result();
		expect(result.errorMessage).toMatch(/stream stalled: no events for 30000ms/);
		await consumed;
		expect(events.length).toBeGreaterThanOrEqual(2);
	});

	it("caller abort is not a stall: propagates the inner abort result untouched", async () => {
		const fake = makeFakeStreamFn();
		const ac = new AbortController();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, { idleMs: 30_000, connectMs: 120_000 });
		const stream = await wrapped({} as never, {} as never, { signal: ac.signal });
		ac.abort();
		// Inner provider reacts to abort by ending with an aborted message, as real providers do.
		const aborted = makeErrorAssistantMessage("aborted", "user aborted");
		fake.inner.push({ type: "error", reason: "aborted", error: aborted });
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toMatch(/stream stalled/);
	});

	it("disarms after clean completion — no late aborts", async () => {
		const fake = makeFakeStreamFn();
		const wrapped = withStreamIdleWatchdog(fake.streamFn, { idleMs: 30_000, connectMs: 120_000 });
		const stream = await wrapped({} as never, {} as never, {});
		const done = makeErrorAssistantMessage("stop", undefined); // stopReason "stop" == clean
		fake.inner.push({ type: "done", reason: "stop", message: done });
		await stream.result();
		vi.advanceTimersByTime(300_000);
		expect(fake.signal()?.aborted).toBe(false);
	});
});
