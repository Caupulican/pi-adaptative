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
import { isPlanFromNewerBuild } from "../plan/plan-graph.ts";
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

/** The plan executor's close of the open plans `planIds` names; their running steps stop for `reasonCode`. */
export interface OpenPlansStop {
	cancelPlans(planIds: readonly string[], reason: string, reasonCode: string): void;
}

/**
 * A stop of a session's workers: its reason code, and when it was made (`at`, ms since the epoch): it ends the work made
 * at or before then (an owner's stop taken late leaves what the bot started since for the owner's next words), and a
 * release, made now, ends all of it.
 */
export interface WorkerFleetStop {
	readonly reasonCode: string;
	readonly at: number;
}

/**
 * Whether the stop reaches `attempt`: its task (whose retries and requeues are new attempts of the same work) was made at
 * or before the stop.
 */
function reaches(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState, stop: WorkerFleetStop): boolean {
	const task = snapshot.tasks[attempt.taskId];
	return task !== undefined && Date.parse(task.task.createdAt) <= stop.at;
}

/**
 * The owner's stop of a session's workers, of the work made at or before `stop.at`: every open plan made by then closed
 * as cancelled (through `plans`, the session's plan executor, which also releases the plan's prepared dispatches and
 * placed jobs; else in the store, for a session that runs none; a plan a newer build wrote carries no time and is
 * closed), then every unended worker attempt of a task made by then cancelled through `cancel` (true when the remote
 * backend took the cancel), both for `stop.reasonCode`. Plans close first, so no step is dispatched again for a lane
 * this stop ends. Returns what the stop reached and left unended, by why.
 */
export function stopSessionWorkers(
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "closePlan">,
	plans: OpenPlansStop | undefined,
	cancel: (attempt: AttemptRuntimeState) => boolean,
	stop: WorkerFleetStop,
): WorkerStopOutcome {
	const planIds = Object.entries(runtime.getSnapshot().plans)
		.filter(([, plan]) => !plan.closed)
		.filter(([, { record }]) => isPlanFromNewerBuild(record) || Date.parse(record.createdAt) <= stop.at)
		.map(([planId]) => planId);
	if (plans) plans.cancelPlans(planIds, OWNER_STOPPED_PLAN_REASON, stop.reasonCode);
	else
		for (const planId of planIds)
			runtime.closePlan({ planId, status: "cancelled", reason: OWNER_STOPPED_PLAN_REASON });
	const handed = new Set<string>();
	const before = runtime.getSnapshot();
	for (const attempt of unendedWorkerAttempts(before))
		if (reaches(before, attempt, stop) && cancel(attempt)) handed.add(attempt.attemptId);
	const after = runtime.getSnapshot();
	const unended = unendedSelectedAttempts(after).filter((attempt) => reaches(after, attempt, stop));
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
