import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { deriveWorkerTaskLabel } from "./worker-task-label.ts";

export const ACTIVE_WORKER_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "leased", "running"]);
export const NONTERMINAL_WORKER_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
	...ACTIVE_WORKER_ATTEMPT_STATUSES,
	"suspended",
]);

export function isManagedWorkerAttempt(attempt: AttemptRuntimeState): boolean {
	return attempt.dispatch.executionKind === "managed-process";
}

function terminalStatus(attempt: AttemptRuntimeState): LaneTerminalStatus {
	if (attempt.status === "completed") return "succeeded";
	if (attempt.status === "cancelled") return "canceled";
	// Budget/timeout reasonCodes take priority over the claim-level result.status: a worker can
	// finish its claim as "partial" (or "blocked") on the same attempt where it also blew the cost
	// or wall-clock budget, and that resource-exhaustion signal must not be shadowed.
	const reasonCode = attempt.result?.reasonCode ?? attempt.reasonCode ?? "";
	if (reasonCode.includes("budget")) return "budget_exhausted";
	if (reasonCode.includes("timeout")) return "timeout";
	if (attempt.result?.status === "partial") return "partial";
	if (attempt.result?.status === "blocked") return "blocked";
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
		[...attempts].reverse().find((attempt) => attempt && NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status)) ??
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
	const managed = isManagedWorkerAttempt(attempt);
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
				: attempt.status === "leased" || attempt.status === "running" || attempt.status === "suspended"
					? "running"
					: terminalStatus(attempt);
	const reasonCode = task.verification?.reasonCode ?? attempt.result?.reasonCode ?? attempt.reasonCode;
	const genericTitle = `Delegated ${task.task.role} work`;
	const label = deriveWorkerTaskLabel(
		task.task.title === genericTitle ? task.task.description : task.task.title,
		genericTitle,
	);
	const goalId = objective?.objective.objectiveId.startsWith("goal:")
		? objective.objective.objectiveId.slice("goal:".length)
		: undefined;
	return {
		laneId: managed ? (attempt.dispatch.logicalLaneId ?? taskId) : taskId,
		type: managed ? "tmux-worker" : "worker",
		status,
		label,
		profileId: attempt.dispatch.profileId,
		...(attempt.dispatch.executionContract
			? {
					modelRef: `${attempt.dispatch.executionContract.worker.modelBinding.provider}/${attempt.dispatch.executionContract.worker.modelBinding.modelId}`,
					thinkingLevel: attempt.dispatch.executionContract.worker.modelBinding.thinkingLevel,
				}
			: {}),
		...(reasonCode ? { reasonCode } : {}),
		...(attempt.status !== "queued" ? { startedAt: attempt.createdAt } : {}),
		...(status === "queued" || status === "running"
			? {}
			: { completedAt: task.verification?.completedAt ?? attempt.updatedAt }),
		...(attempt.result?.usage.costUsd !== undefined ? { costUsd: attempt.result.usage.costUsd } : {}),
		...(goalId ? { goalId } : {}),
		...(attempt.dispatch.worktreeLaneKey ? { worktreeLaneKey: attempt.dispatch.worktreeLaneKey } : {}),
	};
}

/** Latest durable turn for each externally managed logical lane. */
export function projectManagedWorkerLaneRecords(snapshot: TaskRuntimeProjection): LaneRecord[] {
	const latest = new Map<string, { sequence: number; createdAt: string; record: LaneRecord }>();
	for (const taskId of Object.keys(snapshot.tasks)) {
		const attempt = selectedWorkerAttempt(snapshot, taskId);
		if (!attempt || !isManagedWorkerAttempt(attempt)) continue;
		const record = projectWorkerLaneRecord(snapshot, taskId);
		if (!record) continue;
		const sequence = attempt.dispatch.dispatchSequence ?? 1;
		const current = latest.get(record.laneId);
		if (
			!current ||
			sequence > current.sequence ||
			(sequence === current.sequence && attempt.createdAt.localeCompare(current.createdAt) > 0)
		) {
			latest.set(record.laneId, { sequence, createdAt: attempt.createdAt, record });
		}
	}
	return [...latest.values()].map((entry) => entry.record);
}

export function selectedManagedWorkerAttempt(
	snapshot: TaskRuntimeProjection,
	logicalLaneId: string,
): AttemptRuntimeState | undefined {
	return Object.values(snapshot.attempts)
		.filter((attempt) => isManagedWorkerAttempt(attempt) && attempt.dispatch.logicalLaneId === logicalLaneId)
		.sort((left, right) => {
			const sequence = (left.dispatch.dispatchSequence ?? 1) - (right.dispatch.dispatchSequence ?? 1);
			return sequence !== 0 ? sequence : left.createdAt.localeCompare(right.createdAt);
		})
		.at(-1);
}
