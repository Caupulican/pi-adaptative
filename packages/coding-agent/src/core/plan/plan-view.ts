/**
 * Derived plan state: each node's state, its outcome and the plan's counts, computed from the orchestration
 * projection alone. The executor's reconcile, the plan rows, `/status` and `/plan` all read this one derivation, so
 * the screen and the executor never disagree about a step.
 */

import type { NextAction, Outcome, OutcomeStatus } from "../delegation/worker-outcome-contract.ts";
import { planStepSettledOutcome } from "../orchestration/plan-review-subjects.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import type { Placement } from "../placement/placement-types.ts";
import {
	effectivePlanStatus,
	isPlanFromNewerBuild,
	type PlanNodeHold,
	type PlanNodeKind,
	type PlanNodeSpec,
	type PlanNodeState,
	type PlanRecord,
	type PlanRuntimeState,
	type PlanStatus,
	type PlanSubgraphOf,
	planNodeEdges,
} from "./plan-graph.ts";
import { pinnedMachineOf } from "./plan-placement.ts";

export type PlanProjection = Pick<TaskRuntimeProjection, "plans" | "tasks" | "attempts">;

export interface PlanNodeView {
	readonly id: string;
	readonly kind: PlanNodeKind;
	readonly intent: string;
	readonly state: PlanNodeState;
	readonly outcomeStatus?: OutcomeStatus;
	readonly nextAction?: NextAction["kind"];
	readonly held?: PlanNodeHold;
	readonly taskId?: string;
	readonly placement?: Placement;
	/** The placement exit that fired when the step was released (`plan-placement.ts`), for the trace and the panel. */
	readonly placementExit?: string;
	/** The machine the step's pin names, whether it is a preference or a must. */
	readonly pinnedMachine?: string;
	/** The owner's name for the machine the step runs on; absent until a name is supplied to `listPlanViews`. */
	readonly placementName?: string;
	/** The owner's name for the machine the step's pin names; absent until a name is supplied to `listPlanViews`. */
	readonly pinnedMachineName?: string;
	/** The planner's doubts about the step: display only, never part of the step's spec. */
	readonly doubts?: readonly string[];
	/** The steps this one waits for: its uses and its ordering edges. */
	readonly predecessors: number;
	/** The attempts its current task has run (0 before the step is released). */
	readonly attempts: number;
	readonly effort: PlanNodeSpec["effort"];
}

export interface PlanCounts {
	readonly total: number;
	readonly settled: number;
	readonly running: number;
	readonly waiting: number;
	readonly held: number;
	readonly heldOnOwner: number;
}

export interface PlanView {
	readonly planId: string;
	readonly version: number;
	readonly title: string;
	readonly goalId?: string;
	readonly subgraphOf?: PlanSubgraphOf;
	readonly status: PlanStatus | "unsupported";
	readonly unjudged: boolean;
	readonly final?: string;
	readonly rootOwned: readonly string[];
	readonly nodes: readonly PlanNodeView[];
	readonly counts: PlanCounts;
	readonly closedReason?: string;
}

/** The outcome that settles a node: a join's combined outcome, else its task's latest outcome. */
export function planNodeOutcome(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	nodeId: string,
): Outcome | undefined {
	return planStepSettledOutcome(projection, plan.nodes[nodeId]);
}

/** A node is accepted when the outcome that settles it asks for no further action. */
export function isPlanNodeAccepted(projection: PlanProjection, plan: PlanRuntimeState, node: PlanNodeSpec): boolean {
	const outcome = planNodeOutcome(projection, plan, node.id);
	if (!outcome) return false;
	if (node.kind === "work") return plan.nodes[node.id]?.settled !== undefined && outcome.nextAction.kind === "accept";
	return outcome.status === "succeeded" || outcome.status === "partial";
}

function releasedState(projection: PlanProjection, taskId: string): PlanNodeState {
	const task = projection.tasks[taskId];
	if (!task) return "admitted";
	if (task.task.status === "cancelled") return "cancelled";
	const attemptId = task.attemptIds[task.attemptIds.length - 1];
	const status = attemptId ? projection.attempts[attemptId]?.status : undefined;
	if (status === undefined || status === "queued") return "admitted";
	return "running";
}

