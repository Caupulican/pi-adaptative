/**
 * The worker's provider request retried with backoff: a transient provider failure (a dropped socket, a stated short
 * delay) is waited out a bounded number of times inside the attempt, and every other failure ends it as a bounded
 * completion failure the attempt ladder reads.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	classifyFailure,
	computeRetryDelayMs,
	type RetryPolicy,
	sleepAbortable,
} from "../../kernel/reliability/index.ts";
import { VERIFICATION_HANDOFF_REQUIRED_ERROR } from "../../kernel/verification-obligations.ts";
import type { IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import { CapabilityGatewayDeniedError } from "../orchestration/capability-gateway.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { WorkerConversationOwnershipError } from "./worker-conversation-revision.ts";
import { WorkerCompletionProtocolError } from "./worker-provider-turn-protocol.ts";
import { WorkerTreeBudgetExceededError } from "./worker-tree-budget-coordinator.ts";

/**
 * Backoff policy for transient worker provider failures. Without it, a dropped provider socket
 * kills the attempt instantly at $0 spend and an immediate re-dispatch hits the same dead
 * connection (field session 019fd4dc: paired $0 `completion_error` lanes ~10s apart). Jitter
 * de-synchronizes sibling workers that all lost the same connection at once.
 */
const WORKER_PROVIDER_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 2_000,
	maxDelayMs: 30_000,
	jitterRatio: 0.2,
};

export async function runProviderCompletionWithBackoff(args: {
	attempt: () => Promise<IsolatedCompletionResult>;
	/** Release per-attempt provider reservations before waiting; the final failure is rethrown. */
	onAttemptFailure: () => void;
	provider: string;
	laneId: string;
	warn: (message: string) => void;
	signal?: AbortSignal;
	/** The `worker-provider-retry` port the backoff waits on; defaults to the system timers. */
	timers?: TimerPort;
}): Promise<IsolatedCompletionResult> {
	for (let attempt = 1; ; attempt++) {
		try {
			const completion = await args.attempt();
			if (completion.stopReason !== "error" || completion.errorMessage === VERIFICATION_HANDOFF_REQUIRED_ERROR) {
				return completion;
			}
			throw new Error(
				completion.errorMessage?.trim() || "Provider completion stopped with an error without diagnostic detail.",
			);
		} catch (error) {
			args.onAttemptFailure();
			if (args.signal?.aborted) throw error;
			if (error instanceof WorkerCompletionProtocolError) {
				throw new BoundedCompletionFailureError("failed", "worker_protocol_error", error.message, error);
			}
			if (
				error instanceof WorkerConversationOwnershipError ||
				error instanceof CapabilityGatewayDeniedError ||
				error instanceof WorkerTreeBudgetExceededError ||
				error instanceof BoundedCompletionFailureError
			) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			const classified = classifyFailure({ message, provider: args.provider });
			// A stated delay longer than this loop waits (a recorded reset) is the attempt ladder's to wait out.
			const statedTooLong =
				classified.retryAfterMs !== undefined && classified.retryAfterMs > WORKER_PROVIDER_RETRY_POLICY.maxDelayMs;
			if (!classified.retryable || statedTooLong || attempt >= WORKER_PROVIDER_RETRY_POLICY.maxAttempts) {
				throw new BoundedCompletionFailureError("failed", "completion_error", message, error);
			}
			const delayMs = computeRetryDelayMs(WORKER_PROVIDER_RETRY_POLICY, attempt, {
				...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
			});
			args.warn(
				`Worker ${args.laneId} provider request failed (${classified.reason}); retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt + 1}/${WORKER_PROVIDER_RETRY_POLICY.maxAttempts}).`,
			);
			harnessLog.warn("workers", "a worker provider request is retried", {
				laneId: args.laneId,
				reason: classified.reason,
				attempt,
				delayMs,
			});
			await sleepAbortable(delayMs, args.signal, args.timers);
		}
	}
}
