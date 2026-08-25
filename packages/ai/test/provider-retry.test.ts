import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendProviderRetryDirective,
	ProviderRateLimitError,
	retryProviderRequest,
} from "../src/utils/provider-retry.ts";

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

	it("emits countable retry telemetry for backoff attempts and exhaustion", async () => {
		vi.useFakeTimers();
		const events: Array<{ attempts: number; delayMs: number; status?: number; exhausted: boolean }> = [];
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "2000" }));

		const retryPromise = retryProviderRequest(request, {
			maxRetries: 1,
			onRetry: (event) => events.push(event),
		});
		const failurePromise = expect(retryPromise).rejects.toThrow(ProviderRateLimitError);

		// Allow microtask to process first request failure
		await vi.advanceTimersByTimeAsync(0);

		// First failure should trigger non-exhausted retry telemetry
		expect(events).toEqual([{ attempts: 1, delayMs: 1000, status: 429, exhausted: false }]);

		await vi.advanceTimersByTimeAsync(1000);

		// Second failure exhausts retries and emits exhaustion telemetry
		await failurePromise;
		expect(events).toEqual([
			{ attempts: 1, delayMs: 1000, status: 429, exhausted: false },
			{ attempts: 2, delayMs: 2000, status: 429, exhausted: true },
		]);
	});

	it("throws a first-class ProviderRateLimitError on exhausted rate limit retries preserving redacted retry directive", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerError(429, { "retry-after-ms": "5000" }));

		let failure: unknown;
		try {
			await retryProviderRequest(request, { maxRetries: 0 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderRateLimitError);
		expect((failure as ProviderRateLimitError).failureCode).toBe("rate_limit");
		expect((failure as ProviderRateLimitError).status).toBe(429);
		expect((failure as ProviderRateLimitError).attempts).toBe(1);
		expect((failure as ProviderRateLimitError).retryAfterMs).toBe(5000);
		expect(appendProviderRetryDirective((failure as Error).message, failure)).toContain(
			"Provider retry directive: retry after 5s.",
		);
	});

	it("throws a first-class ProviderRateLimitError on exhausted rate limit with structured OpenRouter availability metadata", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(providerAvailabilityError(429, { retryable: true, retry_after: 3.5 }));

		let failure: unknown;
		try {
			await retryProviderRequest(request, { maxRetries: 0 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderRateLimitError);
		expect((failure as ProviderRateLimitError).failureCode).toBe("rate_limit");
		expect((failure as ProviderRateLimitError).retryAfterMs).toBe(3500);
		expect(appendProviderRetryDirective((failure as Error).message, failure)).toContain(
			"Provider retry directive: retry after 3.5s.",
		);
	});

	it("records fallback exponential backoff delay in telemetry when server delay header is absent", async () => {
		vi.useFakeTimers();
		const events: Array<{ attempts: number; delayMs: number; status?: number; exhausted: boolean }> = [];
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(providerError(500)).mockResolvedValue("ok");

		const result = retryProviderRequest(request, {
			maxRetries: 1,
			telemetry: (event) => events.push(event),
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(events.length).toBe(1);
		expect(events[0].attempts).toBe(1);
		expect(events[0].status).toBe(500);
		expect(events[0].exhausted).toBe(false);
		expect(events[0].delayMs).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(events[0].delayMs);
		await expect(result).resolves.toBe("ok");
	});

	it("throws raw non-429 error on exhaustion without wrapping in ProviderRateLimitError", async () => {
		const rawError = providerError(500);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(rawError);

		let failure: unknown;
		try {
			await retryProviderRequest(request, { maxRetries: 0 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBe(rawError);
		expect((failure as Error).name).not.toBe("ProviderRateLimitError");
	});
});
