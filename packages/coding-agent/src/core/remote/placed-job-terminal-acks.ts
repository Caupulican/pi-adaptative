/**
 * Placed-job terminal acknowledgement: the worker terminal of a job the job runner placed is marked delivered once the runner
 * has reported that job's end to the placing machine, so the foreground never hears a placed job's worker finish. It owns the
 * deferred, once-per-reference passes that do this, and the route that claims a placed job's worker terminal for the job runner;
 * the worker lifecycle they read belongs to the caller.
 */
import type { WorkerLifecycle } from "../delegation/worker-lifecycle.ts";
import { placedJobRef } from "./job-protocol.ts";
import { placedJobFinished } from "./job-store.ts";

/** What an acknowledgement reads from its owner: the live worker lifecycle, the agent directory, and whether it is disposed. */
export interface PlacedJobAckPorts {
	lifecycle(): WorkerLifecycle | undefined;
	agentDir(): string;
	isDisposed(): boolean;
}

export class PlacedJobTerminalAcks {
	private readonly ports: PlacedJobAckPorts;
	/** References with a pass queued and not yet run: one queued pass per reference. */
	private readonly queued = new Set<string>();

	constructor(ports: PlacedJobAckPorts) {
		this.ports = ports;
	}

	/**
	 * Queues one pass for the references not already queued, and returns before it runs: reading a terminal can append to the
	 * runtime, and a caller may be inside a lane-record listener. A lane with no terminal yet is left as it is.
	 */
	acknowledge(references: readonly string[]): void {
		const fresh = references.filter((ref) => !this.queued.has(ref));
		if (fresh.length === 0) return;
		for (const ref of fresh) this.queued.add(ref);
		queueMicrotask(() => {
			for (const ref of fresh) this.queued.delete(ref);
			if (this.ports.isDisposed()) return;
			markPlacedJobTerminalsDelivered(this.ports.lifecycle(), fresh);
		});
	}

	/**
	 * Whether the job runner owns a worker terminal: the attempt's dispatch names a placed job (that origin only the runner
	 * mints, durable from admission). When the runner has already recorded the job's outcome (it ended the job, e.g. after
	 * a restart), the terminal is settled as it arrives, so nothing waits for a runner that will not come back for it.
	 */
	routeOwns(attemptId: string | undefined): boolean {
		if (attemptId === undefined) return false;
		const ref = placedJobRef(
			this.ports.lifecycle()?.getTaskRuntimeSnapshot().attempts[attemptId]?.dispatch.turnOrigin,
		);
		if (ref === undefined) return false;
		if (placedJobFinished(this.ports.agentDir(), ref)) this.acknowledge([ref]);
		return true;
	}
}

/** The pass itself: only a terminal still pending is marked delivered. */
function markPlacedJobTerminalsDelivered(lifecycle: WorkerLifecycle | undefined, references: readonly string[]): void {
	if (!lifecycle) return;
	const wanted = new Set(references);
	const notificationIds = Object.values(lifecycle.getTaskRuntimeSnapshot().attempts).flatMap((attempt) => {
		const ref = placedJobRef(attempt.dispatch.turnOrigin);
		if (ref === undefined || !wanted.has(ref)) return [];
		const terminal = lifecycle.getAttemptTerminalNotification(attempt.attemptId);
		return terminal?.status === "pending" ? [terminal.notificationId] : [];
	});
	lifecycle.markNotificationsDelivered(notificationIds);
}
