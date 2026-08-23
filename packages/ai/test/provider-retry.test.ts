import { afterEach, describe, expect, it, vi } from "vitest";
import { appendProviderRetryDirective, retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${String(status)}`), {
		status,
		headers: new Headers(headers),
	});
}

function providerRecordHeaderError(status: number | undefined, headers: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${String(status)}`), { status, headers });
}

function providerAvailabilityError(
	status: number,
	availability: { retryable: boolean; retry_after?: number | null },
	headers?: Record<string, string>,
): Error {
	return Object.assign(new Error(`Provider error: ${String(status)}`), {
		status,
		headers: new Headers(headers),
		error: { availability },
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

	it("honors retry guidance exposed as a plain header record", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerRecordHeaderError(429, { "retry-after-ms": "1500" }))
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });

		await vi.advanceTimersByTimeAsync(1499);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("honors structured OpenRouter availability retry guidance even on a normally terminal status", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerAvailabilityError(404, { retryable: true, retry_after: 1.25 }))
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });

		await vi.advanceTimersByTimeAsync(1249);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("never shortens conflicting structured and header retry boundaries", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(
				providerAvailabilityError(429, { retryable: true, retry_after: 7.25 }, { "retry-after": "2" }),
			)
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });

		await vi.advanceTimersByTimeAsync(7249);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("lets structured OpenRouter availability metadata veto a normally retryable status", async () => {
		const error = providerAvailabilityError(429, { retryable: false, retry_after: 2 });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
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

	it("enforces the server-delay bound before handing failure to the agent-level retry owner", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "120" }));

		await expect(retryProviderRequest(request, { maxRetries: 0, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 120s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("preserves the exact rejected provider boundary when it exceeds the local wait bound", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "79.542" }));

		let failure: unknown;
		try {
			await retryProviderRequest(request, { maxRetries: 0, maxRetryDelayMs: 60_000 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		expect(appendProviderRetryDirective((failure as Error).message, failure)).toContain(
			"Server requested 79.542s retry delay (max: 60s)",
		);
		expect(appendProviderRetryDirective((failure as Error).message, failure)).toContain(
			"Provider retry directive: do not retry.",
		);
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
