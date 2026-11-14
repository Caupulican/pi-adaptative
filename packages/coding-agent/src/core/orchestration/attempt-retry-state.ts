/**
 * The durable retry ladder state of one resumable worker attempt (`AttemptRetryState`): its decoder, and the rule a
 * suspension's retry state follows from the one before it, checked by the runtime before it writes the suspension and by
 * the reducer when it replays it. Every suspension spends one retry; one that waits out a subscription's usage reset also
 * counts one reset wait, which does not spend the attempt ceiling (`delegation/worker-retry-policy.ts`).
 */

import { MAX_DATE_EPOCH_MS, number, string } from "./codec-primitives.ts";
import type { AttemptRetryState } from "./contracts.ts";
import { exactRecord } from "./task-runtime-projection.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

export function retryStateFromValue(raw: unknown, label: string): AttemptRetryState {
	const value = exactRecord(raw, label, ["retriesUsed", "notBefore", "resetWaits"]);
	const retriesUsed = number(value.retriesUsed, `${label}.retriesUsed`);
	if (!Number.isSafeInteger(retriesUsed) || retriesUsed < 1) {
		throw new DurableTaskRuntimeError(`${label}.retriesUsed must be a positive safe integer.`);
	}
	const notBefore = string(value.notBefore, `${label}.notBefore`);
	const notBeforeMs = Date.parse(notBefore);
	if (
		!Number.isFinite(notBeforeMs) ||
		Math.abs(notBeforeMs) > MAX_DATE_EPOCH_MS ||
		new Date(notBeforeMs).toISOString() !== notBefore
	) {
		throw new DurableTaskRuntimeError(`${label}.notBefore is invalid.`);
	}
	if (value.resetWaits === undefined) return { retriesUsed, notBefore };
	const resetWaits = number(value.resetWaits, `${label}.resetWaits`);
	if (!Number.isSafeInteger(resetWaits) || resetWaits < 1 || resetWaits > retriesUsed) {
		throw new DurableTaskRuntimeError(
			`${label}.resetWaits must be a positive safe integer no larger than retriesUsed.`,
		);
	}
	return { retriesUsed, notBefore, resetWaits };
}

/** A suspension's retry state, decoded and held to follow `previous`: one more retry, and the same reset waits or one more. */
export function nextRetryStateFromValue(
	value: unknown,
	previous: AttemptRetryState | undefined,
	attemptId: string,
): AttemptRetryState {
	const retry = retryStateFromValue(value, "attempt.suspended.retry");
	if (retry.retriesUsed !== (previous?.retriesUsed ?? 0) + 1) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' retry count is not monotonic.`);
	}
	const waitsBefore = previous?.resetWaits ?? 0;
	const waits = retry.resetWaits ?? 0;
	if (waits !== waitsBefore && waits !== waitsBefore + 1) {
		throw new DurableTaskRuntimeError(`Attempt '${attemptId}' usage reset wait count is not monotonic.`);
	}
	return retry;
}
