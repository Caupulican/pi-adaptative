/** Retry backoff policy. jitterRatio 0 reproduces legacy fixed 2s/4s/8s behavior. */
export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
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
	/** Provider-suggested delay (e.g. from Retry-After); wins over backoff but is capped. */
	retryAfterMs?: number;
	/** Injectable RNG for deterministic tests. Defaults to Math.random. */
	random?: () => number;
}

export function computeRetryDelayMs(policy: RetryPolicy, attempt: number, opts?: ComputeRetryDelayOptions): number {
	if (opts?.retryAfterMs !== undefined) {
		return Math.min(opts.retryAfterMs, policy.maxDelayMs);
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
