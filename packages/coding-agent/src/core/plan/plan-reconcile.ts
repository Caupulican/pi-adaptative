/**
 * The plan executor's reconcile: pure code from the orchestration projection (and the synchronized goal) to the
 * actions that move every open plan forward, the plan-updates the root is owed and the routed terminals it may
 * acknowledge. Nothing here performs I/O; `plan-executor.ts` applies the result and runs reconcile again after every
 * store commit, room change, goal change and tool call. Rules, per open plan:
 *
 * 1. objective cancelled or completed, or the plan's goal replaced -> close the plan as cancelled;
 * 2. a task released for a spec the plan no longer runs (retired), or any released task of a closed plan, still
 *    running -> cancel it;
 * 3. a released node whose task recorded an outcome newer than its hold -> the reconciled nextAction table:
 *    accept settles; verify_in_lane, host_check, rerun_uncovered, retry_after and wait_capacity wait (the worker
 *    ladder acts); verify_independently settles a step a verify step already checks and wraps any other in a verify
 *    step (host revision); replace restates a remotely released step
 *    on this machine (host revision), or holds it for the owner when its must-pin names that machine;
 *    fix_request and abandon(dependency) hold for a revise (a vote's own check that rejects settles instead: its verdict
 *    answers the vote); ask_owner holds on the owner; ask_root holds on
 *    the root; abandon(cancelled/superseded/stopped) settles without acceptance. A reduce or verify worker's outcome settles
 *    its join instead;
 * 4. a code join (collect, race, vote) whose ordering edges settled and a member settled -> decide it;
 * 5. an unreleased node that is releasable (work: every predecessor accepted; join: every predecessor settled), while
 *    the objective is not paused and no step waits on the owner for an exhausted budget -> release it, verifiers
 *    first, then the critical path, then plan order;
 * 6. the final node settled -> close the plan as settled;
 * 7. a closed plan's workers -> retire each one that has no turn still open. The plan started a worker of its own for
 *    every step, so none has work left once the plan is closed, and the retirement is what frees a worktree lane the
 *    plan landed.
 *
 * Updates (one bounded plan-update each, idempotent by delivery id): every settled join other than the final, every
 * hold, the final result of a plan closed as settled, a plan that can no longer move (no step running, ready, held or
 * decidable and the final unsettled; a step whose task ended with no outcome recorded counts as unable to move), and
 * goal requirements no step cites and the root does not own.
 */

import { createHash } from "node:crypto";
import { isOutcomeFromNewerBuild, type Outcome, type StoredOutcome } from "../delegation/worker-outcome-contract.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import {
	isCodeSettledJoin,
	isPlanFromNewerBuild,
	PLAN_LIMITS,
	type PlanCloseStatus,
	type PlanHoldReason,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planCriticalPath,
	planNodeEdges,
} from "./plan-graph.ts";
import { planNodeOfTask, planTaskChain } from "./plan-reducer.ts";
import { voteChecksOf } from "./plan-revision.ts";
import type { PlanUpdateInput } from "./plan-update.ts";
import { planNodeReleasable } from "./plan-view.ts";

export type ReconcileProjection = Pick<
	TaskRuntimeProjection,
	"plans" | "tasks" | "attempts" | "objectives" | "notifications" | "agents"
>;

interface NodeRef {
	readonly planId: string;
	readonly nodeId: string;
}

export type PlanAction =
	| (NodeRef & { readonly kind: "release"; readonly priority: number; readonly order: number })
	| (NodeRef & {
			readonly kind: "settle";
			readonly outcomeId: string;
			readonly generation: number;
			readonly outcome: Outcome;
	  })
	| (NodeRef & {
			readonly kind: "hold";
			readonly reason: PlanHoldReason;
			readonly detail: string;
			readonly generation: number;
	  })
	| (NodeRef & { readonly kind: "code_join" })
	| (NodeRef & { readonly kind: "worker_join"; readonly outcome: Outcome })
	| (NodeRef & {
			readonly kind: "verify_wrap";
			readonly requirementIds: readonly string[];
			readonly outcome: Outcome;
			readonly settled: boolean;
	  })
	| (NodeRef & {
			readonly kind: "replace";
			readonly excludePlacement: string;
			readonly outcome: Outcome;
	  })
	| { readonly kind: "close"; readonly planId: string; readonly status: PlanCloseStatus; readonly reason: string }
	| { readonly kind: "cancel_task"; readonly planId: string; readonly taskId: string; readonly reason: string }
	| { readonly kind: "retire_worker"; readonly planId: string; readonly agentId: string };

