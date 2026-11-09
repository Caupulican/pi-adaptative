/**
 * The placer's lane ends for placed jobs whose record the job client cannot apply itself. A lane whose placed record is definitively
 * absent was written by a predecessor that never recorded the placement, so it was never offered to its machine: it ends as
 * `placement_abandoned` (`endAbandonedPlacements`); that turn is then spent, and the step's next placement is the next turn of the job
 * (`placementTurn` in `job-client.ts`), never the same job id. A lane whose record exists but cannot be read by this build ends from the record's
 * cancel marker when one stands beside it (`endMarkedPlacement`), and is left open otherwise, since its job may be live. The job
 * client's start, its reconcile and the managed-lane controller's first hydration run these over the session's own lane book.
 *
 * A placed job's plan is never read from its record here or in `RemoteJobClient.cancelPlan`: the record is the one thing that may be
 * unreadable. It is read from the lane's dispatch, which carries the placement key (`ManagedLaneBinding.placement`). A lane an earlier
 * build wrote carries no key, so the plan of its job cannot be known and a plan's stop does not reach it.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { ManagedLaneBinding } from "../delegation/worker-lifecycle.ts";
import type { ManagedLaneEvent } from "../extensions/managed-lane-records.ts";
import type { JobCancelReason } from "./job-protocol.ts";
import { endingOfCancel, type JobStore, placedRecordName } from "./job-store.ts";

/** The prefix of a placed job's lane id: `remote-<jobId>`. */
export const REMOTE_LANE_PREFIX = "remote-";
/** The prefix of a placed job's authorization: `remote-job:<machineId>`, naming the machine that runs the job. */
export const REMOTE_JOB_AUTHORIZATION_PREFIX = "remote-job:";
/** The end a lane takes when its placement was never recorded: the job was never offered to its machine. */
export const PLACEMENT_ABANDONED = "placement_abandoned";
/** The summary of a lane ended from a cancel marker: this build holds no words of the job, since its record cannot be read. */
const MARKED_SUMMARY =
	"The placed job was stopped. This build cannot read its record, so the stop was recorded without it.";

/** The lane id of the placed job `jobId`: the one derivation every reader of a placed job's lane uses. */
export const remoteJobLaneId = (jobId: string): string => `${REMOTE_LANE_PREFIX}${jobId}`;
/** The authorization a placed job's managed lane is dispatched under: the machine that runs it (a lane is bound to one). */
export const remoteJobAuthorization = (machineId: string): string => `${REMOTE_JOB_AUTHORIZATION_PREFIX}${machineId}`;

export interface RemotePlacementSession {
	recordManagedLane(event: ManagedLaneEvent): LaneRecord | undefined;
	/**
	 * The durable attempts of the managed lanes, by lane id: a replayed dispatch of a durable lane reads its attempt back here, and
	 * a restart finds the placer-side lanes a predecessor left open.
	 */
	managedLaneBindings(): ReadonlyMap<string, ManagedLaneBinding>;
}

/**
 * The placed job a lane names: its machine (the lane's authorization names it) and its job id (the lane id holds it). Undefined for a
 * lane that is not a placed job's.
 */
export function placedJobOfLane(
	laneId: string,
	binding: Pick<ManagedLaneBinding, "authorizationId">,
): { readonly machineId: string; readonly jobId: string } | undefined {
	const authorization = binding.authorizationId;
	if (!laneId.startsWith(REMOTE_LANE_PREFIX)) return undefined;
	if (authorization === undefined || !authorization.startsWith(REMOTE_JOB_AUTHORIZATION_PREFIX)) return undefined;
	return {
		machineId: authorization.slice(REMOTE_JOB_AUTHORIZATION_PREFIX.length),
		jobId: laneId.slice(REMOTE_LANE_PREFIX.length),
	};
}

/**
 * The lane this session holds for the placed job `jobId` on `machineId`, when it is bound to that machine. Undefined when the lane book
 * holds none or holds one bound elsewhere. The lane book is this session's, so its binding stands for the job's owner.
 */
