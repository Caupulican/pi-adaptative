import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendProviderRetryDirective,
	getProviderRetryDirective,
	ProviderRateLimitError,
	retryProviderRequest,
} from "../src/utils/provider-retry.ts";

const now = 1_800_000_000_000;
const resetHeader = "anthropic-ratelimit-unified-reset";

function failure(headers: Headers | Record<string, string>, status = 429): Error {
	return Object.assign(new Error(`Provider error: ${status}`), { status, headers });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("Claude subscription reset retry boundary", () => {
	it.each(["headers", "record"])("waits for the unified reset carried by %s", async (format) => {
		const record = { [resetHeader.toUpperCase()]: String((now + 5_250) / 1000) };
		const error = failure(format === "headers" ? new Headers(record) : record);
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("delivered");
		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(5_249);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("delivered");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ retryAfter: "2", resetMs: 5_000, delayMs: 5_000 },
		{ retryAfter: "8", resetMs: 5_000, delayMs: 8_000 },
	])("retains the longer boundary: $delayMs ms", ({ retryAfter, resetMs, delayMs }) => {
		expect(
			getProviderRetryDirective(
				failure({ "retry-after": retryAfter, [resetHeader]: String((now + resetMs) / 1000) }),
			),
		).toEqual({ retryAfterMs: delayMs });
	});

	it("preserves the subscription reset on exhausted retries and the string-only handoff", async () => {
		const error = failure({ [resetHeader]: String((now + 7_500) / 1000) });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		const rejected = await retryProviderRequest(request).catch((caught: unknown) => caught);
		expect(rejected).toBeInstanceOf(ProviderRateLimitError);
		expect(getProviderRetryDirective(rejected)).toEqual({ retryAfterMs: 7_500 });
		expect(appendProviderRetryDirective("429 rate limit", rejected)).toContain("retry after 7.5s");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("refuses an over-budget wait without sending an early retry", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(failure({ [resetHeader]: String((now + 120_000) / 1000) }));
		const result = retryProviderRequest(request, { maxRetries: 1 }).catch((caught: unknown) => caught);
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({
			message: expect.stringContaining("Server requested 120s retry delay (max: 60s)"),
		});
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("cancels the reset wait without issuing another request", async () => {
		const controller = new AbortController();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(failure({ [resetHeader]: String((now + 5_000) / 1000) }));
		const result = retryProviderRequest(request, { maxRetries: 1, signal: controller.signal }).catch(
			(caught: unknown) => caught,
		);
		await vi.advanceTimersByTimeAsync(1_000);
		controller.abort();
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not override the provider's explicit retry veto", async () => {
		const error = failure({ [resetHeader]: String((now + 5_000) / 1000), "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(appendProviderRetryDirective("429 rate limit", error)).toContain("do not retry");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each(["", "garbage", "1800000005seconds", "NaN", "Infinity", "1e309", "-1", "1800000000"])(
		"ignores invalid or elapsed unified reset %j while retaining ordinary guidance",
		(reset) => {
			expect(getProviderRetryDirective(failure({ [resetHeader]: reset, "retry-after": "2" }))).toEqual({
				retryAfterMs: 2_000,
			});
		},
	);

	it("does not infer quota rejection from a reset header on a different failure status", () => {
		expect(getProviderRetryDirective(failure({ [resetHeader]: String((now + 5_000) / 1000) }, 500))).toBeUndefined();
	});

	it("rounds a fractional millisecond reset upward so the timer cannot retry early", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(failure({ [resetHeader]: "1800000000.0015" }))
			.mockResolvedValue("delivered");
		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("delivered");
	});
});