/** A plan-update the root is owed; `artifact` is the join result file the update summarizes, when there is one. */
export interface PlanUpdateIntent {
	readonly planId: string;
	readonly input: PlanUpdateInput;
	readonly artifact?: string;
}

export interface PlanReconcileResult {
	readonly actions: readonly PlanAction[];
	readonly updates: readonly PlanUpdateIntent[];
	/** Routed terminal notifications whose outcome the plan already consumed. */
	readonly acknowledge: readonly string[];
}

const LANE_ACTIONS: ReadonlySet<string> = new Set([
	"verify_in_lane",
	"host_check",
	"rerun_uncovered",
	"retry_after",
	"wait_capacity",
]);
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"partial",
	"blocked",
	"failed",
	"cancelled",
	"expired",
]);

/** A stable number for a set of ids: the same unowned requirements are one update, a changed set a new one. */
function idSetSequence(ids: readonly string[]): number {
	return Number.parseInt(
		createHash("sha256")
			.update([...ids].sort().join("\n"))
			.digest("hex")
			.slice(0, 8),
		16,
	);
}

function clipDetail(text: string): string {
	const line = text.replace(/\s+/g, " ").trim() || "no detail recorded";
	return line.length <= PLAN_LIMITS.detailChars ? line : `${line.slice(0, PLAN_LIMITS.detailChars - 3)}...`;
}

function currentOutcome(projection: ReconcileProjection, taskId: string): Outcome | undefined {
	const outcome: StoredOutcome | undefined = projection.tasks[taskId]?.outcome;
	return outcome && !isOutcomeFromNewerBuild(outcome) ? outcome : undefined;
}

function isWorkerJoin(node: PlanNodeSpec): boolean {
	return node.kind === "reduce" || node.kind === "verify";
}

/** What the plan's own record says about a node, beyond its outcome: read once per plan by `nodeActions`. */
interface NodeStanding {
	/** A verify step of the plan already checks this node. */
	readonly checked: boolean;
	/** The node is a check the host added for a vote: its verdict answers the vote. */
	readonly answersVote: boolean;
}

/** Rule 3: the action a released node's newest outcome asks of the plan, or undefined to wait. */
function outcomeAction(
	ref: NodeRef,
	node: PlanNodeSpec,
	outcome: Outcome,
	standing: NodeStanding,
): PlanAction | undefined {
	const hold = (reason: PlanHoldReason, detail: string): PlanAction => ({
		...ref,
		kind: "hold",
		reason,
		detail: clipDetail(detail),
		generation: outcome.generation,
	});
	const settle: PlanAction = isWorkerJoin(node)
		? { ...ref, kind: "worker_join", outcome }
		: { ...ref, kind: "settle", outcomeId: outcome.outcomeId, generation: outcome.generation, outcome };
	const next = outcome.nextAction;
	if (LANE_ACTIONS.has(next.kind)) return undefined;
	switch (next.kind) {
		case "accept":
			return settle;
		case "verify_independently":
			// A step a verify step already checks settles as it is and that review decides; any other step gets its check added.
			return isWorkerJoin(node) || standing.checked
				? settle
				: { ...ref, kind: "verify_wrap", requirementIds: next.requirementIds, outcome, settled: false };
		case "replace":
			return node.pin?.mode === "must" && typeof node.pin.target === "object" && "machineId" in node.pin.target
				? hold(
						"owner",
						`step ${node.id} must run on its named machine, which could not take it; release the machine or change the step`,
					)
				: { ...ref, kind: "replace", excludePlacement: next.excludePlacement, outcome };
		case "fix_request":
			// A vote's check that rejects its candidate has answered the vote: it settles, and the vote decides from both
			// checks. Held for re-planning it would never settle, and the vote would wait for it without end.
			return standing.answersVote ? settle : hold("replan", next.remedy);
		case "ask_owner":
			return hold("owner", next.question);
		case "ask_root":
			return hold("root", next.question);
		case "abandon":
			return next.reason === "dependency"
				? hold("replan", `step ${node.id} cannot go on until something it depends on changes`)
				: settle;
		default:
			return undefined;
	}
}

