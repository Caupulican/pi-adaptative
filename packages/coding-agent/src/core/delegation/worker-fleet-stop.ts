/**
 * Stopping a session's own workers. The owner's stop (`owner_stopped`) closes every plan the session runs and cancels every
 * worker lane it started, queued, suspended until a retry, leased or running; its ends wake no one, since the owner already
 * sees the stop. The same stop reaches a session no process hosts through its bundle alone. And the lanes a disposing
 * session's own tracker still holds (research, review) end as `session_disposed`.
 */

import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { LaneRecord, LaneTracker } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot } from "../autonomy/session-lane-record.ts";
import type { AttemptRuntimeState, DurableTaskRuntime, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import {
	isManagedWorkerAttempt,
	NONTERMINAL_WORKER_ATTEMPT_STATUSES,
	selectedWorkerAttempt,
} from "./worker-lane-projection.ts";

/** The reason code of every end the owner's stop makes. */
export const OWNER_STOPPED_REASON = "owner_stopped";

/** The words a plan the owner's stop closed keeps as its close reason (model-facing). */
const OWNER_STOPPED_PLAN_REASON = "stopped by the owner";

/** A lane end the owner's stop made: its terminal notification wakes no one. */
export function isOwnerStoppedEnd<T extends Pick<LaneRecord, "status" | "reasonCode">>(
	record: T,
): record is T & { readonly status: "canceled" } {
	return record.status === "canceled" && record.reasonCode === OWNER_STOPPED_REASON;
}

/**
 * The selected attempt of every worker task that has not ended. A managed lane's attempt is left out: it runs in a process
 * the host never starts or resumes, and its owner ends it.
 */
export function unendedWorkerAttempts(snapshot: TaskRuntimeProjection): AttemptRuntimeState[] {
	return unendedSelectedAttempts(snapshot).filter((attempt) => !isManagedWorkerAttempt(attempt));
}

function unendedSelectedAttempts(snapshot: TaskRuntimeProjection): AttemptRuntimeState[] {
	return Object.keys(snapshot.tasks).flatMap((taskId) => {
		const attempt = selectedWorkerAttempt(snapshot, taskId);
		return attempt && NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status) ? [attempt] : [];
	});
}

/** What the owner's stop left unended, by why. */
export interface WorkerStopOutcome {
	/** Lanes whose cancel the remote backend took: each ends when its placed job's end comes back from the executor. */
	readonly remote: readonly AttemptRuntimeState[];
	/** Managed lanes' attempts, left to the extension that runs each: the host neither runs nor cancels them. */
	readonly managed: readonly AttemptRuntimeState[];
	/** Local lanes a cancel did not end. */
	readonly failed: readonly AttemptRuntimeState[];
}

/** The plan executor's close of every open plan; its running steps stop for `reasonCode`. */
export interface OpenPlansStop {
	cancelOpenPlans(reason: string, reasonCode: string): void;
}

/**
 * The owner's stop of a session's workers: every open plan closed as cancelled (through `plans`, the session's plan
 * executor, which also releases the plan's prepared dispatches and placed jobs; else in the store, for a session that runs
 * none), then every unended worker attempt cancelled through `cancel` (true when the remote backend took the cancel),
 * both for `reasonCode`. Plans close first, so no
 * step is dispatched again for a lane this stop ends. Returns what is still unended after it, by why.
 */
export function stopSessionWorkers(
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "closePlan">,
	plans: OpenPlansStop | undefined,
	cancel: (attempt: AttemptRuntimeState) => boolean,
	reasonCode: string,
): WorkerStopOutcome {
	if (plans) plans.cancelOpenPlans(OWNER_STOPPED_PLAN_REASON, reasonCode);
	else
		for (const [planId, plan] of Object.entries(runtime.getSnapshot().plans))
			if (!plan.closed) runtime.closePlan({ planId, status: "cancelled", reason: OWNER_STOPPED_PLAN_REASON });
	const handed = new Set<string>();
	for (const attempt of unendedWorkerAttempts(runtime.getSnapshot()))
		if (cancel(attempt)) handed.add(attempt.attemptId);
	const unended = unendedSelectedAttempts(runtime.getSnapshot());
	const own = unended.filter((attempt) => !isManagedWorkerAttempt(attempt));
	return {
		remote: own.filter((attempt) => handed.has(attempt.attemptId)),
		managed: unended.filter(isManagedWorkerAttempt),
		failed: own.filter((attempt) => !handed.has(attempt.attemptId)),
	};
}

/**
 * Ends every lane the session's own tracker still holds queued or running as `session_disposed`, each persisted before
 * the next: one lane's failed write is warned and does not skip another's. A managed lane is its controller's to release.
 */
export function cancelTrackedLanes(
	tracker: LaneTracker,
	sessions: { getSessionManager(): SessionManager },
	warn: (message: string) => void,
): void {
	for (const record of tracker.getRecords()) {
		if (record.status !== "queued" && record.status !== "running") continue;
		if (record.type === "managed-worker") continue;
		const canceled = tracker.complete(record.laneId, { status: "canceled", reasonCode: "session_disposed" });
		if (!canceled) continue;
		try {
			appendLaneRecordSnapshot(sessions.getSessionManager(), canceled);
		} catch (error) {
			warn(
				`Failed to persist canceled lane record ${canceled.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
