import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import {
	DelegationOrchestrationLedger,
	type PrepareDelegationInput,
	type StartedDelegationAttempt,
} from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";

const ACTIVE_ATTEMPT_STATUSES = new Set(["queued", "leased", "running"]);

function terminalStatus(attempt: AttemptRuntimeState): LaneTerminalStatus {
	if (attempt.status === "completed") return "succeeded";
	if (attempt.status === "cancelled") return "canceled";
	const reasonCode = attempt.result?.reasonCode ?? attempt.reasonCode ?? "";
	if (reasonCode.includes("budget")) return "budget_exhausted";
	if (reasonCode.includes("timeout")) return "timeout";
	return "failed";
}

function selectedAttempt(snapshot: TaskRuntimeProjection, taskId: string): AttemptRuntimeState | undefined {
	const task = snapshot.tasks[taskId];
	if (!task) return undefined;
	const attempts = task.attemptIds.map((attemptId) => snapshot.attempts[attemptId]).filter(Boolean);
	return (
		[...attempts].reverse().find((attempt) => attempt && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) ??
		attempts.at(-1)
	);
}

function projectWorkerRecord(snapshot: TaskRuntimeProjection, taskId: string): LaneRecord | undefined {
	const task = snapshot.tasks[taskId];
	const attempt = selectedAttempt(snapshot, taskId);
	if (!task || !attempt) return undefined;
	const objective = snapshot.objectives[task.task.objectiveId];
	const status =
		attempt.status === "queued"
			? "queued"
			: attempt.status === "leased" || attempt.status === "running"
				? "running"
				: terminalStatus(attempt);
	const reasonCode = attempt.result?.reasonCode ?? attempt.reasonCode;
	const goalId = objective?.objective.objectiveId.startsWith("goal:")
		? objective.objective.objectiveId.slice("goal:".length)
		: undefined;
	return {
		laneId: taskId,
		type: "worker",
		status,
		...(reasonCode ? { reasonCode } : {}),
		...(attempt.status !== "queued" ? { startedAt: attempt.createdAt } : {}),
		...(ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ? {} : { completedAt: attempt.updatedAt }),
		...(attempt.result?.usage.costUsd !== undefined ? { costUsd: attempt.result.usage.costUsd } : {}),
		...(goalId ? { goalId } : {}),
	};
}

/**
 * Sole owner of in-process worker lifecycle state. LaneRecord is a compatibility/UI projection;
 * all transitions are committed through DurableTaskRuntime before the projection is returned.
 */
export class WorkerLifecycle {
	readonly ledger: DelegationOrchestrationLedger;
	private nextLaneNumber: number;

	constructor(options: { agentDir: string; sessionId: string; minimumNextLaneNumber?: number }) {
		this.ledger = new DelegationOrchestrationLedger(options);
		const snapshot = this.ledger.runtime.getSnapshot();
		const highest = Object.keys(snapshot.tasks).reduce((current, taskId) => {
			const suffix = /^worker-(\d+)$/.exec(taskId)?.[1];
			return suffix ? Math.max(current, Number(suffix)) : current;
		}, 0);
		this.nextLaneNumber = Math.max(highest + 1, options.minimumNextLaneNumber ?? 1);
	}

	prepare(
		input: Omit<PrepareDelegationInput, "laneId">,
		laneId = `worker-${this.nextLaneNumber++}`,
	): {
		record: LaneRecord;
		attempt: AttemptRuntimeState;
	} {
		const attempt = this.ledger.prepare({ ...input, laneId });
		const record = this.getRecord(laneId);
		if (!record) throw new Error(`Durable worker '${laneId}' was not projected after enqueue.`);
		return { record, attempt };
	}

	start(laneId: string, leaseTtlMs: number): StartedDelegationAttempt {
		const attempt = this.requireActiveAttempt(laneId);
		return this.ledger.start(attempt.attemptId, leaseTtlMs);
	}

	bindGrant(attemptId: string, grantId: string): void {
		this.ledger.runtime.bindAttemptGrant(attemptId, grantId);
	}

