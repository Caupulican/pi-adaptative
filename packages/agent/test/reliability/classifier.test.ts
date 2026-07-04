import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/reliability/classifier.ts";

describe("classifyFailure", () => {
	it("classifies rate limits as retryable + rotate + fallback", () => {
		for (const msg of ["429 Too Many Requests", "rate_limit_error: slow down", "overloaded_error"]) {
			const c = classifyFailure({ message: msg });
			expect(c.retryable, msg).toBe(true);
			expect(c.shouldRotateCredential, msg).toBe(true);
			expect(c.shouldFallback, msg).toBe(true);
			expect(c.shouldCompact, msg).toBe(false);
		}
		expect(classifyFailure({ message: "429" }).reason).toBe("rate_limit");
		expect(classifyFailure({ message: "overloaded_error" }).reason).toBe("overloaded");
	});

	it("classifies server/network/stall errors as retryable + fallback, no rotate", () => {
		for (const msg of [
			"500 internal error",
			"502 Bad Gateway",
			"service unavailable",
			"network error: fetch failed",
			"connection lost",
			"socket hang up",
			"stream ended before message_stop",
			"stream stalled: no events for 30000ms",
			"Request timed out",
		]) {
			const c = classifyFailure({ message: msg });
			expect(c.retryable, msg).toBe(true);
			expect(c.shouldFallback, msg).toBe(true);
			expect(c.shouldRotateCredential, msg).toBe(false);
		}
		expect(classifyFailure({ message: "stream stalled: no events for 30000ms" }).reason).toBe("stream_stall");
	});

	it("classifies context overflow as compact-only", () => {
		const c = classifyFailure({ message: "prompt is too long", contextOverflow: true });
		expect(c).toMatchObject({
			reason: "context_overflow",
			retryable: false,
			shouldCompact: true,
			shouldRotateCredential: false,
			shouldFallback: false,
		});
	});

	it("classifies billing/quota as non-retryable but fallback-eligible", () => {
		for (const msg of ["insufficient_quota", "Monthly usage limit reached", "billing hard limit", "out of budget"]) {
			const c = classifyFailure({ message: msg });
			expect(c.retryable, msg).toBe(false);
			expect(c.shouldFallback, msg).toBe(true);
			expect(c.reason, msg).toBe("billing_or_quota");
		}
	});

	it("classifies auth failures as rotate + fallback, non-retryable", () => {
		for (const msg of ["401 Unauthorized", "invalid api key", "authentication_error"]) {
			const c = classifyFailure({ message: msg });
			expect(c).toMatchObject({
				reason: "auth",
				retryable: false,
				shouldRotateCredential: true,
				shouldFallback: true,
			});
		}
	});

	it("classifies aborts as terminal no-action", () => {
		expect(classifyFailure({ message: "user aborted", aborted: true })).toMatchObject({
			reason: "aborted",
			retryable: false,
			shouldCompact: false,
			shouldRotateCredential: false,
			shouldFallback: false,
		});
	});

	it("falls back to unknown with no actions", () => {
		expect(classifyFailure({ message: "the model declined to answer" })).toMatchObject({
			reason: "unknown",
			retryable: false,
			shouldFallback: false,
		});
	});

	it("precedence: overflow beats retryable patterns; billing beats rate-limit words", () => {
		expect(classifyFailure({ message: "429 too many tokens", contextOverflow: true }).reason).toBe(
			"context_overflow",
		);
		expect(classifyFailure({ message: "quota exceeded, rate limited" }).reason).toBe("billing_or_quota");
	});

	it("extracts retry-after hints in seconds and milliseconds", () => {
		expect(classifyFailure({ message: "rate limited, retry after 12s" }).retryAfterMs).toBe(12_000);
		expect(classifyFailure({ message: 'overloaded {"retryDelay":"7s"}' }).retryAfterMs).toBe(7_000);
		expect(classifyFailure({ message: "please retry in 2500 ms" }).retryAfterMs).toBe(2_500);
		expect(classifyFailure({ message: "500 internal error" }).retryAfterMs).toBeUndefined();
	});

	it("bare-substring matching for numeric status codes", () => {
		// 429 matches as bare substring
		expect(classifyFailure({ message: "code429" })).toMatchObject({
			reason: "rate_limit",
			retryable: true,
		});
		// 500 matches as bare substring
		expect(classifyFailure({ message: "abc500def" })).toMatchObject({
			reason: "server_error",
			retryable: true,
		});
		// 502 matches as bare substring
		expect(classifyFailure({ message: "x502y" })).toMatchObject({
			reason: "server_error",
			retryable: true,
		});
		// 501 must NOT match (not in the supported range)
		expect(classifyFailure({ message: "501 Not Implemented" })).toMatchObject({
			reason: "unknown",
			retryable: false,
		});
	});
});
