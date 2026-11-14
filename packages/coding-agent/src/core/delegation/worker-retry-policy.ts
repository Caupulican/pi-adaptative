import {
	classifyFailure,
	computeRetryDelayMs,
	RetryDelayExceededError,
	type RetryPolicy,
} from "../../kernel/reliability/index.ts";
import { statedUsageResetMs, usageResetWaitMs } from "../provider-admission/usage-reset.ts";

/**
 * Restart-durable, host-owned attempt ladder policy for delegated workers.
 *
 * The budget model has always carried `maxAttempts`, but nothing drove a second attempt: a
 * failed worker terminalized immediately and "retry" meant the orchestrator model burning a
 * turn to re-delegate blind, losing the worker's transcript. The ladder makes retry a host
 * mechanism instead: a retryable bounded failure suspends the attempt (durable, fenced) and
 * re-enqueues it through the owner scheduler after backoff, resuming from the persisted
 * conversation exactly like restart recovery does.
 *
 * Retries are deliberately evidence-gated: only failures whose recorded detail classifies as
 * transient (network, 5xx, rate limits) are retried. A missing detail or an unknown
 * classification never retries — an undiagnosed failure repeated is spend without evidence.
 *
 * A subscription model whose plan's usage is used up is not a failure of the work: its limit is the plan's usage window,
 * not money. When the failure states when the usage resets (the provider's own retry-after, or the reset the provider
 * admission gate recorded and refused with), the attempt waits for that reset however long it is and resumes on its own,
 * without spending the attempt ceiling when the reset is further off than a minute (`provider-admission/usage-reset.ts`,
 * the rule a root session's stopped turn reads too); a nearer one is an ordinary retry no sooner than the reset. The same refusal on a metered model stays terminal: that limit is money.
 */
export const DEFAULT_WORKER_TASK_ATTEMPTS = 2;

export const WORKER_TASK_RETRY_POLICY: RetryPolicy = {
	maxAttempts: DEFAULT_WORKER_TASK_ATTEMPTS,
	baseDelayMs: 5_000,
	maxDelayMs: 60_000,
	jitterRatio: 0.2,
};

export type WorkerRetryDecision =
	/** `usageReset`: the delay waits out a subscription's usage reset and does not spend the attempt ceiling. */
	{ retry: true; reason: string; delayMs: number; usageReset?: true } | { retry: false; reason: string };

export function evaluateWorkerRetry(args: {
	laneStatus: string;
	reasonCode: string;
	reasonDetail?: string;
	provider: string;
	/** Restart-durable ladder retries already consumed for this attempt. */
	retriesUsed: number;
	/** Of `retriesUsed`, the ones that waited out a usage reset; they do not count against `maxAttempts`. */
	resetWaits?: number;
	/** The attempt's model is reached through a subscription, whose limit is its plan's usage windows. */
	subscription?: boolean;
	/** Grant budget ceiling for total attempts; defaults to {@link DEFAULT_WORKER_TASK_ATTEMPTS}. */
	maxAttempts?: number;
	/**
	 * The attempt's contract has another usable candidate: a quota failure moves it there at once
	 * instead of terminalizing (the failed model is already marked exhausted).
	 */
	failover?: boolean;
}): WorkerRetryDecision {
	if (args.laneStatus !== "failed") return { retry: false, reason: `lane_status_${args.laneStatus}` };
	if (args.reasonCode !== "completion_error") return { retry: false, reason: `reason_code_${args.reasonCode}` };
	if (!args.reasonDetail) return { retry: false, reason: "no_failure_detail" };
	const classified = classifyFailure({ message: args.reasonDetail, provider: args.provider });
	// A quota failure with another candidate moves on the ladder's own backoff; the exhausted model's
	// retry-after bounds the account it leaves, not the one it moves to. It is not a repeat of the same
	// failure, so it does not spend the attempt ceiling: the chain is bounded by the contract's finite
	// candidates, each marked exhausted as it is left.
	const failover =
		args.failover === true &&
		(classified.reason === "billing_or_quota" ||
			classified.reason === "model_unsupported" ||
			classified.reason === "auth");
	const subscription = !failover && args.subscription === true;
	// A usage reset is waited out and spends nothing. A nearer stated reset (a reset worded "~0 min" just before it passes)
	// is an ordinary retry that spends the ceiling, so a refusal that keeps stating a near reset ends once it is spent.
	const resetWaitMs = usageResetWaitMs(classified, subscription);
	if (resetWaitMs !== undefined) return { retry: true, reason: "usage_reset", delayMs: resetWaitMs, usageReset: true };
	// A quota is never retryable by its class; one that states a near reset is retried once it passes. A rate limit keeps
	// its class's verdict, so a provider's own "do not retry" still ends it.
	const quotaReset =
		classified.reason === "billing_or_quota" && statedUsageResetMs(classified, subscription) !== undefined;
	const attemptsAllowed = args.maxAttempts ?? DEFAULT_WORKER_TASK_ATTEMPTS;
	const retriesSpent = args.retriesUsed - (args.resetWaits ?? 0);
	if (!failover && retriesSpent + 1 >= attemptsAllowed) return { retry: false, reason: "attempts_exhausted" };
	if (!classified.retryable && !failover && !quotaReset)
		return { retry: false, reason: `not_retryable_${classified.reason}` };
	// A stated delay is waited, never less than the ladder's own backoff: one stated as nothing ("retry after 0 seconds",
	// a reset worded "~0 min") would retry at once, which the durable suspension refuses as a deadline not in the future.
	let delayMs = computeRetryDelayMs(WORKER_TASK_RETRY_POLICY, retriesSpent + 1);
	try {
		if (classified.retryAfterMs !== undefined && !failover) {
			const statedMs = computeRetryDelayMs(WORKER_TASK_RETRY_POLICY, retriesSpent + 1, {
				retryAfterMs: classified.retryAfterMs,
			});
			delayMs = Math.max(delayMs, statedMs);
		}
	} catch (error) {
		if (error instanceof RetryDelayExceededError) return { retry: false, reason: "retry_delay_exceeds_max" };
		throw error;
	}
	return {
		retry: true,
		reason: failover
			? classified.reason === "billing_or_quota"
				? "billing_or_quota_failover"
				: `${classified.reason}_failover`
			: classified.reason,
		delayMs,
	};
}
