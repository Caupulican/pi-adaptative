/**
 * How long an ordinary request waits on the worker attempts it launched before the host has it check on them. A request
 * waits without a judgment while such an attempt owes its result (`ordinary-work-settlement.ts`); past this bound the wait
 * is a host fact that spends one of its continuations on checking the worker, so a hung or forgotten worker never keeps
 * a request waiting unseen. Pure reads; the controller arms the alarm.
 */
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "./goals/goal-continuation-defaults.ts";
import { modelTransferIsPending } from "./orchestration/model-transfer.ts";
import {
	type AttemptRuntimeState,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
} from "./orchestration/task-runtime-state.ts";
import type { OrdinaryWorkRecord } from "./ordinary-work-store.ts";

/** The same bound as a goal's never-hang wait on a bound worker. */
export const ORDINARY_WORK_WORKER_WAIT_MS = DEFAULT_GOAL_WORKER_WAIT_MS;

/** After an expired wait asked for a review the session could not start yet, the alarm asks again this much later. */
export const ORDINARY_WORK_WAIT_RECHECK_MS = 5 * 60_000;

/**
 * The worker attempts dispatched from the request's own turns (`entries`) that have not reached a terminal status, read
 * by each attempt's receipt origin (a model-transfer successor inherits it). A suspended attempt counts: every
 * suspension (restart, retry, interrupt, model transfer) parks work its lane still owes. So does a source a model
 * transfer cancelled before its reserved successor was admitted.
 */
export function pendingLaunchedAttempts(
	snapshot: TaskRuntimeProjection,
	sessionId: string,
	entries: readonly SessionEntry[],
): AttemptRuntimeState[] {
	const scope = new Set(entries.map((entry) => entry.id));
	return Object.values(snapshot.attempts).filter((attempt) => {
		const origin = attempt.dispatch.receiptOrigin;
		return (
			origin?.sessionId === sessionId &&
			scope.has(origin.leafId) &&
			(!terminalAttemptStatus(attempt.status) || modelTransferIsPending(attempt.modelTransfer))
		);
	});
}

/**
 * When a request waiting on `pending` runs out of wait, on the controller's clock (`now`): the bound after it started
 * waiting, or after the latest retry a pending attempt was given, so a worker waiting out a usage reset or a backoff is
 * not checked on before it could run. A retry's instant is stamped on the orchestration clock (`orchestrationNow`) and
 * carried over as its offset. Undefined unless the request waits on work it launched.
 */
export function ordinaryWorkerWaitDeadline(
	record: OrdinaryWorkRecord,
	pending: readonly AttemptRuntimeState[],
	now: number,
	orchestrationNow: number,
): number | undefined {
	if (record.status !== "waiting" || record.reason !== "waiting" || !pending.length) return undefined;
	let deadline = record.updatedAt + ORDINARY_WORK_WORKER_WAIT_MS;
	for (const attempt of pending) {
		const retryAt = attempt.retry ? Date.parse(attempt.retry.notBefore) : Number.NaN;
		if (Number.isFinite(retryAt))
			deadline = Math.max(deadline, now + (retryAt - orchestrationNow) + ORDINARY_WORK_WORKER_WAIT_MS);
	}
	return deadline;
}