function nodeState(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
): PlanNodeState {
	const runtime = plan.nodes[node.id];
	if (!runtime) return "superseded";
	if (runtime.held) return "held";
	if (runtime.join || runtime.settled) return "settled";
	if (plan.closed) return "cancelled";
	if (runtime.release) return releasedState(projection, currentTaskOf(projection, runtime.release.taskId));
	return planNodeReleasable(projection, plan, record, node) ? "ready" : "planned";
}

/** A node whose predecessor settled: a join reads every member's outcome, accepted or not, and decides itself. */
function isPlanNodeSettled(plan: PlanRuntimeState, node: PlanNodeSpec): boolean {
	const runtime = plan.nodes[node.id];
	return (
		runtime !== undefined &&
		runtime.held === undefined &&
		(runtime.settled !== undefined || runtime.join !== undefined)
	);
}

/**
 * Release readiness by outcome, never by the runtime's dependency rule (which counts a blocked task as satisfied): a
 * work node waits for every predecessor to be accepted; a join waits for every predecessor to settle.
 */
export function planNodeReleasable(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
): boolean {
	const byId = new Map(record.nodes.map((entry) => [entry.id, entry]));
	return planNodeEdges(node).every((edge) => {
		const predecessor = byId.get(edge);
		if (!predecessor) return false;
		return node.kind === "work"
			? isPlanNodeAccepted(projection, plan, predecessor)
			: isPlanNodeSettled(plan, predecessor);
	});
}

function nodeView(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	names: ReadonlyMap<string, string> | undefined,
): PlanNodeView {
	const runtime = plan.nodes[node.id];
	const outcome = planNodeOutcome(projection, plan, node.id);
	const placement = runtime?.release?.placement;
	const machineName = placement?.kind === "remote_machine" ? names?.get(placement.machineId) : undefined;
	const pinnedMachine = pinnedMachineOf(node);
	const pinnedMachineName = pinnedMachine === undefined ? undefined : names?.get(pinnedMachine);
	return {
		id: node.id,
		kind: node.kind,
		intent: node.intent,
		state: nodeState(projection, plan, record, node),
		...(outcome ? { outcomeStatus: outcome.status, nextAction: outcome.nextAction.kind } : {}),
		...(runtime?.held ? { held: runtime.held } : {}),
		...(runtime?.release
			? {
					taskId: currentTaskOf(projection, runtime.release.taskId),
					placement: runtime.release.placement,
					placementExit: runtime.release.exit,
				}
			: {}),
		...(machineName !== undefined ? { placementName: machineName } : {}),
		...(pinnedMachine !== undefined ? { pinnedMachine } : {}),
		...(pinnedMachineName !== undefined ? { pinnedMachineName } : {}),
		...(node.doubts && node.doubts.length > 0 ? { doubts: node.doubts } : {}),
		predecessors: planNodeEdges(node).length,
		attempts: runtime?.release
			? (projection.tasks[currentTaskOf(projection, runtime.release.taskId)]?.attemptIds.length ?? 0)
			: 0,
		effort: node.effort,
	};
}

export function planCounts(nodes: readonly PlanNodeView[]): PlanCounts {
	const count = (states: readonly PlanNodeState[]) => nodes.filter((node) => states.includes(node.state)).length;
	return {
		total: nodes.length,
		settled: count(["settled", "cancelled"]),
		running: count(["running"]),
		waiting: count(["planned", "ready", "admitted"]),
		held: count(["held"]),
		heldOnOwner: nodes.filter((node) => node.held?.reason === "owner").length,
	};
}

/** The brief a plan step was stated with, or undefined (no step named, no brief, a record from a newer build). */
export function planNodeBrief(
	projection: Pick<PlanProjection, "plans">,
	planId: string,
	nodeId: string | undefined,
): PlanNodeSpec["brief"] {
	if (nodeId === undefined) return undefined;
	const record = projection.plans[planId]?.record;
	if (!record || isPlanFromNewerBuild(record)) return undefined;
	return record.nodes.find((node) => node.id === nodeId)?.brief;
}