	finish(result: WorkerResultContract): LaneRecord {
		this.ledger.runtime.finishAttempt(result);
		const record = this.getRecord(result.taskId);
		if (!record) throw new Error(`Durable worker '${result.taskId}' was not projected after completion.`);
		this.enqueueTerminalNotification(record);
		return record;
	}

	cancel(laneId: string, reasonCode: string): LaneRecord | undefined {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt) return this.getRecord(laneId);
		this.ledger.cancel(attempt.attemptId, reasonCode);
		const record = this.getRecord(laneId);
		if (record) this.enqueueTerminalNotification(record);
		return record;
	}

	recoverQueued(): Array<{ record: LaneRecord; attempt: AttemptRuntimeState }> {
		return this.ledger.recoverQueuedDispatches().flatMap((attempt) => {
			const record = this.getRecord(attempt.taskId);
			return record ? [{ record, attempt }] : [];
		});
	}

	getRecords(): LaneRecord[] {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).flatMap((taskId) => {
			const record = projectWorkerRecord(snapshot, taskId);
			return record ? [record] : [];
		});
	}

	getRecord(laneId: string): LaneRecord | undefined {
		return projectWorkerRecord(this.ledger.runtime.getSnapshot(), laneId);
	}

	getActiveAttempt(laneId: string): AttemptRuntimeState | undefined {
		return selectedAttempt(this.ledger.runtime.getSnapshot(), laneId);
	}

	getRunningCount(profileId?: string): number {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).filter((taskId) => {
			const attempt = selectedAttempt(snapshot, taskId);
			return attempt?.status === "running" && (!profileId || attempt.dispatch.profileId === profileId);
		}).length;
	}

	getPendingTerminalNotifications(): Array<{ notificationId: string; record: LaneRecord }> {
		this.ensureTerminalNotifications();
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.values(snapshot.notifications).flatMap((notification) => {
			if (notification.status !== "pending" || !notification.attemptId) return [];
			const attempt = snapshot.attempts[notification.attemptId];
			if (!attempt) return [];
			const record = projectWorkerRecord(snapshot, attempt.taskId);
			if (!record || record.status === "queued" || record.status === "running") return [];
			return [{ notificationId: notification.notificationId, record }];
		});
	}

	getTerminalNotification(
		laneId: string,
	): { notificationId: string; status: "pending" | "delivered"; record: LaneRecord } | undefined {
		const record = this.getRecord(laneId);
		if (!record || record.status === "queued" || record.status === "running") return undefined;
		this.enqueueTerminalNotification(record);
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt) return undefined;
		const notificationId = `worker-terminal:${attempt.attemptId}`;
		const notification = this.ledger.runtime.getSnapshot().notifications[notificationId];
		return notification ? { notificationId, status: notification.status, record } : undefined;
	}

	markNotificationsDelivered(notificationIds: readonly string[]): void {
		for (const notificationId of notificationIds) this.ledger.runtime.markNotificationDelivered(notificationId);
	}

	private ensureTerminalNotifications(): void {
		const snapshot = this.ledger.runtime.getSnapshot();
		for (const taskId of Object.keys(snapshot.tasks)) {
			const record = projectWorkerRecord(snapshot, taskId);
			if (record && record.status !== "queued" && record.status !== "running") {
				this.enqueueTerminalNotification(record);
			}
		}
	}

	private enqueueTerminalNotification(record: LaneRecord): void {
		const attempt = this.getActiveAttempt(record.laneId);
		if (!attempt || ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return;
		const snapshot = this.ledger.runtime.getSnapshot();
		const task = snapshot.tasks[attempt.taskId];
		if (!task) return;
		this.ledger.runtime.enqueueNotification({
			notificationId: `worker-terminal:${attempt.attemptId}`,
			objectiveId: task.task.objectiveId,
			attemptId: attempt.attemptId,
			message: `Worker ${record.laneId} reached ${record.status}.`,
		});
	}

	private requireActiveAttempt(laneId: string): AttemptRuntimeState {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
			throw new Error(`Durable worker '${laneId}' has no active attempt.`);
		}
		return attempt;
	}
}
