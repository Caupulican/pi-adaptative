/** Retry backoff policy. jitterRatio 0 reproduces legacy fixed 2s/4s/8s behavior. */
export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	/** Cap for locally computed exponential backoff. */
	maxDelayMs: number;
	/** Longest provider-requested wait accepted; 0 disables this bound. Defaults to maxDelayMs. */
	maxRetryAfterMs?: number;
	/** Fraction of the computed delay added as uniform random jitter (0..1). */
	jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 120_000,
	jitterRatio: 0,
};

export interface ComputeRetryDelayOptions {
	/** Provider-suggested minimum delay (e.g. from Retry-After); wins over local backoff. */
	retryAfterMs?: number;
	/** Injectable RNG for deterministic tests. Defaults to Math.random. */
	random?: () => number;
}

export class RetryDelayExceededError extends Error {
	readonly retryAfterMs: number;
	readonly maxRetryAfterMs: number;

	constructor(retryAfterMs: number, maxRetryAfterMs: number) {
		super(
			`Provider requested ${Math.ceil(retryAfterMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryAfterMs / 1000)}s).\nProvider retry directive: do not retry.`,
		);
		this.name = "RetryDelayExceededError";
		this.retryAfterMs = retryAfterMs;
		this.maxRetryAfterMs = maxRetryAfterMs;
	}
}

export function computeRetryDelayMs(policy: RetryPolicy, attempt: number, opts?: ComputeRetryDelayOptions): number {
	if (opts?.retryAfterMs !== undefined) {
		const retryAfterMs = Math.max(0, opts.retryAfterMs);
		if (!Number.isFinite(retryAfterMs)) throw new TypeError("Provider retry delay must be finite");
		const maxRetryAfterMs = policy.maxRetryAfterMs ?? policy.maxDelayMs;
		if (maxRetryAfterMs > 0 && retryAfterMs > maxRetryAfterMs) {
			throw new RetryDelayExceededError(retryAfterMs, maxRetryAfterMs);
		}
		return retryAfterMs;
	}
	const exponential = Math.min(policy.baseDelayMs * 2 ** (Math.max(1, attempt) - 1), policy.maxDelayMs);
	if (policy.jitterRatio <= 0) return exponential;
	const random = opts?.random ?? Math.random;
	return Math.round(exponential + policy.jitterRatio * exponential * random());
}

/** Abortable sleep: resolves after ms, rejects with the abort reason if the signal fires. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
