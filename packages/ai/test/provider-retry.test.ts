import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${String(status)}`), {
		status,
		headers: new Headers(headers),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("provider request retries", () => {
	it("retries retryable errors after the provider delay", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });

		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("honors a provider non-retryable override", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects server delays above the configured bound", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "120" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 120s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("aborts a retry wait without issuing another request", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "120" }));
		const result = retryProviderRequest(request, {
			maxRetries: 2,
			maxRetryDelayMs: 0,
			signal: controller.signal,
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
