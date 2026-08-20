import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/reliability/classifier.ts";
import { PROVIDER_FAILURE_SIGNATURES } from "../../src/reliability/provider-signatures.ts";

const XAI_CAPACITY_ERROR =
	"Error Code null: The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing";

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
			"getaddrinfo ENOTFOUND api.example.test",
			"getaddrinfo EAI_AGAIN api.example.test",
			"connection lost",
			"socket hang up",
			"Socket connection was closed unexpectedly",
			"stream ended before message_stop",
			"OpenAI Responses stream ended before a terminal response event",
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

	it("classifies the xAI code-null capacity response as retryable subscription overload", () => {
		expect(classifyFailure({ provider: "xai", message: XAI_CAPACITY_ERROR })).toMatchObject({
			reason: "overloaded",
			retryable: true,
			shouldCompact: false,
			shouldRotateCredential: false,
			shouldFallback: false,
		});
	});

	it("does not infer provider overload from unrelated capacity wording", () => {
		expect(
			classifyFailure({ provider: "xai", message: "The model context capacity is 131072 tokens." }),
		).toMatchObject({
			reason: "unknown",
			retryable: false,
		});
	});

	it("classifies gRPC resource exhaustion as a transient server error", () => {
		expect(classifyFailure({ message: "ResourceExhausted: temporarily unable to serve this request" })).toMatchObject(
			{
				reason: "server_error",
				retryable: true,
				shouldFallback: true,
			},
		);
	});

	it.each([
		[
			"openai-codex",
			"Codex error: An error occurred while processing your request. You can retry your request, or contact support. Please include request ID req_test.",
		],
		["bedrock", '{"message":"The system encountered an unexpected error. Try your request again."}'],
		["generic", "The provider could not finish. Please retry your request."],
	])("classifies %s explicit retry guidance as a transient server error", (_name, message) => {
		expect(classifyFailure({ message })).toMatchObject({
			reason: "server_error",
			retryable: true,
			shouldRotateCredential: false,
			shouldFallback: true,
		});
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
		for (const msg of [
			"insufficient_quota",
			"Monthly usage limit reached",
			"billing hard limit",
			"out of budget",
			"You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.",
			"usage_limit_reached",
		]) {
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

	it("classifies every provider signature row before the generic ladder", () => {
		for (const [provider, signatures] of Object.entries(PROVIDER_FAILURE_SIGNATURES)) {
			for (const signature of signatures) {
				const message = signature.source.includes("openai-codex")
					? "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min."
					: signature.pattern.source;
				const c = classifyFailure({ provider, message });
				expect(c.reason, `${provider} ${signature.source}`).toBe(signature.reason);
				if (signature.reason === "billing_or_quota") {
					expect(c.retryable).toBe(false);
					expect(c.shouldFallback).toBe(true);
				}
			}
		}
	});

	it("precedence: overflow beats retryable patterns; billing beats rate-limit words", () => {
		expect(classifyFailure({ message: "429 too many tokens", contextOverflow: true }).reason).toBe(
			"context_overflow",
		);
		expect(classifyFailure({ message: "quota exceeded, rate limited" }).reason).toBe("billing_or_quota");
	});

	it("precedence: auth beats network wording", () => {
		const c = classifyFailure({ message: "fetch failed: 401 unauthorized" });
		expect(c.reason).toBe("auth");
		expect(c.retryable).toBe(false);
		expect(c.shouldRotateCredential).toBe(true);
	});

	it("extracts retry-after hints in seconds and milliseconds", () => {
		expect(classifyFailure({ message: "rate limited, retry after 12s" }).retryAfterMs).toBe(12_000);
		expect(classifyFailure({ message: 'overloaded {"retryDelay":"7s"}' }).retryAfterMs).toBe(7_000);
		expect(classifyFailure({ message: "please retry in 2500 ms" }).retryAfterMs).toBe(2_500);
		expect(classifyFailure({ message: "500 internal error" }).retryAfterMs).toBeUndefined();
	});

	it("matches numeric status codes only as standalone codes", () => {
		for (const message of ["429", "HTTP 429 Too Many Requests", "status:429", "(500)", "502 Bad Gateway"]) {
			expect(classifyFailure({ message }).retryable, message).toBe(true);
		}
		expect(classifyFailure({ message: "code429" })).toMatchObject({ reason: "unknown", retryable: false });
		expect(classifyFailure({ message: "4290" })).toMatchObject({ reason: "unknown", retryable: false });
		expect(classifyFailure({ message: "abc500def" })).toMatchObject({ reason: "unknown", retryable: false });
		expect(classifyFailure({ message: "x502y" })).toMatchObject({ reason: "unknown", retryable: false });
		expect(classifyFailure({ message: "501 Not Implemented" })).toMatchObject({
			reason: "unknown",
			retryable: false,
		});
	});
});
