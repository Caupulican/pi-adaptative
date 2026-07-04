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
}

const BILLING_OR_QUOTA =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const AUTH = /\b401\b|unauthorized|invalid.?api.?key|authentication.?error|forbidden|permission.?denied/i;
const RATE_LIMIT = /rate.?limit|too many requests|429/i;
const OVERLOADED = /overloaded/i;
const STREAM_STALL = /stream stalled|ended without|stream ended before message_stop|reset before headers/i;
const SERVER_ERROR =
	/500|502|503|504|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|upstream.?connect|http2 request did not get a response|retry delay/i;
const NETWORK =
	/network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|socket hang up|timed? out|timeout|terminated/i;

const RETRY_AFTER_S = /retry.?(?:after|in)\s+(\d+(?:\.\d+)?)\s*s\b|"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i;
const RETRY_AFTER_MS = /retry.?(?:after|in)\s+(\d+)\s*ms\b/i;

function parseRetryAfterMs(message: string): number | undefined {
	const ms = RETRY_AFTER_MS.exec(message);
	if (ms) return Number(ms[1]);
	const s = RETRY_AFTER_S.exec(message);
	if (s) return Math.round(Number(s[1] ?? s[2]) * 1000);
	return undefined;
}

export function classifyFailure(input: ClassifyFailureInput): ClassifiedError {
	const message = input.message;
	const retryAfterMs = parseRetryAfterMs(message);

	const base = {
		retryable: false,
		shouldCompact: false,
		shouldRotateCredential: false,
		shouldFallback: false,
		message,
	};

	const withRetry = <T extends { reason: FailureReason }>(obj: T): T | (T & { retryAfterMs: number }) =>
		retryAfterMs !== undefined ? { ...obj, retryAfterMs } : obj;

	if (input.aborted) return withRetry({ ...base, reason: "aborted" });
	if (input.contextOverflow) return withRetry({ ...base, reason: "context_overflow", shouldCompact: true });
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
