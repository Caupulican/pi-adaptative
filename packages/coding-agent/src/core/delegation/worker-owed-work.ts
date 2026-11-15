/**
 * What a session's worker bundle owes the session's next open, read from its durable projection alone, with no process
 * running it: the work its recovery takes up at the open (a queued attempt, one suspended because its owner process is
 * gone, one whose lease holder is proven dead, a result still waiting for its independent verification), the ends it has
 * not told the session of (a terminal notification not delivered, the owner's stops excepted) and the receipts it has not
 * delivered; and the retries it waits on, owed once their time comes. A managed lane's attempt runs in a process the host
 * never starts or resumes, so it owes nothing here; an attempt an owner or root suspended waits for an explicit resume.
 */

import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { workerReceiptPublicationPending } from "../orchestration/worker-receipt-publication.ts";
import { workerTerminalNotificationId } from "../orchestration/worker-terminal-notification.ts";
import { isOwnerStoppedEnd } from "./worker-fleet-stop.ts";
import {
	attemptAwaitsVerification,
	isManagedWorkerAttempt,
	NONTERMINAL_WORKER_ATTEMPT_STATUSES,
	projectWorkerAttemptLaneRecord,
	selectedWorkerAttempt,
} from "./worker-lane-projection.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";
import { ownerLostSuspension } from "./worker-recovery-coordinator.ts";

/** What a bundle owes, as its projection read: `owed` whatever the clock reads, the rest by the clock and the processes. */
export interface WorkerWorkFacts {
	readonly owed: boolean;
	/** The recorded retry time of each attempt suspended until a retry. */
	readonly retriesAt: readonly number[];
	/** The lease holders of attempts leased or running: owed once proven dead. */
	readonly leaseOwners: readonly string[];
}

/** The facts of {@link WorkerWorkFacts} in `snapshot`. */
export function workerWorkFacts(snapshot: TaskRuntimeProjection): WorkerWorkFacts {
	const retriesAt: number[] = [];
	const leaseOwners: string[] = [];
	let owed = Object.values(snapshot.attempts).some(
		(attempt) =>
			Object.keys(attempt.usageReceipts ?? {}).length > 0 ||
			Object.keys(attempt.parentWrites ?? {}).length > 0 ||
			workerReceiptPublicationPending(snapshot, attempt),
	);
	// A pending end of an attempt its task no longer selects is replayed at the open as well.
	owed ||= Object.values(snapshot.notifications).some(
		(notification) =>
			notification.status === "pending" &&
			notification.attemptId !== undefined &&
			endNotOwnerStopped(snapshot, notification.attemptId),
	);
	for (const taskId of Object.keys(snapshot.tasks)) {
		const attempt = selectedWorkerAttempt(snapshot, taskId);
		if (!attempt) continue;
		if (!NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status)) {
			// The open enqueues the end of the selected attempt when no notification holds it yet.
			if (snapshot.notifications[workerTerminalNotificationId(attempt.attemptId)]?.status !== "delivered")
				owed ||= endNotOwnerStopped(snapshot, attempt.attemptId);
			owed ||= attemptAwaitsVerification(snapshot, attempt) && !verifierUnended(snapshot, taskId);
			continue;
		}
		if (isManagedWorkerAttempt(attempt)) continue;
		if (attempt.status === "queued") owed = true;
		else if (attempt.status === "suspended") {
			const retryAt = attempt.retry ? Date.parse(attempt.retry.notBefore) : undefined;
			if (retryAt !== undefined && Number.isFinite(retryAt)) retriesAt.push(retryAt);
			else owed ||= attempt.retry !== undefined || ownerLostSuspension(attempt);
		} else if (attempt.lease) leaseOwners.push(attempt.lease.ownerId);
		else owed = true;
	}
	return { owed, retriesAt, leaseOwners };
}

/** Whether the attempt has ended (as its lane reads) other than by the owner's stop. */
function endNotOwnerStopped(snapshot: TaskRuntimeProjection, attemptId: string): boolean {
	const record = projectWorkerAttemptLaneRecord(snapshot, attemptId);
	return (
		record !== undefined && record.status !== "queued" && record.status !== "running" && !isOwnerStoppedEnd(record)
	);
}

/** Whether a verification task of `taskId` has an attempt that has not ended: that attempt is the work owed, not the subject. */
function verifierUnended(snapshot: TaskRuntimeProjection, taskId: string): boolean {
	return Object.entries(snapshot.tasks).some(([verifierTaskId, task]) => {
		if (task.task.verificationOfTaskId !== taskId) return false;
		const attempt: AttemptRuntimeState | undefined = selectedWorkerAttempt(snapshot, verifierTaskId);
		return attempt !== undefined && NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status);
	});
}

/** Whether the bundle owes its session's open at `nowMs`: owed outright, a retry due, or a lease holder proven dead. */
export function owesWorkerWorkAt(
	facts: WorkerWorkFacts,
	nowMs: number,
	isProcessAlive: (pid: number) => boolean = isLocalProcessAlive,
): boolean {
	return (
		facts.owed ||
		facts.retriesAt.some((at) => at <= nowMs) ||
		facts.leaseOwners.some((ownerId) => isLocalWorkerProcessOwnerProvenDead(ownerId, isProcessAlive))
	);
}

/** The earliest retry the bundle waits on after `nowMs`; undefined when none. */
export function nextWorkerRetryAt(facts: WorkerWorkFacts, nowMs: number): number | undefined {
	const later = facts.retriesAt.filter((at) => at > nowMs);
	return later.length > 0 ? Math.min(...later) : undefined;
}
