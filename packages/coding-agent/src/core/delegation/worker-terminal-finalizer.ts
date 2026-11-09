import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import { verificationSubjectAttempt } from "../orchestration/verification-identity.ts";
import {
	type CreateWorkerResultContractInput,
	createWorkerResultContract,
} from "../orchestration/worker-result-adapter.ts";
import { normalizeWorkerClaimForHost } from "./worker-claim.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

/**
 * One terminal boundary for every worker execution adapter. It creates the fenced result, commits
 * it through the durable lifecycle, and returns the event-driven handoff token without owning UI.
 */
export interface FinalizeWorkerClaimInput extends CreateWorkerResultContractInput {
	/** Verification dispatch owns the next terminal signal until it reconciles the subject. */
	notify?: boolean;
	/** A review run's anchor: the worker result its review evidence names, when the run is not a verification of a subject. */
	reviewOf?: { readonly taskId: string; readonly attemptId: string };
}

export interface FinalizedWorkerClaim {
	result: WorkerResultContract;
	record: LaneRecord;
	notification?: { notificationId: string; status: "pending" | "delivered"; record: LaneRecord };
}

export function finalizeWorkerClaim(lifecycle: WorkerLifecycle, input: FinalizeWorkerClaimInput): FinalizedWorkerClaim {
	const { notify, reviewOf, ...resultInput } = input;
	// Direct abort/error paths also pass here, so this boundary cannot rely on worker-runner
	// normalization. Reject before lifecycle mutation, filesystem observation, or notification.
	const snapshot = lifecycle.getTaskRuntimeSnapshot();
	const task = snapshot.tasks[input.handle.taskId]?.task;
	const subject = (task ? verificationSubjectAttempt(snapshot, task) : undefined) ?? reviewOf;
	const claim = normalizeWorkerClaimForHost(resultInput.claim);
	const result = createWorkerResultContract({
		...resultInput,
		verificationSubject: subject ? { taskId: subject.taskId, attemptId: subject.attemptId } : undefined,
		claim,
	});
	const record = lifecycle.finish(result, { claim, ...(notify === false ? { notify: false } : {}) });
	const notification = notify === false ? undefined : lifecycle.getTerminalNotification(record.laneId);
	return { result, record, ...(notification ? { notification } : {}) };
}
