/**
 * What a session's worker bundle owes the session's next open, read from its durable projection alone, with no process
 * running it, in two kinds. Execution: work its recovery runs at the open (a queued attempt, one suspended because its owner
 * process is gone, an unbound lease whose holder is proven dead or whose term ended, a result still waiting for its
 * independent verification), a reason to keep the session open as well as to open it; and the retries and lease terms it
 * waits on, owed once their time comes. Delivery: what the open hands over (a receipt publishable now, a usage receipt, a
 * parent write, an end not delivered, the owner's stops excepted), which only a try can show deliverable. A managed lane's
 * attempt runs in a process the host never starts or resumes, so it owes nothing here; an attempt an owner or root
 * suspended waits for an explicit resume.
 */

import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { deliverableWorkerReceipt } from "../orchestration/worker-receipt-publication.ts";
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

/** A lease on a leased or running attempt: its holder, the end of its term, and whether an agent is bound to the attempt. */
export interface WorkerLeaseFact {
	readonly ownerId: string;
	readonly expiresAt: number;
	readonly bound: boolean;
}

/** What a bundle owes, as its projection read: `execution` and `deliveryItems` whatever the clock reads, the rest by the clock. */
export interface WorkerWorkFacts {
	/** Work the open runs now. */
	readonly execution: boolean;
	/**
	 * What the open delivers, when a try can deliver it, one id per item: a usage receipt, a parent write, a publishable
	 * receipt, an end's notification. A commit that changes none of them (a lease renewed) leaves the list as it was.
	 */
	readonly deliveryItems: readonly string[];
	/** The recorded retry time of each attempt suspended until a retry. */
	readonly retriesAt: readonly number[];
	/** The leases of attempts leased or running. */
	readonly leases: readonly WorkerLeaseFact[];
}

/** The facts of {@link WorkerWorkFacts} in `snapshot`. */
export function workerWorkFacts(snapshot: TaskRuntimeProjection): WorkerWorkFacts {
	const retriesAt: number[] = [];
	const leases: WorkerLeaseFact[] = [];
	const delivery = new Set<string>();
	for (const attempt of Object.values(snapshot.attempts)) {
		for (const id of Object.keys(attempt.usageReceipts ?? {})) delivery.add(`usage:${attempt.attemptId}:${id}`);
		for (const id of Object.keys(attempt.parentWrites ?? {})) delivery.add(`parent:${attempt.attemptId}:${id}`);
		// The same reading the open's receipt deliveries take: a receipt they would skip is not owed.
		if (deliverableWorkerReceipt(snapshot, attempt) !== undefined) delivery.add(`receipt:${attempt.attemptId}`);
	}
	// A pending end of an attempt its task no longer selects is replayed at the open as well.
	for (const [id, notification] of Object.entries(snapshot.notifications))
		if (
			notification.status === "pending" &&
			notification.attemptId !== undefined &&
			endNotOwnerStopped(snapshot, notification.attemptId)
		)
			delivery.add(`notification:${id}`);
	let execution = false;
	for (const taskId of Object.keys(snapshot.tasks)) {
		const attempt = selectedWorkerAttempt(snapshot, taskId);
		if (!attempt) continue;
		if (!NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status)) {
			// The open enqueues the end of the selected attempt when no notification holds it yet.
			const notificationId = workerTerminalNotificationId(attempt.attemptId);
			if (
				snapshot.notifications[notificationId]?.status !== "delivered" &&
				endNotOwnerStopped(snapshot, attempt.attemptId)
			)
				delivery.add(`notification:${notificationId}`);
			execution ||= attemptAwaitsVerification(snapshot, attempt) && !verifierUnended(snapshot, taskId);
			continue;
		}
		if (isManagedWorkerAttempt(attempt)) continue;
		if (attempt.status === "queued") execution = true;
		else if (attempt.status === "suspended") {
			const retryAt = attempt.retry ? Date.parse(attempt.retry.notBefore) : undefined;
			if (retryAt !== undefined && Number.isFinite(retryAt)) retriesAt.push(retryAt);
			else execution ||= attempt.retry !== undefined || ownerLostSuspension(attempt);
		} else if (attempt.lease) {
			const expiresAt = Date.parse(attempt.lease.expiresAt);
			leases.push({
				ownerId: attempt.lease.ownerId,
				// A term that does not read has ended: the holder's proof alone keeps it.
				expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.NEGATIVE_INFINITY,
				bound: attempt.agentId !== undefined,
			});
		} else execution = true;
	}
	return { execution, deliveryItems: [...delivery].sort(), retriesAt, leases };
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

/**
 * Whether the bundle owes its session's open execution at `nowMs`: work to run now, a retry due, or a lease the open's
 * recovery takes back: its holder proven dead, or, for an attempt no agent is bound to, its term ended (an agent-bound
 * attempt's lease is taken back only from a holder proven dead).
 */
export function owesWorkerExecutionAt(
	facts: WorkerWorkFacts,
	nowMs: number,
	isProcessAlive: (pid: number) => boolean = isLocalProcessAlive,
): boolean {
	return (
		facts.execution ||
		facts.retriesAt.some((at) => at <= nowMs) ||
		facts.leases.some(
			(lease) =>
				(!lease.bound && lease.expiresAt <= nowMs) ||
				isLocalWorkerProcessOwnerProvenDead(lease.ownerId, isProcessAlive),
		)
	);
}

/** The earliest time after `nowMs` execution comes due: a retry, or the end of an unbound lease's term; undefined when none. */
export function nextWorkerDueAt(facts: WorkerWorkFacts, nowMs: number): number | undefined {
	const later = [
		...facts.retriesAt,
		...facts.leases.filter((lease) => !lease.bound).map((lease) => lease.expiresAt),
	].filter((at) => at > nowMs);
	return later.length > 0 ? Math.min(...later) : undefined;
}