export function placedJobLaneBinding(
	session: RemotePlacementSession,
	machineId: string,
	jobId: string,
): ManagedLaneBinding | undefined {
	const binding = session.managedLaneBindings().get(remoteJobLaneId(jobId));
	return binding?.authorizationId === remoteJobAuthorization(machineId) ? binding : undefined;
}

/**
 * Ends every placer-side lane whose placed record is definitively absent and still open, and every open lane whose unreadable record
 * carries a cancel marker; returns how many this call ended. A lane whose record cannot be read and has no marker is left open and
 * reported once per sweep: its job may be live.
 */
export function endAbandonedPlacements(
	session: RemotePlacementSession,
	store: Pick<JobStore, "placedState" | "placedCancelMarks">,
): number {
	const marks = new Map<string, JobCancelReason>();
	for (const mark of store.placedCancelMarks()) marks.set(placedRecordName(mark.machineId, mark.jobId), mark.reason);
	let ended = 0;
	for (const [laneId, binding] of session.managedLaneBindings()) {
		if (binding.ended) continue;
		const placed = placedJobOfLane(laneId, binding);
		if (placed === undefined) continue;
		const { machineId, jobId } = placed;
		const record = store.placedState(machineId, jobId);
		if (record.kind === "valid") continue;
		if (record.kind === "unreadable") {
			const reason = marks.get(placedRecordName(machineId, jobId));
			if (reason === undefined) {
				harnessLog.warn("placement", "a placed job's record could not be read, so its lane was left open", {
					laneId,
					// `unrecorded`: the lane predates the placement key, or its job named no plan.
					plan: binding.placement?.plan?.planId ?? "unrecorded",
				});
			} else if (endMarkedPlacement(session, machineId, jobId, reason)) ended += 1;
			continue;
		}
		if (endAbandonedPlacement(session, laneId, binding.dispatchSequence)) ended += 1;
	}
	return ended;
}

/**
 * Ends one abandoned placement lane. A failure is logged and the lane stays as it was (the next start tries again). True when
 * this call ended the lane: the lane's record came back, not the undefined of a lane that had already ended.
 */
export function endAbandonedPlacement(
	session: RemotePlacementSession,
	laneId: string,
	dispatchSequence: number,
): boolean {
	try {
		return (
			session.recordManagedLane({
				laneId,
				phase: "terminal",
				dispatchSequence,
				status: "canceled",
				reasonCode: PLACEMENT_ABANDONED,
				summary: "The placement was not recorded, so the job was never offered to its machine.",
			}) !== undefined
		);
	} catch (error) {
		harnessLog.warn("placement", "an abandoned placement lane could not be ended", {
			laneId,
			reason: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
}

/**
 * Ends a placed job's lane from its cancel marker, for a record this build cannot read. The lane is found in this session's lane book by
 * the job id and must be bound to `machineId`; a lane another session holds, or one already ended, is left as it is. The end is the one a
 * readable record's ending would take: the status and the reason code `placedJobTerminal` gives that ending. True when this call ended it.
 */
export function endMarkedPlacement(
	session: RemotePlacementSession,
	machineId: string,
	jobId: string,
	reason: JobCancelReason,
): boolean {
	const laneId = remoteJobLaneId(jobId);
	const binding = placedJobLaneBinding(session, machineId, jobId);
	if (!binding || binding.ended) return false;
	const ending = endingOfCancel(reason);
	try {
		return (
			session.recordManagedLane({
				laneId,
				phase: "terminal",
				dispatchSequence: binding.dispatchSequence,
				status: ending === "remote_deadline" ? "timeout" : "canceled",
				// A plan's stop names the plan's own reason, as a readable record's ending does.
				reasonCode: ending === "plan_stopped" ? reason : ending,
				summary: MARKED_SUMMARY,
			}) !== undefined
		);
	} catch (error) {
		harnessLog.warn("placement", "a placed job's stop could not be recorded on its lane", {
			laneId,
			reason: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
}
