/**
 * The durable notification of one worker attempt's end. It is recorded when the attempt ends and marked delivered once
 * the result has been handed to whoever started the worker: the root's transcript, or the mailbox of the agent that is
 * its parent. Between the two, the result exists and its recipient has not been told.
 */

import type { AttemptRuntimeState, TaskRuntimeProjection } from "./task-runtime.ts";

/** The id of the notification that carries one attempt's end. */
export function workerTerminalNotificationId(attemptId: string): string {
	return `worker-terminal:${attemptId}`;
}

/**
 * Whether an attempt a parent agent started still owes that agent its result: it has not ended, or it has ended and
 * the handoff that files the parent's next turn has not been delivered yet.
 */
export function owesParentItsResult(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "notifications">,
	attempt: AttemptRuntimeState,
): boolean {
	const agentId = attempt.agentId ?? attempt.dispatch.logicalLaneId ?? attempt.taskId;
	const parentAgentId = snapshot.agents[agentId]?.parentAgentId ?? attempt.dispatch.parentAgentId;
	if (parentAgentId === undefined) return false;
	return snapshot.notifications[workerTerminalNotificationId(attempt.attemptId)]?.status !== "delivered";
}