/** The attempt states in which a worker's turn is still open. */
const OPEN_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "leased", "running", "suspended"]);

/**
 * Rule 7: the workers of a closed plan that can be retired now. They are the workers of every task the plan released, for
 * its current steps and for the ones a revision replaced, through each task's successors. A worker with a turn still open
 * (a step being stopped) is left for a later pass, and one already retired asks for nothing.
 */
function workersToRetire(projection: ReconcileProjection, plan: PlanRuntimeState, planId: string): PlanAction[] {
	const released = [
		...Object.values(plan.nodes).flatMap((runtime) => (runtime.release ? [runtime.release.taskId] : [])),
		...plan.retired.map((entry) => entry.taskId),
	];
	const open = new Set<string>();
	const workers = new Set<string>();
	for (const origin of released) {
		for (const taskId of planTaskChain(projection, origin)) {
			for (const attemptId of projection.tasks[taskId]?.attemptIds ?? []) {
				const attempt = projection.attempts[attemptId];
				if (attempt?.agentId === undefined) continue;
				workers.add(attempt.agentId);
				if (OPEN_ATTEMPT_STATUSES.has(attempt.status)) open.add(attempt.agentId);
			}
		}
	}
	return [...workers]
		.filter((agentId) => {
			const status = projection.agents[agentId]?.status;
			return status !== undefined && status !== "retired" && !open.has(agentId);
		})
		.map((agentId) => ({ kind: "retire_worker", planId, agentId }));
}

/** Whether a node's settlement is in: a join settled, or a released node settled. */
function settledNode(plan: PlanRuntimeState, nodeId: string): boolean {
	const runtime = plan.nodes[nodeId];
	return runtime !== undefined && (runtime.join !== undefined || runtime.settled !== undefined);
}

/** Rule 2: released tasks the plan must stop, with the reason code. */
function tasksToCancel(projection: ReconcileProjection, plan: PlanRuntimeState, planId: string): PlanAction[] {
	const live = (taskId: string) => {
		const status = projection.tasks[taskId]?.task.status;
		return status !== undefined && !TERMINAL_TASK_STATUSES.has(status);
	};
	const actions: PlanAction[] = plan.retired
		.map((entry) => ({ entry, taskId: currentTaskOf(projection, entry.taskId) }))
		.filter(({ taskId }) => live(taskId))
		.map(({ entry, taskId }) => ({ kind: "cancel_task", planId, taskId, reason: `plan_step_${entry.reason}` }));
	if (plan.closed) {
		for (const runtime of Object.values(plan.nodes)) {
			const taskId = runtime.release ? currentTaskOf(projection, runtime.release.taskId) : undefined;
			if (taskId && !runtime.settled && live(taskId))
				actions.push({ kind: "cancel_task", planId, taskId, reason: "plan_closed" });
		}
	}
	return actions;
}

function closeReason(
	projection: ReconcileProjection,
	record: PlanRecord,
	goal: GoalState | undefined,
): string | undefined {
	const status = projection.objectives[record.objectiveId]?.objective.status;
	if (status === "cancelled") return "the goal was cancelled";
	if (status === "completed") return "the goal was completed";
	if (record.goalId && goal && goal.goalId !== record.goalId) return "the goal was replaced";
	return undefined;
}

/** A step waits on the owner for an exhausted budget: no plan releases until the owner answers. */
function budgetHeld(projection: ReconcileProjection): boolean {
	return Object.values(projection.plans).some(
		(plan) =>
			!plan.closed &&
			Object.values(plan.nodes).some((runtime) => {
				if (runtime.held?.reason !== "owner" || !runtime.release) return false;
				return (
					currentOutcome(projection, currentTaskOf(projection, runtime.release.taskId))?.blocker ===
					"budget_exhausted"
				);
			}),
	);
}

