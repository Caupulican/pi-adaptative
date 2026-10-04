/**
 * Fan-out groups: several workers started by one `delegate start` call.
 *
 * - `partition`: a task split into slices declared up front, one worker per slice. Coverage is every
 *   declared slice having an accepted result; a slice without one is reported as a coverage gap.
 * - `race`: several candidates attempt the same task. The first accepted result wins and the host
 *   cancels the rest through the ordinary cancel path.
 *
 * Nothing here is a second mechanism. A group is read from the orchestration ledger (each member's
 * dispatch carries its membership header, see worker-fanout-header.ts) and each member's state is the
 * lane projection the rest of the harness already uses. Coverage and race outcomes are attribution
 * and findings: they never block other work or hold a lane.
 */

import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import {
	type FanoutKind,
	type FanoutMembership,
	formatFanoutHeader,
	isFanoutMemberId,
	MAX_FANOUT_PARTITION_SLICES,
	MAX_FANOUT_RACE_CANDIDATES,
	parseFanoutHeader,
} from "./worker-fanout-header.ts";
import { projectWorkerLaneRecord } from "./worker-lane-projection.ts";

/** A refused fan-out declaration; `skipReason` is the machine-readable reason the tool reports. */
export class WorkerFanoutError extends Error {
	readonly skipReason: string;
	constructor(skipReason: string, message: string) {
		super(message);
		this.name = "WorkerFanoutError";
		this.skipReason = skipReason;
	}
}

export interface FanoutDeclaration {
	slices?: readonly { id: string; instructions: string }[];
	race?: number;
}

export interface FanoutPlanMember {
	memberId: string;
	/** The member's complete dispatch instructions, header first. */
	instructions: string;
}

export interface FanoutPlan {
	groupId: string;
	kind: FanoutKind;
	declared: readonly string[];
	members: readonly FanoutPlanMember[];
}

/**
 * Validate one declaration and build every member's dispatch before any member starts, so a refused
 * declaration starts nothing. `groupId` is chosen by the caller from the tool call, so a replayed call
 * rebuilds the same group.
 */
export function planFanout(input: {
	groupId: string;
	instructions: string;
	declaration: FanoutDeclaration;
}): FanoutPlan {
	const { groupId, instructions, declaration } = input;
	const { slices, race } = declaration;
	if (slices !== undefined && race !== undefined) {
		throw new WorkerFanoutError(
			"fanout_declaration_conflict",
			"delegate start takes slices (a partition) or race (competing candidates), not both",
		);
	}
	const kind: FanoutKind = slices !== undefined ? "partition" : "race";
	let memberInputs: { memberId: string; brief?: string }[];
	if (slices !== undefined) {
		if (slices.length < 2 || slices.length > MAX_FANOUT_PARTITION_SLICES) {
			throw new WorkerFanoutError(
				"fanout_slice_count_invalid",
				`delegate slices must declare from 2 through ${MAX_FANOUT_PARTITION_SLICES} slices; a single task is an ordinary start`,
			);
		}
		memberInputs = slices.map((slice) => ({ memberId: slice.id.trim(), brief: slice.instructions.trim() }));
		for (const member of memberInputs) {
			if (!isFanoutMemberId(member.memberId)) {
				throw new WorkerFanoutError(
					"fanout_slice_id_invalid",
					`delegate slice id '${member.memberId}' must be 1-24 letters, digits, '.', '_' or '-'`,
				);
			}
			if (!member.brief) {
				throw new WorkerFanoutError(
					"fanout_slice_instructions_missing",
					`delegate slice '${member.memberId}' needs instructions`,
				);
			}
		}
	} else {
		if (race === undefined || !Number.isSafeInteger(race) || race < 2 || race > MAX_FANOUT_RACE_CANDIDATES) {
			throw new WorkerFanoutError(
				"fanout_race_count_invalid",
				`delegate race must be a count from 2 through ${MAX_FANOUT_RACE_CANDIDATES}`,
			);
		}
		memberInputs = Array.from({ length: race }, (_, index) => ({ memberId: `c${index + 1}` }));
	}
	const declared = memberInputs.map((member) => member.memberId);
	if (new Set(declared).size !== declared.length) {
		throw new WorkerFanoutError("fanout_slice_id_duplicate", "delegate slice ids must be unique");
	}
	const members = memberInputs.map((member): FanoutPlanMember => {
		const membership: FanoutMembership = { groupId, kind, memberId: member.memberId, declared };
		const others = declared.filter((id) => id !== member.memberId).join(", ");
		const body =
			kind === "partition"
				? `${instructions}\n\nYour slice (${member.memberId}): ${member.brief}\n\nYou are one of ${declared.length} workers on this task. The other slices (${others}) belong to separate workers: cover only your slice and report on it.`
				: `${instructions}\n\nYou are candidate ${member.memberId} of ${declared.length} attempting this same task independently (others: ${others}). The first accepted result wins and the host cancels the rest: work on your own and do not coordinate.`;
		const full = `${formatFanoutHeader(membership)}${body}`;
		if (full.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) {
			throw new WorkerFanoutError(
				"fanout_instructions_too_long",
				`delegate fan-out member '${member.memberId}' would exceed ${MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH} characters of instructions; shorten the shared instructions or the slice`,
			);
		}
		return { memberId: member.memberId, instructions: full };
	});
	return { groupId, kind, declared, members };
}

