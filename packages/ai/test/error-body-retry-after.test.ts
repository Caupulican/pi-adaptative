import { describe, expect, it } from "vitest";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";

class FakeSdkError extends Error {
	status: number;
	headers: unknown;
	error: unknown;
	constructor(message: string, status: number, headers: unknown, body?: unknown) {
		super(message);
		this.status = status;
		this.headers = headers;
		this.error = body;
	}
}

describe("provider error retry-after surfacing", () => {
	it("carries a retry-after header into the formatted text as a stated delay", () => {
		const error = new FakeSdkError("429 Too Many Requests", 429, new Headers({ "retry-after": "12" }));
		const norm = normalizeProviderError(error);
		expect(norm.retryAfterMs).toBe(12_000);
		expect(formatProviderError(norm)).toBe("429 Too Many Requests; retry after 12 seconds.");
	});

	it("prefers retry-after-ms, reads plain-object headers and structured availability bodies, and rounds up", () => {
		expect(
			normalizeProviderError(new FakeSdkError("x", 429, { "Retry-After-Ms": "1500", "retry-after": "9" }))
				.retryAfterMs,
		).toBe(1_500);
		expect(
			formatProviderError(normalizeProviderError(new FakeSdkError("x", 429, { "retry-after-ms": "1500" }))),
		).toBe("x; retry after 2 seconds.");
		const structured = new FakeSdkError("slow down", 429, undefined, {
			error: { availability: { retry_after: 30 } },
		});
		expect(normalizeProviderError(structured).retryAfterMs).toBe(30_000);
	});

	it("leaves a message that already states its delay, and errors without one, untouched", () => {
		const stated = new FakeSdkError("429: retry after 5 seconds", 429, new Headers({ "retry-after": "60" }));
		expect(formatProviderError(normalizeProviderError(stated))).toBe("429: retry after 5 seconds");
		const plain = new FakeSdkError("500 boom", 500, new Headers());
		expect(normalizeProviderError(plain).retryAfterMs).toBeUndefined();
		expect(formatProviderError(normalizeProviderError(plain))).toBe("500 boom");
	});
});