/**
 * The latest time a plan moved: a step's release, settlement, hold or join settlement, or the plan's revision. A revision is
 * movement like the others, so a revise after the steps moved still extends the plan's last activity. Undefined for a plan
 * that is absent, from a newer build, or undated.
 */
export function planLastActivityAt(projection: PlanProjection, planId: string): number | undefined {
	const plan = projection.plans[planId];
	if (!plan || isPlanFromNewerBuild(plan.record)) return undefined;
	const moved = Object.values(plan.nodes).flatMap((runtime) =>
		[runtime.release?.releasedAt, runtime.settled?.settledAt, runtime.held?.heldAt, runtime.join?.settledAt].filter(
			(stamp): stamp is string => stamp !== undefined,
		),
	);
	const stamps = [...moved, plan.record.revisedAt]
		.map((stamp) => Date.parse(stamp))
		.filter((ms) => Number.isFinite(ms));
	return stamps.length > 0 ? Math.max(...stamps) : undefined;
}

/**
 * One plan's view. `names` maps a linked machine's id to the owner's name for it; a step on a machine the map does not
 * name keeps no `placementName` and no `pinnedMachineName`.
 */
export function planView(
	projection: PlanProjection,
	planId: string,
	names?: ReadonlyMap<string, string>,
): PlanView | undefined {
	const plan = projection.plans[planId];
	if (!plan) return undefined;
	const record = plan.record;
	if (isPlanFromNewerBuild(record)) {
		return {
			planId,
			version: record.version,
			title: "a plan from a newer version of the harness",
			status: "unsupported",
			unjudged: false,
			rootOwned: [],
			nodes: [],
			counts: planCounts([]),
		};
	}
	const nodes = record.nodes.map((node) => nodeView(projection, plan, record, node, names));
	return {
		planId,
		version: record.version,
		title: record.title,
		...(record.goalId ? { goalId: record.goalId } : {}),
		...(record.subgraphOf ? { subgraphOf: record.subgraphOf } : {}),
		status: effectivePlanStatus(plan),
		unjudged: record.unjudged,
		final: record.final,
		rootOwned: record.rootOwned,
		nodes,
		counts: planCounts(nodes),
		...(plan.closed ? { closedReason: plan.closed.reason } : {}),
	};
}

/**
 * Every retained plan: open plans first, then closed ones, newest first. `names` (optional) names the machines steps run on
 * and the machines their pins name (`plan-views-named.ts` builds it from the fleet record, only when a step involves one).
 */
export function listPlanViews(projection: PlanProjection, names?: ReadonlyMap<string, string>): readonly PlanView[] {
	const views = Object.keys(projection.plans).flatMap((planId) => {
		const view = planView(projection, planId, names);
		return view ? [{ view, closedAt: projection.plans[planId]?.closed?.closedAt }] : [];
	});
	return views
		.sort((a, b) => {
			if ((a.closedAt === undefined) !== (b.closedAt === undefined)) return a.closedAt === undefined ? -1 : 1;
			return (b.closedAt ?? "").localeCompare(a.closedAt ?? "");
		})
		.map((entry) => entry.view);
}

/** The open root plan, if any: at most one root plan runs per session. */
export function activeRootPlan(projection: PlanProjection): PlanView | undefined {
	return runningRootPlan(listPlanViews(projection));
}

/** The running root plan among `listPlanViews` output: active and not a leader's subgraph. */
export function runningRootPlan(views: readonly PlanView[]): PlanView | undefined {
	return views.find((view) => view.status === "active" && view.subgraphOf === undefined);
}

/** A plan the owner should look at: paused, or running with a step held for a re-plan or a decision. */
export function planNeedsAttention(view: PlanView): boolean {
	return view.status === "paused" || (view.status === "active" && view.counts.held > 0);
}

/** A plan with a step running now. */
export function planIsMoving(view: PlanView): boolean {
	return view.status === "active" && view.counts.running > 0;
}

/** A plan still being carried out: running or paused (a closed or unsupported plan is history). */
export function isOpenPlanView(view: PlanView): view is PlanView & { readonly status: "active" | "paused" } {
	return view.status === "active" || view.status === "paused";
}