/** The node actions of one open plan (rules 3-5). */
function nodeActions(
	projection: ReconcileProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	releases: boolean,
): PlanAction[] {
	const actions: PlanAction[] = [];
	const critical = planCriticalPath(record);
	const wrapped = new Set(
		record.nodes.filter((node) => node.kind === "verify").flatMap((node) => node.join?.members ?? []),
	);
	const voteChecks = new Set(
		record.nodes
			.filter((node) => node.kind === "vote")
			.flatMap((vote) => voteChecksOf(record, vote).map((check) => check.id)),
	);
	record.nodes.forEach((node, order) => {
		const runtime = plan.nodes[node.id];
		const ref = { planId: record.planId, nodeId: node.id };
		if (!runtime || runtime.join) return;
		if (runtime.release) {
			const outcome = currentOutcome(projection, currentTaskOf(projection, runtime.release.taskId));
			if (runtime.settled) {
				const unwrapped = !wrapped.has(node.id) && !runtime.held && node.kind === "work";
				if (outcome?.nextAction.kind === "verify_independently" && unwrapped)
					actions.push({
						...ref,
						kind: "verify_wrap",
						requirementIds: outcome.nextAction.requirementIds,
						outcome,
						settled: true,
					});
				return;
			}
			if (outcome && outcome.generation > (runtime.held?.generation ?? 0)) {
				const action = outcomeAction(ref, node, outcome, {
					checked: wrapped.has(node.id),
					answersVote: voteChecks.has(node.id),
				});
				if (action) actions.push(action);
			} else if (
				!outcome &&
				!runtime.held &&
				projection.tasks[currentTaskOf(projection, runtime.release.taskId)]?.task.status === "cancelled"
			) {
				actions.push({
					...ref,
					kind: "hold",
					reason: "replan",
					detail: `step ${node.id} was stopped before it finished`,
					generation: 0,
				});
			}
			return;
		}
		if (runtime.held) return;
		if (isCodeSettledJoin(node.kind)) {
			const ordered = node.after.every((id) => settledNode(plan, id));
			if (ordered && (node.join?.members ?? []).some((id) => settledNode(plan, id)))
				actions.push({ ...ref, kind: "code_join" });
			return;
		}
		// A step only joins already settled can never change the result (a race or quorum settled without it).
		const needed =
			node.id === record.final ||
			record.nodes.some((other) => planNodeEdges(other).includes(node.id) && !settledNode(plan, other.id));
		if (releases && needed && planNodeReleasable(projection, plan, record, node)) {
			const priority = node.kind === "verify" ? 3 : critical.has(node.id) ? 2 : 1;
			actions.push({ ...ref, kind: "release", priority, order });
		}
	});
	return actions;
}

/** Updates an open plan owes the root: joins other than the final, holds, and goal requirements nobody owns. */
function openPlanUpdates(plan: PlanRuntimeState, record: PlanRecord, goal: GoalState | undefined): PlanUpdateIntent[] {
	const updates: PlanUpdateIntent[] = [];
	for (const node of record.nodes) {
		const runtime = plan.nodes[node.id];
		if (runtime?.join && node.id !== record.final) {
			updates.push({
				planId: record.planId,
				input: { kind: "join", nodeId: node.id, sequence: runtime.join.n, since: runtime.since },
				artifact: runtime.join.artifact,
			});
		}
		if (runtime?.held) {
			updates.push({
				planId: record.planId,
				input: {
					kind: runtime.held.reason === "owner" ? "owner" : "replan",
					nodeId: node.id,
					detail: runtime.held.detail,
					sequence: runtime.held.generation,
					since: runtime.since,
				},
			});
		}
	}
	if (goal && record.goalId === goal.goalId) {
		const cited = new Set(record.nodes.flatMap((node) => node.requirementIds));
		const unowned = goal.requirements
			.filter((requirement) => requirement.status === "open")
			.filter((requirement) => !cited.has(requirement.id) && !record.rootOwned.includes(requirement.id));
		if (unowned.length > 0) {
			updates.push({
				planId: record.planId,
				input: {
					kind: "replan",
					detail: `The goal now has requirements no step proves: ${unowned.map((requirement) => requirement.id).join(", ")}. Revise the plan to cover them or keep them yourself.`,
					sequence: idSetSequence(unowned.map((requirement) => requirement.id)),
				},
			});
		}
	}
	return updates;
}

