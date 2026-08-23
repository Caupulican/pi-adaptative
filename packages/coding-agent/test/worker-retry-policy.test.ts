import { describe, expect, it } from "vitest";
import {
	DEFAULT_WORKER_TASK_ATTEMPTS,
	evaluateWorkerRetry,
	WORKER_TASK_RETRY_POLICY,
} from "../src/core/delegation/worker-retry-policy.ts";

const base = {
	laneStatus: "failed",
	reasonCode: "completion_error",
	reasonDetail: "WebSocket error",
	provider: "openai-codex",
	retriesUsed: 0,
};

describe("worker retry policy", () => {
	it("retries a transient network failure with a backoff delay", () => {
		const decision = evaluateWorkerRetry(base);
		expect(decision.retry).toBe(true);
		if (!decision.retry) return;
		expect(decision.reason).toBe("network");
		expect(decision.delayMs).toBeGreaterThanOrEqual(WORKER_TASK_RETRY_POLICY.baseDelayMs);
	});

	it("never retries cancellations, timeouts, or non-failure statuses", () => {
		expect(evaluateWorkerRetry({ ...base, laneStatus: "canceled" })).toEqual({
			retry: false,
			reason: "lane_status_canceled",
		});
		expect(evaluateWorkerRetry({ ...base, laneStatus: "timeout" })).toEqual({
			retry: false,
			reason: "lane_status_timeout",
		});
		expect(evaluateWorkerRetry({ ...base, reasonCode: "wall_clock_exceeded" })).toEqual({
			retry: false,
			reason: "reason_code_wall_clock_exceeded",
		});
	});

	it("never retries without failure evidence", () => {
		const { reasonDetail: _omitted, ...withoutDetail } = base;
		expect(evaluateWorkerRetry(withoutDetail)).toEqual({ retry: false, reason: "no_failure_detail" });
	});

	it("never retries non-transient classifications", () => {
		expect(evaluateWorkerRetry({ ...base, reasonDetail: "401 unauthorized: invalid api key" })).toEqual({
			retry: false,
			reason: "not_retryable_auth",
		});
		expect(evaluateWorkerRetry({ ...base, reasonDetail: "some unrecognized failure text" })).toEqual({
			retry: false,
			reason: "not_retryable_unknown",
		});
	});

	it("enforces the attempt ceiling, defaulting to two total attempts", () => {
		expect(DEFAULT_WORKER_TASK_ATTEMPTS).toBe(2);
		expect(evaluateWorkerRetry({ ...base, retriesUsed: 1 })).toEqual({ retry: false, reason: "attempts_exhausted" });
		const third = evaluateWorkerRetry({ ...base, retriesUsed: 1, maxAttempts: 3 });
		expect(third.retry).toBe(true);
		// maxAttempts 1 (managed lanes) never ladders.
		expect(evaluateWorkerRetry({ ...base, maxAttempts: 1 })).toEqual({ retry: false, reason: "attempts_exhausted" });
	});

	it("honors a provider-suggested retry delay", () => {
		const decision = evaluateWorkerRetry({ ...base, reasonDetail: "503 service unavailable, retry after 2s" });
		expect(decision.retry).toBe(true);
		if (!decision.retry) return;
		expect(decision.delayMs).toBe(2_000);
	});

	it("fails closed instead of shortening a provider delay above the worker wait bound", () => {
		expect(
			evaluateWorkerRetry({ ...base, reasonDetail: "429 rate limited; Please try again in 1m19.542s." }),
		).toEqual({ retry: false, reason: "retry_delay_exceeds_max" });
	});
});
