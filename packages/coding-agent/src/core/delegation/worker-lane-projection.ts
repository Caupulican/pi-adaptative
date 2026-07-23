import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";

export const ACTIVE_WORKER_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "leased", "running"]);

function terminalStatus(attempt: AttemptRuntimeState): LaneTerminalStatus {
	if (attempt.status === "completed") return "succeeded";
	if (attempt.status === "cancelled") return "canceled";
	const reasonCode = attempt.result?.reasonCode ?? attempt.reasonCode ?? "";
	if (reasonCode.includes("budget")) return "budget_exhausted";
	if (reasonCode.includes("timeout")) return "timeout";
	return "failed";
}

export function selectedWorkerAttempt(
	snapshot: TaskRuntimeProjection,
	taskId: string,
): AttemptRuntimeState | undefined {
	const task = snapshot.tasks[taskId];
	if (!task) return undefined;
	const attempts = task.attemptIds.map((attemptId) => snapshot.attempts[attemptId]).filter(Boolean);
	return (
		[...attempts].reverse().find((attempt) => attempt && ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status)) ??
		attempts.at(-1)
	);
}

/**
 * One-way compatibility projection from durable orchestration state. A LaneRecord is never read
 * back to decide lifecycle, retry, verification, or notification transitions.
 */
export function projectWorkerLaneRecord(snapshot: TaskRuntimeProjection, taskId: string): LaneRecord | undefined {
	const task = snapshot.tasks[taskId];
	const attempt = selectedWorkerAttempt(snapshot, taskId);
	if (!task || !attempt) return undefined;
	const objective = snapshot.objectives[task.task.objectiveId];
	const awaitingVerification =
		attempt.result?.nextAction === "independent_verification_required" && task.verification === undefined;
	const status = awaitingVerification
		? "running"
		: task.verification
			? task.verification.verdict === "accepted"
				? "succeeded"
				: "failed"
			: attempt.status === "queued"
				? "queued"
				: attempt.status === "leased" || attempt.status === "running"
					? "running"
					: terminalStatus(attempt);
	const reasonCode = task.verification?.reasonCode ?? attempt.result?.reasonCode ?? attempt.reasonCode;
	const goalId = objective?.objective.objectiveId.startsWith("goal:")
		? objective.objective.objectiveId.slice("goal:".length)
		: undefined;
	return {
		laneId: taskId,
		type: "worker",
		status,
		...(reasonCode ? { reasonCode } : {}),
		...(attempt.status !== "queued" ? { startedAt: attempt.createdAt } : {}),
		...(status === "queued" || status === "running"
			? {}
			: { completedAt: task.verification?.completedAt ?? attempt.updatedAt }),
		...(attempt.result?.usage.costUsd !== undefined ? { costUsd: attempt.result.usage.costUsd } : {}),
		...(goalId ? { goalId } : {}),
	};
}