export type FanoutMemberState = "accepted" | "reported" | "failed" | "canceled" | "pending" | "not_started";

export interface FanoutMemberReport {
	memberId: string;
	state: FanoutMemberState;
	laneId?: string;
	agentId?: string;
	reasonCode?: string;
	completedAt?: string;
}

export interface FanoutGroupReport {
	groupId: string;
	kind: FanoutKind;
	/** Declared member ids in declaration order. */
	declared: readonly string[];
	members: readonly FanoutMemberReport[];
	/** Race only: the first candidate whose result was accepted. */
	winner?: FanoutMemberReport;
	/** Race only: losers the host tried to cancel and could not (host-annotated; absent when none failed). */
	cancelFailures?: readonly { memberId: string; laneId: string; attempts: number; reason: string }[];
	/** No member is still running or queued. */
	settled: boolean;
	/** Partition: every declared slice has an accepted result. Race: some candidate was accepted. */
	covered: boolean;
}

/** A member state that carries its result forward when a task has several attempts: best state wins. */
const STATE_RANK: Record<FanoutMemberState, number> = {
	accepted: 5,
	reported: 4,
	pending: 3,
	failed: 2,
	canceled: 1,
	not_started: 0,
};

function memberStateOfLane(status: string): FanoutMemberState {
	switch (status) {
		case "succeeded":
			return "accepted";
		case "partial":
		case "blocked":
			return "reported";
		case "queued":
		case "running":
			return "pending";
		case "canceled":
			return "canceled";
		default:
			return "failed";
	}
}

/**
 * Every fan-out group in the ledger. Membership is read from each task's FIRST attempt, so a later
 * follow_up on the same worker (which carries no header) stays in its group. Declared members with no
 * task are reported `not_started`: a slice the host never admitted is still a slice that has no result.
 */
