/**
 * Pure provider-failure classifier.
 *
 * One classification produces four independent action booleans (hermes-derived design):
 * the retry loop, compaction, credential rotation, and provider failover each read their
 * own flag, so one pipeline can route a 429 to rotation, an overflow to compaction, and a
 * billing error to failover without re-parsing error text at each site.
 *
 * Pattern sources: AgentSession._isRetryableError / _isNonRetryableProviderLimitError
 * (the live, battle-tested regexes), split by reason so each maps to distinct actions.
 * Detection of context overflow stays in @caupulican/pi-ai (needs model state); hosts pass
 * `contextOverflow` in.
 */

import { PROVIDER_FAILURE_SIGNATURES } from "./provider-signatures.ts";

export type FailureReason =
	| "overloaded"
	| "rate_limit"
	| "server_error"
	| "network"
	| "stream_stall"
	| "context_overflow"
	| "auth"
	| "billing_or_quota"
	| "aborted"
	| "unknown";

export interface ClassifiedError {
	reason: FailureReason;
	retryable: boolean;
	shouldCompact: boolean;
	shouldRotateCredential: boolean;
	shouldFallback: boolean;
	/** Provider-suggested delay parsed from the message, capped by the retry policy at use site. */
	retryAfterMs?: number;
	message: string;
}

export interface ClassifyFailureInput {
	message: string;
	/** Host-computed via pi-ai isContextOverflow(message, contextWindow). */
	contextOverflow?: boolean;
	/** True when the failure came from an intentional abort (stopReason "aborted"). */
	aborted?: boolean;
	/** Provider id; provider-specific signatures are checked before generic patterns. */
	provider?: string;
}

const BILLING_OR_QUOTA =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|usage.?limit(?:s)?\s*(?:reached|exceeded|hit)|usage_limit_reached|hit your usage limit|hit your ChatGPT usage limit/i;
const AUTH = /\b401\b|unauthorized|invalid.?api.?key|authentication.?error|forbidden|permission.?denied/i;
const RATE_LIMIT = /rate.?limit|too many requests|(?<![A-Za-z0-9])429(?![A-Za-z0-9])/i;
const OVERLOADED = /overloaded/i;
const STREAM_STALL =
	/stream stalled|ended without|stream ended before message_stop|stream ended before a terminal response event|reset before headers/i;
const SERVER_ERROR =
	/(?<![A-Za-z0-9])(?:500|502|503|504)(?![A-Za-z0-9])|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|upstream.?connect|http2 request did not get a response|ResourceExhausted|retry delay|provider retry directive:\s*retry|you can retry your request|try your request again|please retry your request/i;
const NETWORK =
	/network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|socket hang up|socket connection was closed|timed? out|timeout|terminated/i;
const PROVIDER_NO_RETRY = /Provider retry directive:\s*do not retry\./i;

const RETRY_DELAY_TEXT =
	/(?:retry(?:\s+your\s+request)?|try(?:\s+your\s+request)?\s+again)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\s*)+)/gi;
const RETRY_DELAY_JSON = /"retryDelay"\s*:\s*"([^"]+)"/gi;
const RETRY_DURATION_COMPONENT =
	/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![A-Za-z])/gi;

function parseRetryDurationMs(value: string): number | undefined {
	let totalMs = 0;
	let components = 0;
	for (const match of value.matchAll(RETRY_DURATION_COMPONENT)) {
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) return undefined;
		const unit = match[2].toLowerCase();
		const multiplier =
			unit === "ms" || unit.startsWith("millisecond")
				? 1
				: unit === "s" || unit.startsWith("sec")
					? 1000
					: unit === "m" || unit.startsWith("min")
						? 60_000
						: 3_600_000;
		totalMs += amount * multiplier;
		components++;
	}
	return components > 0 && Number.isFinite(totalMs) ? Math.round(totalMs) : undefined;
}

function parseRetryAfterMs(message: string): number | undefined {
	let longestDelayMs: number | undefined;
	for (const pattern of [RETRY_DELAY_TEXT, RETRY_DELAY_JSON]) {
		for (const match of message.matchAll(pattern)) {
			const delayMs = parseRetryDurationMs(match[1]);
			if (delayMs !== undefined) longestDelayMs = Math.max(longestDelayMs ?? 0, delayMs);
		}
	}
	return longestDelayMs;
}

export function classifyFailure(input: ClassifyFailureInput): ClassifiedError {
	const message = input.message;
	const retryAfterMs = parseRetryAfterMs(message);
	const providerForbidsRetry = PROVIDER_NO_RETRY.test(message);

	const base = {
		retryable: false,
		shouldCompact: false,
		shouldRotateCredential: false,
		shouldFallback: false,
		message,
	};

	const withRetry = (result: ClassifiedError): ClassifiedError => {
		const withDelay = retryAfterMs !== undefined ? { ...result, retryAfterMs } : result;
		return providerForbidsRetry && withDelay.retryable ? { ...withDelay, retryable: false } : withDelay;
	};

	if (input.aborted) return withRetry({ ...base, reason: "aborted" });
	if (input.contextOverflow) return withRetry({ ...base, reason: "context_overflow", shouldCompact: true });
	const providerSignatures = input.provider ? (PROVIDER_FAILURE_SIGNATURES[input.provider] ?? []) : [];
	for (const signature of providerSignatures) {
		if (signature.pattern.test(message)) {
			return withRetry({
				...base,
				reason: signature.reason,
				shouldCompact: signature.shouldCompact ?? false,
				shouldFallback: signature.reason === "billing_or_quota" || signature.reason === "auth",
				shouldRotateCredential: signature.reason === "auth",
				retryable:
					signature.reason === "rate_limit" ||
					signature.reason === "overloaded" ||
					signature.reason === "server_error" ||
					signature.reason === "network" ||
					signature.reason === "stream_stall",
			});
		}
	}
	if (BILLING_OR_QUOTA.test(message)) return withRetry({ ...base, reason: "billing_or_quota", shouldFallback: true });
	if (AUTH.test(message))
		return withRetry({ ...base, reason: "auth", shouldRotateCredential: true, shouldFallback: true });

	const isRateLimit = RATE_LIMIT.test(message);
	if (isRateLimit || OVERLOADED.test(message)) {
		return withRetry({
			...base,
			reason: isRateLimit ? "rate_limit" : "overloaded",
			retryable: true,
			shouldRotateCredential: true,
			shouldFallback: true,
		});
	}
	if (STREAM_STALL.test(message))
		return withRetry({ ...base, reason: "stream_stall", retryable: true, shouldFallback: true });
	if (SERVER_ERROR.test(message))
		return withRetry({ ...base, reason: "server_error", retryable: true, shouldFallback: true });
	if (NETWORK.test(message)) return withRetry({ ...base, reason: "network", retryable: true, shouldFallback: true });

	return withRetry({ ...base, reason: "unknown" });
}
