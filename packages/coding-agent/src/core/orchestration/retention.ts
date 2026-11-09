/**
 * Closed orchestration objectives: which facts keep each one in the live store, and the plain words the capacity refusal
 * gives when the store is full. An objective is closed when its status is completed or cancelled. Session work
 * (`session:<id>`) never closes. An agent's latest turn is what that agent's next turn is built from, so its objective
 * is held; so are a pending notice, a pending approval, an open plan and an unfinished task.
 *
 * Nothing here removes a record. Releasing a closed objective is archive-then-prune, which is not built: until it is,
 * every objective and attempt stays, and the refusal says so.
 */

import { latestAgentAttemptByDurableOrder } from "./attempt-ordering.ts";
import type { TaskRuntimeProjection } from "./task-runtime-state.ts";

const SESSION_OBJECTIVE_PREFIX = "session:";
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** Why a closed objective stays. The order is the order the facts are checked in. */
const HOLD_ORDER = ["latest_turn", "pending_notice", "pending_approval", "open_plan", "unfinished_task"] as const;
export type ObjectiveHold = (typeof HOLD_ORDER)[number];

export type ObjectiveRetention =
	| { readonly kind: "open" }
	| { readonly kind: "session" }
	| { readonly kind: "held"; readonly hold: ObjectiveHold }
	| { readonly kind: "free" };

/** Every objective of the projection, classified by the facts that hold it. */
export function classifyObjectives(state: TaskRuntimeProjection): Map<string, ObjectiveRetention> {
	const sets: Record<ObjectiveHold, Set<string>> = {
		latest_turn: new Set(),
		pending_notice: new Set(),
		pending_approval: new Set(),
		open_plan: new Set(),
		unfinished_task: new Set(),
	};
	for (const agentId of Object.keys(state.agents)) {
		const latest = latestAgentAttemptByDurableOrder(state, agentId);
		const objectiveId = latest ? state.tasks[latest.taskId]?.task.objectiveId : undefined;
		if (objectiveId !== undefined) sets.latest_turn.add(objectiveId);
	}
	for (const notification of Object.values(state.notifications)) {
		if (notification.status === "pending") sets.pending_notice.add(notification.objectiveId);
	}
	for (const approval of Object.values(state.approvals)) {
		if (approval.status === "pending") sets.pending_approval.add(approval.request.objectiveId);
	}
	for (const plan of Object.values(state.plans)) {
		if (plan.closed === undefined && "objectiveId" in plan.record) sets.open_plan.add(plan.record.objectiveId);
	}
	for (const runtime of Object.values(state.tasks)) {
		if (!TERMINAL_TASK_STATUSES.has(runtime.task.status)) sets.unfinished_task.add(runtime.task.objectiveId);
	}
	const result = new Map<string, ObjectiveRetention>();
	for (const [objectiveId, runtime] of Object.entries(state.objectives)) {
		const status = runtime.objective.status;
		if (status === "active" || status === "paused") result.set(objectiveId, { kind: "open" });
		else if (objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)) result.set(objectiveId, { kind: "session" });
		else {
			const hold = HOLD_ORDER.find((candidate) => sets[candidate].has(objectiveId));
			result.set(objectiveId, hold ? { kind: "held", hold } : { kind: "free" });
		}
	}
	return result;
}

/**
 * The objective limit's refusal, in plain words: how many objectives the store keeps, what each group is, and why a
 * closed one is not released. Pure over the projection; only read on the refusal path.
 */
export function describeObjectiveLimit(state: TaskRuntimeProjection): string {
	const classes = classifyObjectives(state);
	const count = (predicate: (retention: ObjectiveRetention) => boolean) =>
		[...classes.values()].filter(predicate).length;
	const held = (hold: ObjectiveHold) => count((retention) => retention.kind === "held" && retention.hold === hold);
	return [
		`${classes.size} objectives are kept in this session's store:`,
		`${count((retention) => retention.kind === "open")} open,`,
		`${count((retention) => retention.kind === "session")} session work (which never closes),`,
		`${count((retention) => retention.kind === "held")} closed and held`,
		`(${held("latest_turn")} as an agent's latest turn, ${held("pending_notice")} with a notice not yet delivered,`,
		`${held("pending_approval")} with an approval pending, ${held("open_plan")} under an open plan,`,
		`${held("unfinished_task")} with an unfinished task),`,
		`and ${count((retention) => retention.kind === "free")} closed with no hold.`,
		"A closed objective leaves the store only by pruning, which is not built yet, so none is released.",
	].join(" ");
}

/** The attempt limit's refusal, in plain words: which objectives the kept attempts belong to. */
export function describeAttemptLimit(state: TaskRuntimeProjection): string {
	const classes = classifyObjectives(state);
	let session = 0;
	let closed = 0;
	let open = 0;
	for (const attempt of Object.values(state.attempts)) {
		const objectiveId = state.tasks[attempt.taskId]?.task.objectiveId;
		const retention = objectiveId === undefined ? undefined : classes.get(objectiveId);
		if (retention?.kind === "session") session += 1;
		else if (retention?.kind === "held" || retention?.kind === "free") closed += 1;
		else open += 1;
	}
	return [
		`${Object.keys(state.attempts).length} attempts are kept in this session's store:`,
		`${session} belong to session work (which never closes),`,
		`${closed} to closed objectives,`,
		`and ${open} to open ones.`,
		"An attempt leaves the store only with its objective, and pruning is not built yet.",
	].join(" ");
}
