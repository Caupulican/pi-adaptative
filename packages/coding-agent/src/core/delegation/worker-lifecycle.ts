import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import {
	DelegationOrchestrationLedger,
	type PrepareDelegationInput,
	type StartedDelegationAttempt,
} from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import {
	ACTIVE_WORKER_ATTEMPT_STATUSES,
	projectWorkerLaneRecord,
	selectedWorkerAttempt,
} from "./worker-lane-projection.ts";

export type PendingVerificationRecovery =
	| {
			action: "dispatch";
			subjectTaskId: string;
			implementationProfileId: string;
			summary: string;
			artifactUris: readonly string[];
	  }
	| {
			action: "reconcile";
			subjectTaskId: string;
			verifierTaskId: string;
			verifierAttemptId: string;
			verdict: "accepted" | "rejected" | "inconclusive";
			reasonCode: string;
	  };

/**
 * Sole owner of in-process worker lifecycle state. LaneRecord is a compatibility/UI projection;
 * all transitions are committed through DurableTaskRuntime before the projection is returned.
 */
export class WorkerLifecycle {
	readonly ledger: DelegationOrchestrationLedger;
	private nextLaneNumber: number;

	constructor(options: { agentDir: string; sessionId: string }) {
		this.ledger = new DelegationOrchestrationLedger(options);
		const snapshot = this.ledger.runtime.getSnapshot();
		const highest = Object.keys(snapshot.tasks).reduce((current, taskId) => {
			const suffix = /^worker-(\d+)$/.exec(taskId)?.[1];
			return suffix ? Math.max(current, Number(suffix)) : current;
		}, 0);
		this.nextLaneNumber = highest + 1;
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

	finish(result: WorkerResultContract, options: { notify?: boolean } = {}): LaneRecord {
		this.ledger.runtime.finishAttempt(result);
		const record = this.getRecord(result.taskId);
		if (!record) throw new Error(`Durable worker '${result.taskId}' was not projected after completion.`);
		if (options.notify !== false) this.enqueueTerminalNotification(record);
		return record;
	}

	reconcileVerification(args: {
		subjectTaskId: string;
		verifierTaskId: string;
		verifierAttemptId: string;
		verdict: "accepted" | "rejected" | "inconclusive";
		reasonCode: string;
	}): LaneRecord {
		this.ledger.runtime.finishVerification({
			taskId: args.subjectTaskId,
			verifierTaskId: args.verifierTaskId,
			verifierAttemptId: args.verifierAttemptId,
			verdict: args.verdict,
			reasonCode: args.reasonCode,
		});
		const subject = this.getRecord(args.subjectTaskId);
		if (!subject) throw new Error(`Verified worker '${args.subjectTaskId}' was not projected.`);
		this.enqueueTerminalNotification(subject);
		return subject;
	}

	cancel(laneId: string, reasonCode: string): LaneRecord | undefined {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt) return this.getRecord(laneId);
		this.ledger.cancel(attempt.attemptId, reasonCode);
		const record = this.getRecord(laneId);
		if (record) this.enqueueTerminalNotification(record);
		return record;
	}

	recoverQueued(): Array<{
		record: LaneRecord;
		attempt: AttemptRuntimeState;
		verificationOfTaskId?: string;
	}> {
		return this.ledger.recoverQueuedDispatches().flatMap((attempt) => {
			const record = this.getRecord(attempt.taskId);
			const task = this.ledger.runtime.getSnapshot().tasks[attempt.taskId]?.task;
			return record
				? [
						{
							record,
							attempt,
							...(task?.verificationOfTaskId ? { verificationOfTaskId: task.verificationOfTaskId } : {}),
						},
					]
				: [];
		});
	}

