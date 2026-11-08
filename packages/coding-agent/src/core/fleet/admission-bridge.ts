/**
 * The admission bridge: the ordered exits that decide whether a queued local lane starts now, waits (and on what), or
 * is cancelled. The worker controller supplies the facts through a thin port (its durable attempt, readiness, resolved
 * admission, the foreground hold and the write reservation); room is the fleet's decision. Exits, in order:
 *
 * 1. a scheduled retry that is not due yet waits;
 * 2. a lane without an active attempt is cancelled;
 * 3. a queued or suspended attempt whose dependencies or objective are not ready waits; a blocked one is cancelled;
 * 4. an admission the worker can no longer pass is cancelled;
 * 5. the machine-wide emergency stop holds it;
 * 6. an attempt on the foreground's local model waits for the foreground turn;
 * 7. without fleet room it waits on the binding room term;
 * 8. the write reservation decides: granted starts, denied cancels, blocked waits.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../delegation/worker-delegation-request.ts";
import type { WorkerDispatchAdmission } from "../delegation/worker-dispatch-scheduler.ts";
import {
	formatWorkerWriteReservationBlock,
	type WorkerWriteReservationAdmission,
} from "../delegation/worker-write-reservation-coordinator.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { AttemptDispatchReadiness } from "../orchestration/task-runtime-state.ts";
import { emergencyStopPath, isEmergencyStopEngaged } from "../provider-admission/emergency-stop.ts";
import type { SessionFleetScheduler } from "./fleet-scheduler.ts";

export type WorkerDispatchWait = Extract<WorkerDispatchAdmission, { action: "wait" }>;

export const FOREGROUND_HOLD_WAIT: WorkerDispatchWait = {
	action: "wait",
	reason: "foreground",
	detail: "starts when the foreground turn ends; both use the same local model",
};

export function readinessWait(reasonCode: string): WorkerDispatchWait {
	return {
		action: "wait",
		reason: reasonCode === "objective_paused" ? "objective" : "dependencies",
		detail: reasonCode,
	};
}

export function reservationWait(
	detail: Parameters<typeof formatWorkerWriteReservationBlock>[0] | undefined,
): WorkerDispatchWait {
	return {
		action: "wait",
		reason: "write_reservation",
		...(detail ? { detail: formatWorkerWriteReservationBlock(detail) } : {}),
	};
}

/** What the bridge reads from, and asks of, the worker controller. `A` is the controller's resolved admission. */
export interface WorkerDispatchAdmissionPort<A> {
	getAgentDir(): string;
	deferRetryIfNeeded(record: LaneRecord, request: WorkerDelegationRequest): boolean;
	getActiveAttempt(laneId: string): AttemptRuntimeState | undefined;
	getAttemptDispatchReadiness(attemptId: string): AttemptDispatchReadiness;
	resolveAdmission(
		request: WorkerDelegationRequest,
		attempt: AttemptRuntimeState,
	): A | { ok: false; skipReason: string };
	modelOf(admission: A): Model<Api>;
	/** True while the attempt must wait for the foreground turn; false clears it for this attempt. */
	holdsForForeground(attempt: AttemptRuntimeState, admission: A): boolean;
	acquireWriteReservation(laneId: string, attempt: AttemptRuntimeState, admission: A): WorkerWriteReservationAdmission;
}

export function decideWorkerDispatch<A extends { ok: true }>(
	port: WorkerDispatchAdmissionPort<A>,
	fleet: SessionFleetScheduler,
	request: WorkerDelegationRequest,
	record: LaneRecord,
): WorkerDispatchAdmission {
	if (port.deferRetryIfNeeded(record, request)) return { action: "wait" };
	const attempt = port.getActiveAttempt(record.laneId);
	if (!attempt) return { action: "cancel", reasonCode: "orchestration_attempt_missing" };
	const pending = attempt.status === "queued" || attempt.status === "suspended";
	if (pending) {
		const readiness = port.getAttemptDispatchReadiness(attempt.attemptId);
		if (readiness.state === "waiting") return readinessWait(readiness.reasonCode);
		if (readiness.state === "blocked") return { action: "cancel", reasonCode: readiness.reasonCode };
	}
	const admission = port.resolveAdmission(request, attempt);
	if (!admission.ok) return { action: "cancel", reasonCode: (admission as { skipReason: string }).skipReason };
	const admitted = admission as A;
	if (isEmergencyStopEngaged(port.getAgentDir())) {
		return {
			action: "wait",
			reason: "capacity",
			detail: `paused by the machine-wide emergency stop (${emergencyStopPath(port.getAgentDir())})`,
		};
	}
	if (pending && port.holdsForForeground(attempt, admitted)) return FOREGROUND_HOLD_WAIT;
	const room = fleet.localRoom({
		laneId: record.laneId,
		model: port.modelOf(admitted),
		writes: (attempt.dispatch.executionContract?.worker.authority.writePaths.length ?? 0) > 0,
	});
	if (!room.ok) return { action: "wait", reason: "capacity", detail: room.term.detail };
	const reservation = port.acquireWriteReservation(record.laneId, attempt, admitted);
	if (reservation.kind === "denied") return { action: "cancel", reasonCode: reservation.reasonCode };
	if (reservation.kind === "granted") return { action: "start" };
	return reservationWait(reservation.detail);
}
