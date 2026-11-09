/**
 * How a placed job's end becomes its managed lane's terminal report on the placer: one closed mapping from the job's
 * stored facts (the executor's outcome, a refusal, or an end the placer observed itself) to a lane status, a source
 * code the outcome taxonomy classifies, and a summary. The executor's summary is the peer's words: it travels as the
 * lane's untrusted terminal evidence and is fenced there, never as host text. Refusals and placer-side ends are told in
 * fixed host phrases, so nothing a peer wrote decides how the lane ends.
 */

import type { OutcomeStatus } from "../delegation/worker-outcome-contract.ts";
import type { JobRefusal } from "./job-protocol.ts";
import type { PlacerEnding, PlacerJobRecord } from "./job-store.ts";

export const REFUSAL_WORDS: Readonly<Record<JobRefusal, string>> = {
	no_room: "it has no room for another job now",
	jobs_disabled: "it does not take jobs from this machine",
	writes_disabled: "it does not take jobs that change files",
	unknown_repo: "it does not have this project checked out",
	base_missing: "its checkout does not have the commit the job starts from",
	needs_setup: "its checkout of this project needs setup first",
	no_model: "no model is available there",
	peer_budget_out: "its budget for placed jobs is spent",
	would_loop: "the job would come back to a machine already on its path",
	too_deep: "the job has passed through too many machines",
	envelope_exceeds_ceiling: "the job asks for more than that machine lets this one do",
	bad_offer: "it could not read the job",
	duplicate_conflict: "it already holds another job under the same id",
	leader_unsupported: "it does not lead work for other machines",
};

const ENDINGS: Readonly<Record<PlacerEnding, { status: string; words: (machine: string) => string }>> = {
	machine_offline: { status: "blocked", words: (machine) => `${machine} stayed offline past the offline hold.` },
	machine_revoked: { status: "cancelled", words: (machine) => `${machine} was revoked; its jobs were stopped.` },
	remote_lost: { status: "blocked", words: (machine) => `${machine} no longer had the job after the link came back.` },
	remote_deadline: { status: "timeout", words: (machine) => `The job on ${machine} reached its deadline.` },
	owner_cancelled: { status: "cancelled", words: (machine) => `The owner stopped the job on ${machine}.` },
};

const OUTCOME_LANE_STATUS: Readonly<Record<OutcomeStatus, string>> = {
	succeeded: "completed",
	partial: "partial",
	blocked: "blocked",
	failed: "failed",
	cancelled: "cancelled",
};

export interface PlacedJobTerminal {
	readonly status: string;
	readonly reasonCode?: string;
	readonly summary: string;
}

/** The managed lane's terminal report for a placed job's end; undefined while the job has not ended. */
export function placedJobTerminal(record: PlacerJobRecord): PlacedJobTerminal | undefined {
	if (record.ending) {
		const ending = ENDINGS[record.ending];
		return { status: ending.status, reasonCode: record.ending, summary: ending.words(record.executorName) };
	}
	if (record.state === "refused") {
		const words = record.refusal ? REFUSAL_WORDS[record.refusal] : "it refused the job";
		return {
			status: "blocked",
			reasonCode: record.refusal ? `machine_refused:${record.refusal}` : "machine_refused",
			summary: `${record.executorName} did not take the job: ${words}.`,
		};
	}
	if (record.state === "terminal" && record.outcome) {
		const { status, blockerCode, summary } = record.outcome;
		return {
			status: OUTCOME_LANE_STATUS[status],
			...(blockerCode && blockerCode !== "none" ? { reasonCode: `remote_reported:${blockerCode}` } : {}),
			summary,
		};
	}
	return undefined;
}