	/** Close crash windows between implementation completion, verifier dispatch, and reconciliation. */
	getPendingVerificationRecoveries(): PendingVerificationRecovery[] {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.values(snapshot.tasks).flatMap<PendingVerificationRecovery>((subject) => {
			if (subject.verification) return [];
			const implementationAttempt = selectedWorkerAttempt(snapshot, subject.task.taskId);
			if (implementationAttempt?.result?.nextAction !== "independent_verification_required") return [];
			const verifier = Object.values(snapshot.tasks)
				.filter((candidate) => candidate.task.verificationOfTaskId === subject.task.taskId)
				.sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt))
				.at(-1);
			if (!verifier) {
				return [
					{
						action: "dispatch" as const,
						subjectTaskId: subject.task.taskId,
						implementationProfileId: implementationAttempt.dispatch.profileId,
						summary: implementationAttempt.result.summary,
						artifactUris: implementationAttempt.result.artifacts.map((artifact) => artifact.uri),
					},
				];
			}
			const verifierAttempt = selectedWorkerAttempt(snapshot, verifier.task.taskId);
			if (!verifierAttempt || ACTIVE_WORKER_ATTEMPT_STATUSES.has(verifierAttempt.status)) return [];
			const review = verifierAttempt.result?.evidence.find(
				(evidence) => evidence.kind === "review" && evidence.metadata?.subjectTaskId === subject.task.taskId,
			);
			const verdictValue = review?.metadata?.verdict;
			const verdict =
				review?.trusted && (verdictValue === "accepted" || verdictValue === "rejected")
					? verdictValue
					: "inconclusive";
			const reasonCodesValue = review?.metadata?.reasonCodes;
			const reasonCodes = Array.isArray(reasonCodesValue)
				? reasonCodesValue.filter((reasonCode): reasonCode is string => typeof reasonCode === "string")
				: [];
			return [
				{
					action: "reconcile" as const,
					subjectTaskId: subject.task.taskId,
					verifierTaskId: verifier.task.taskId,
					verifierAttemptId: verifierAttempt.attemptId,
					verdict,
					reasonCode:
						verdict === "accepted"
							? "independent_verification_accepted"
							: verdict === "rejected"
								? `independent_verification_rejected:${reasonCodes.join(",") || "unspecified"}`
								: `independent_verification_inconclusive:${verifierAttempt.reasonCode ?? verifierAttempt.result?.reasonCode ?? "interrupted"}`,
				},
			];
		});
	}

	getTask(taskId: string): TaskRuntimeProjection["tasks"][string] | undefined {
		return this.ledger.runtime.getSnapshot().tasks[taskId];
	}

	getTaskRuntimeSnapshot(): TaskRuntimeProjection {
		return this.ledger.runtime.getSnapshot();
	}

	getRecords(): LaneRecord[] {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).flatMap((taskId) => {
			const record = projectWorkerLaneRecord(snapshot, taskId);
			return record ? [record] : [];
		});
	}

	getRecord(laneId: string): LaneRecord | undefined {
		return projectWorkerLaneRecord(this.ledger.runtime.getSnapshot(), laneId);
	}

	getActiveAttempt(laneId: string): AttemptRuntimeState | undefined {
		return selectedWorkerAttempt(this.ledger.runtime.getSnapshot(), laneId);
	}

	getRunningCount(profileId?: string): number {
		const snapshot = this.ledger.runtime.getSnapshot();
		return Object.keys(snapshot.tasks).filter((taskId) => {
			const attempt = selectedWorkerAttempt(snapshot, taskId);
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
			const record = projectWorkerLaneRecord(snapshot, attempt.taskId);
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
			const record = projectWorkerLaneRecord(snapshot, taskId);
			if (record && record.status !== "queued" && record.status !== "running") {
				this.enqueueTerminalNotification(record);
			}
		}
	}

	private enqueueTerminalNotification(record: LaneRecord): void {
		const attempt = this.getActiveAttempt(record.laneId);
		if (!attempt || ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status)) return;
		const snapshot = this.ledger.runtime.getSnapshot();
		const task = snapshot.tasks[attempt.taskId];
		if (!task) return;
		if (attempt.result?.nextAction === "independent_verification_required" && !task.verification) return;
		this.ledger.runtime.enqueueNotification({
			notificationId: `worker-terminal:${attempt.attemptId}`,
			objectiveId: task.task.objectiveId,
			attemptId: attempt.attemptId,
			message: `Worker ${record.laneId} reached ${record.status}.`,
		});
	}

	private requireActiveAttempt(laneId: string): AttemptRuntimeState {
		const attempt = this.getActiveAttempt(laneId);
		if (!attempt || !ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status)) {
			throw new Error(`Durable worker '${laneId}' has no active attempt.`);
		}
		return attempt;
	}
}