export function deriveFanoutGroups(snapshot: TaskRuntimeProjection): FanoutGroupReport[] {
	const groups = new Map<
		string,
		{ membership: FanoutMembership; found: Map<string, FanoutMemberReport>; order: number }
	>();
	let order = 0;
	for (const taskId of Object.keys(snapshot.tasks)) {
		const task = snapshot.tasks[taskId];
		const firstAttempt = task ? snapshot.attempts[task.attemptIds[0] ?? ""] : undefined;
		const parsed = firstAttempt ? parseFanoutHeader(firstAttempt.dispatch.instructions) : undefined;
		if (!parsed) continue;
		const { membership } = parsed;
		const record = projectWorkerLaneRecord(snapshot, taskId);
		if (!record) continue;
		let group = groups.get(membership.groupId);
		if (!group) {
			group = { membership, found: new Map(), order: order++ };
			groups.set(membership.groupId, group);
		}
		const member: FanoutMemberReport = {
			memberId: membership.memberId,
			state: memberStateOfLane(record.status),
			laneId: record.laneId,
			...(record.agentId ? { agentId: record.agentId } : {}),
			...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
			...(record.completedAt ? { completedAt: record.completedAt } : {}),
		};
		const existing = group.found.get(membership.memberId);
		if (!existing || STATE_RANK[member.state] > STATE_RANK[existing.state]) {
			group.found.set(membership.memberId, member);
		}
	}
	return [...groups.values()]
		.sort((left, right) => left.order - right.order)
		.map(({ membership, found }): FanoutGroupReport => {
			const members = membership.declared.map(
				(memberId): FanoutMemberReport => found.get(memberId) ?? { memberId, state: "not_started" },
			);
			const accepted = members.filter((member) => member.state === "accepted");
			const winner = [...accepted].sort((left, right) =>
				(left.completedAt ?? "").localeCompare(right.completedAt ?? ""),
			)[0];
			return {
				groupId: membership.groupId,
				kind: membership.kind,
				declared: membership.declared,
				members,
				...(membership.kind === "race" && winner ? { winner } : {}),
				settled: members.every((member) => member.state !== "pending"),
				covered: membership.kind === "partition" ? accepted.length === members.length : accepted.length > 0,
			};
		});
}

/** The group that `laneId` belongs to, if any. */
export function fanoutGroupOfLane(groups: readonly FanoutGroupReport[], laneId: string): FanoutGroupReport | undefined {
	return groups.find((group) => group.members.some((member) => member.laneId === laneId));
}

/** Race members still queued or running once a winner exists: the ones the host cancels. */
export function raceLosersToCancel(group: FanoutGroupReport): FanoutMemberReport[] {
	if (group.kind !== "race" || !group.winner) return [];
	return group.members.filter((member) => member.state === "pending" && member.agentId !== undefined);
}

export function raceLostReasonCode(winnerLaneId: string): string {
	return `fanout_race_lost:${winnerLaneId}`;
}

function describeMember(member: FanoutMemberReport): string {
	const reason = member.reasonCode ? ` (${member.reasonCode.replace(/[^\w.:,-]/g, "_").slice(0, 80)})` : "";
	const lane = member.laneId ? ` lane ${member.laneId}` : "";
	return `${member.memberId} ${member.state.replace("_", " ")}${reason}${lane}`;
}

/** One bounded line: group, outcome, and every member that is not an accepted result. */
export function formatFanoutGroupLine(group: FanoutGroupReport): string {
	const accepted = group.members.filter((member) => member.state === "accepted").length;
	const open = group.members.filter((member) => member.state !== "accepted");
	const head =
		group.kind === "partition"
			? `fan-out ${group.groupId} partition: ${accepted}/${group.members.length} slices accepted`
			: group.winner
				? `fan-out ${group.groupId} race: ${group.winner.memberId} won (lane ${group.winner.laneId})`
				: `fan-out ${group.groupId} race: no candidate accepted yet`;
	const tail = open.length > 0 ? `; ${open.map(describeMember).join("; ")}` : "";
	const stuck = (group.cancelFailures ?? []).map(
		(failure) =>
			` CANCEL FAILED: candidate ${failure.memberId} (lane ${failure.laneId}) is still running after the win; the host ${failure.attempts >= 2 ? "retried and could not stop it" : "retries once on the next event"} (${failure.reason.replace(/[\r\n]+/g, " ").slice(0, 120)}).`,
	);
	const gap =
		group.settled && !group.covered
			? group.kind === "partition"
				? ` COVERAGE GAP: no accepted result for ${open.map((member) => member.memberId).join(", ")}.`
				: " COVERAGE GAP: no candidate produced an accepted result."
			: "";
	return `${head}${tail}${group.settled ? "" : " (still running)"}${gap}${stuck.join("")}`;
}

/** The group line for one terminal lane's handoff, or undefined when the lane is not a group member. */
export function fanoutNoteForLane(groups: readonly FanoutGroupReport[], laneId: string): string | undefined {
	const group = fanoutGroupOfLane(groups, laneId);
	return group ? formatFanoutGroupLine(group) : undefined;
}
