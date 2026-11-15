/**
 * Stopping a session's own workers. The owner's stop (`owner_stopped`) closes every plan the session runs and cancels every
 * worker lane it started, queued, suspended until a retry, leased or running (a stop applied after it was made, only those
 * there were when it was made: `FleetStopScope`); its ends wake no one, since the owner already sees the stop. The same stop reaches a session no process hosts through its bundle alone. And the lanes a disposing
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
	/** How many of the worker lanes in flight when the stop began it ended, or handed to the remote backend to end. */
	readonly stopped: number;
}

/** The plan executor's close of the open plans `covers` names; their running steps stop for `reasonCode`. */
export interface OpenPlansStop {
	cancelOpenPlans(reason: string, reasonCode: string, covers: (planId: string) => boolean): void;
}

/**
 * What an owner's stop of a session's workers ends: everything unended when it is applied (`whole`), or only the work
 * there was when it was made, applied later (`scoped`): the worker attempts unended then and the plans open then, by id.
 */
export type FleetStopScope =
	| { readonly kind: "whole" }
	| { readonly kind: "scoped"; readonly attempts: readonly string[]; readonly plans: readonly string[] };

/** The owner's stop of a session's workers: the reason its ends carry, and what it ends. */
export interface FleetStop {
	readonly reasonCode: string;
	readonly scope: FleetStopScope;
}

/** The stop of everything unended when it is applied. */
export const WHOLE_FLEET_STOP_SCOPE: FleetStopScope = { kind: "whole" };

/**
 * The owner's stop of a session's workers, of what `stop.scope` covers: each open plan it covers closed as cancelled
 * (through `plans`, the session's plan executor, which also releases the plan's prepared dispatches and placed jobs; else
 * in the store, for a session that runs none), then each unended worker attempt it covers cancelled through `cancel` (true
 * when the remote backend took the cancel), both for `stop.reasonCode`. Plans close first, so no step is dispatched again
 * for a lane this stop ends. Returns what it covers that is still unended after it, by why, and how many lanes in flight it
 * stopped: work a scoped stop leaves is neither counted nor reported.
 */
export function stopSessionWorkers(
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "closePlan">,
	plans: OpenPlansStop | undefined,
	cancel: (attempt: AttemptRuntimeState) => boolean,
	{ reasonCode, scope }: FleetStop,
): WorkerStopOutcome {
	const covers = (attempt: AttemptRuntimeState) =>
		scope.kind === "whole" || scope.attempts.includes(attempt.attemptId);
	const coversPlan = (planId: string) => scope.kind === "whole" || scope.plans.includes(planId);
	const inFlight = unendedWorkerAttempts(runtime.getSnapshot()).filter(covers).length;
	if (plans) plans.cancelOpenPlans(OWNER_STOPPED_PLAN_REASON, reasonCode, coversPlan);
	else
		for (const [planId, plan] of Object.entries(runtime.getSnapshot().plans))
			if (!plan.closed && coversPlan(planId))
				runtime.closePlan({ planId, status: "cancelled", reason: OWNER_STOPPED_PLAN_REASON });
	const handed = new Set<string>();
	for (const attempt of unendedWorkerAttempts(runtime.getSnapshot()).filter(covers))
		if (cancel(attempt)) handed.add(attempt.attemptId);
	const unended = unendedSelectedAttempts(runtime.getSnapshot()).filter(covers);
	const own = unended.filter((attempt) => !isManagedWorkerAttempt(attempt));
	const failed = own.filter((attempt) => !handed.has(attempt.attemptId));
	return {
		remote: own.filter((attempt) => handed.has(attempt.attemptId)),
		managed: unended.filter(isManagedWorkerAttempt),
		failed,
		stopped: Math.max(0, inFlight - failed.length),
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
