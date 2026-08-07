import { classifyFailure, computeRetryDelayMs, type RetryPolicy } from "@caupulican/pi-agent-core/reliability";

/**
 * In-process attempt ladder policy for delegated workers.
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
 */
export const DEFAULT_WORKER_TASK_ATTEMPTS = 2;

export const WORKER_TASK_RETRY_POLICY: RetryPolicy = {
	maxAttempts: DEFAULT_WORKER_TASK_ATTEMPTS,
	baseDelayMs: 5_000,
	maxDelayMs: 60_000,
	jitterRatio: 0.2,
};

export type WorkerRetryDecision = { retry: true; reason: string; delayMs: number } | { retry: false; reason: string };

export function evaluateWorkerRetry(args: {
	laneStatus: string;
	reasonCode: string;
	reasonDetail?: string;
	provider: string;
	/** Ladder retries already consumed for this lane in this process. */
	retriesUsed: number;
	/** Grant budget ceiling for total attempts; defaults to {@link DEFAULT_WORKER_TASK_ATTEMPTS}. */
	maxAttempts?: number;
}): WorkerRetryDecision {
	if (args.laneStatus !== "failed") return { retry: false, reason: `lane_status_${args.laneStatus}` };
	if (args.reasonCode !== "completion_error") return { retry: false, reason: `reason_code_${args.reasonCode}` };
	if (!args.reasonDetail) return { retry: false, reason: "no_failure_detail" };
	const attemptsAllowed = args.maxAttempts ?? DEFAULT_WORKER_TASK_ATTEMPTS;
	if (args.retriesUsed + 1 >= attemptsAllowed) return { retry: false, reason: "attempts_exhausted" };
	const classified = classifyFailure({ message: args.reasonDetail, provider: args.provider });
	if (!classified.retryable) return { retry: false, reason: `not_retryable_${classified.reason}` };
	const delayMs = computeRetryDelayMs(WORKER_TASK_RETRY_POLICY, args.retriesUsed + 1, {
		...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
	});
	return { retry: true, reason: classified.reason, delayMs };
}