/**
 * A released task ended for good and no outcome will come: the task is terminal, its terminal notice is queued (the
 * lifecycle records the outcome before it queues the notice) and the task has none. Such a step cannot move.
 */
function endedWithoutOutcome(projection: ReconcileProjection, taskId: string): boolean {
	const task = projection.tasks[taskId];
	if (!task || task.outcome || !TERMINAL_TASK_STATUSES.has(task.task.status)) return false;
	return Object.values(projection.notifications).some(
		(notification) =>
			notification.attemptId !== undefined && projection.attempts[notification.attemptId]?.taskId === taskId,
	);
}

/** A plan that can no longer move: nothing running, ready, held or decidable, and the final step unsettled. */
function isStuck(projection: ReconcileProjection, plan: PlanRuntimeState, record: PlanRecord): boolean {
	if (settledNode(plan, record.final)) return false;
	return record.nodes.every((node) => {
		const runtime = plan.nodes[node.id];
		if (!runtime || runtime.join || runtime.settled) return true;
		if (runtime.held) return false;
		if (runtime.release) return endedWithoutOutcome(projection, currentTaskOf(projection, runtime.release.taskId));
		return !planNodeReleasable(projection, plan, record, node);
	});
}

/** Pending terminals of plan tasks whose outcome the plan has consumed (or that the plan no longer runs). */
function consumedTerminals(projection: ReconcileProjection): string[] {
	const ids: string[] = [];
	for (const notification of Object.values(projection.notifications)) {
		if (notification.status !== "pending" || !notification.attemptId) continue;
		const attempt = projection.attempts[notification.attemptId];
		if (!attempt || !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
		const owner = planNodeOfTask(projection, attempt.taskId);
		if (!owner) continue;
		const outcome = projection.tasks[attempt.taskId]?.outcome;
		const consumed =
			owner.retired ||
			projection.plans[owner.planId]?.closed !== undefined ||
			(outcome !== undefined &&
				(isOutcomeFromNewerBuild(outcome) ||
					outcome.attempts.some((entry) => entry.attemptId === notification.attemptId)));
		if (consumed) ids.push(notification.notificationId);
	}
	return ids;
}

export function reconcilePlans(projection: ReconcileProjection, goal: GoalState | undefined): PlanReconcileResult {
	const actions: PlanAction[] = [];
	const updates: PlanUpdateIntent[] = [];
	const releases = !budgetHeld(projection);
	for (const [planId, plan] of Object.entries(projection.plans)) {
		const record = plan.record;
		if (isPlanFromNewerBuild(record)) continue;
		actions.push(...tasksToCancel(projection, plan, planId));
		if (plan.closed) {
			actions.push(...workersToRetire(projection, plan, planId));
			if (plan.closed.status === "settled") {
				const artifact = plan.nodes[record.final]?.join?.artifact;
				updates.push({
					planId,
					input: { kind: "settled", nodeId: record.final, sequence: 1 },
					...(artifact ? { artifact } : {}),
				});
			}
			continue;
		}
		const reason = closeReason(projection, record, goal);
		if (reason) {
			actions.push({ kind: "close", planId, status: "cancelled", reason });
			continue;
		}
		if (settledNode(plan, record.final)) {
			actions.push({ kind: "close", planId, status: "settled", reason: "the final step finished" });
			continue;
		}
		const paused = projection.objectives[record.objectiveId]?.objective.status === "paused";
		const own = nodeActions(projection, plan, record, releases && !paused);
		actions.push(...own);
		updates.push(...openPlanUpdates(plan, record, goal));
		if (own.length === 0 && isStuck(projection, plan, record)) {
			updates.push({
				planId,
				input: {
					kind: "failed",
					detail:
						"No step can run: a step ended without an accepted result and the steps after it need one. Revise the plan or cancel it.",
					sequence: record.version,
				},
			});
		}
	}
	// Every other action first, in plan order; then releases: verifiers, the critical path, plan order.
	const releaseKey = (action: PlanAction) => (action.kind === "release" ? action.priority * 1000 - action.order : 0);
	const ordered = [
		...actions.filter((action) => action.kind !== "release"),
		...actions.filter((action) => action.kind === "release").sort((a, b) => releaseKey(b) - releaseKey(a)),
	];
	return { actions: ordered, updates, acknowledge: consumedTerminals(projection) };
}
