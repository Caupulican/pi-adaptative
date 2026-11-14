/**
 * When a refusal is a subscription's used-up usage that resets at a stated time: the one rule every lane that waits for a
 * usage reset reads (a worker's attempt ladder, a root session's stopped turn). A subscription's limit is its plan's
 * usage windows, not money, so its refusal is waited out rather than ended; a metered (API-key) model's refusal is money
 * and is never waited for here. The reset is the refusal's own stated delay: the provider's "try again in" or the reset
 * the provider admission gate recorded and refused with. Nothing guesses one that was not stated.
 */

import type { ClassifiedError } from "../../kernel/reliability/index.ts";

/**
 * The nearest reset that is waited out as a usage reset. A nearer one ("~0 min" just before a window turns over, a short
 * rate limit) is a lane's ordinary retry, bounded by that lane's own retry ceiling, so a refusal that keeps stating a near
 * reset is never asked again without end.
 */
export const USAGE_RESET_MIN_WAIT_MS = 60_000;

/** The stated reset of a subscription's quota or rate-limit refusal, in milliseconds; undefined for any other refusal. */
export function statedUsageResetMs(classified: ClassifiedError, subscription: boolean): number | undefined {
	if (!subscription || classified.retryAfterMs === undefined) return undefined;
	return classified.reason === "billing_or_quota" || classified.reason === "rate_limit"
		? classified.retryAfterMs
		: undefined;
}

/** The usage reset a refusal is waited out for: a stated one further off than {@link USAGE_RESET_MIN_WAIT_MS}. */
export function usageResetWaitMs(classified: ClassifiedError, subscription: boolean): number | undefined {
	const resetMs = statedUsageResetMs(classified, subscription);
	return resetMs !== undefined && resetMs > USAGE_RESET_MIN_WAIT_MS ? resetMs : undefined;
}
