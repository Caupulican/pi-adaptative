/**
 * The owner's view of a plan, in plain words: the work-panel rows, the `/status` line and the `/plan` inspection text,
 * all built from one `PlanView` (`plan-view.ts`). Pure builders: no TUI, no I/O, no ids on screen. Every output is
 * bounded: intents and titles are clipped and the inspection lists at most `PLAN_LIMITS.nodes` steps per plan.
 */

import type { NextAction, OutcomeStatus } from "../delegation/worker-outcome-contract.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { Placement } from "../placement/placement-types.ts";
import type { OrchestrationPanelRow, OrchestrationRowStatus } from "../tools/orchestration-panel.ts";
import { PLAN_LIMITS, type PlanHoldReason, type PlanNodeKind, type PlanNodeState } from "./plan-graph.ts";
import type { PlanCounts, PlanNodeView, PlanView } from "./plan-view.ts";

/** Characters a step intent, a plan title and a held step's detail keep on screen. */
export const PLAN_PANEL_LIMITS = { intentChars: 120, titleChars: 60, detailChars: 240 } as const;

const STATE_WORDS: Readonly<Record<Exclude<PlanNodeState, "held">, string>> = {
	planned: "waiting",
	ready: "starting",
	admitted: "starting",
	running: "running",
	settled: "done",
	superseded: "replaced",
	cancelled: "cancelled",
};

const HOLD_WORDS: Readonly<Record<PlanHoldReason, string>> = {
	owner: "needs you",
	replan: "needs a re-plan",
	root: "waiting on the root",
};

const OUTCOME_WORDS: Readonly<Record<OutcomeStatus, string>> = {
	succeeded: "finished",
	partial: "partly finished",
	blocked: "stopped on a blocker",
	failed: "failed",
	cancelled: "cancelled",
};

/** What happens next after a settled step's outcome; `accept` needs no words. */
const NEXT_ACTION_WORDS: Readonly<Record<NextAction["kind"], string | undefined>> = {
	accept: undefined,
	verify_in_lane: "to be checked by the same worker",
	verify_independently: "independent check next",
	host_check: "host check next",
	rerun_uncovered: "rerun for what is missing",
	retry_after: "retry later",
	wait_capacity: "waiting for room",
	replace: "running again on this machine",
	fix_request: "needs a fix",
	ask_owner: "needs your answer",
	ask_root: "question for the root",
	abandon: "given up",
};

const KIND_WORDS: Readonly<Record<PlanNodeKind, string | undefined>> = {
	work: undefined,
	collect: "collects results",
	reduce: "combines answers",
	merge: "merges changes",
	vote: "picks the best",
	race: "first one wins",
	verify: "independent check",
};

const PLACEMENT_WORDS: Readonly<Record<Placement["kind"], string>> = {
	local_worker: "worker",
	bot: "bot",
	leader: "leader",
	remote_machine: "another machine",
};

const PLAN_STATUS_WORDS: Readonly<Record<PlanView["status"], string>> = {
	active: "running",
	paused: "paused",
	settled: "finished",
	cancelled: "cancelled",
	unsupported: "kept, not run by this version",
};

/** One line of model or owner text, whitespace folded, clipped to `max` characters. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function steps(count: number): string {
	return `${count} step${count === 1 ? "" : "s"}`;
}

function isOpen(view: PlanView): boolean {
	return view.status === "active" || view.status === "paused";
}

function stateWord(node: PlanNodeView): string {
	if (node.state === "held") return node.held ? HOLD_WORDS[node.held.reason] : "held";
	return STATE_WORDS[node.state];
}

function rowStatus(node: PlanNodeView): OrchestrationRowStatus {
	switch (node.state) {
		case "held":
			return "blocked";
		case "running":
			return "running";
		case "ready":
		case "admitted":
			return "queued";
		case "planned":
			return "pending";
		case "superseded":
		case "cancelled":
			return "cancelled";
		case "settled":
			return node.outcomeStatus ?? "info";
	}
}

/**
 * The state, dependency, kind, effort, placement, attempt and outcome of one step in plain words, in that order. The
 * dependency is shown only while the step still waits; a finished step's count is history.
 */
function nodeWords(node: PlanNodeView): string[] {
	const waiting = node.state === "planned" || node.state === "ready";
	const outcome = node.state === "settled" && node.outcomeStatus ? OUTCOME_WORDS[node.outcomeStatus] : undefined;
	const next = node.state === "settled" && node.nextAction ? NEXT_ACTION_WORDS[node.nextAction] : undefined;
	return [
		stateWord(node),
		waiting && node.predecessors > 0 ? `after ${steps(node.predecessors)}` : undefined,
		KIND_WORDS[node.kind],
		node.effort === "deep" ? "hard step, deep thinking" : undefined,
		node.placement ? PLACEMENT_WORDS[node.placement.kind] : undefined,
		node.attempts > 1 ? `attempt ${node.attempts}` : undefined,
		outcome,
		next,
	].filter((word): word is string => word !== undefined);
}

/** `3 of 7 done`, then running, waiting and held counts that are not zero. */
export function planCountWords(counts: PlanCounts): string[] {
	const heldElsewhere = counts.held - counts.heldOnOwner;
	return [
		`${counts.settled} of ${counts.total} done`,
		counts.running > 0 ? `${counts.running} running` : undefined,
		counts.waiting > 0 ? `${counts.waiting} waiting` : undefined,
		counts.heldOnOwner > 0 ? `${counts.heldOnOwner} need${counts.heldOnOwner === 1 ? "s" : ""} you` : undefined,
		heldElsewhere > 0 ? `${heldElsewhere} held` : undefined,
	].filter((word): word is string => word !== undefined);
}

/** The section heading the plan's rows sit under: title, then counts or how it ended. */
export function planSectionHeading(view: PlanView): string {
	const title = clip(view.title, PLAN_PANEL_LIMITS.titleChars);
	if (view.status === "unsupported") return `Plan: ${title}`;
	const tail = view.status === "active" ? planCountWords(view.counts) : [PLAN_STATUS_WORDS[view.status]];
	return [`Plan: ${title}`, ...tail].join(" · ");
}

export function planNodePanelRow(view: PlanView, node: PlanNodeView): OrchestrationPanelRow {
	return {
		status: rowStatus(node),
		label: clip(node.intent, PLAN_PANEL_LIMITS.intentChars),
		section: planSectionHeading(view),
		meta: nodeWords(node),
		details: node.held ? [clip(node.held.detail, PLAN_PANEL_LIMITS.detailChars)] : [],
	};
}

/**
 * The plans the work panel shows: every open plan, or the latest closed one when none is open so the owner sees how
 * the last plan ended. `views` is `listPlanViews` order (open first, then newest closed).
 */
export function panelPlans(views: readonly PlanView[]): readonly PlanView[] {
	const open = views.filter(isOpen);
	if (open.length > 0) return open;
	const latest = views.find((view) => view.status !== "unsupported");
	return latest ? [latest] : [];
}

/**
 * The step task of every attempt a plan released, keyed by attempt id, so a plan member's worker row reads as its step
 * instead of the raw task label. Every retained plan contributes; a step without a release has no attempt.
 */
export function planStepByAttempt(
	projection: Pick<TaskRuntimeProjection, "tasks">,
	views: readonly PlanView[],
): ReadonlyMap<string, string> {
	const byAttempt = new Map<string, string>();
	for (const node of views.flatMap((view) => view.nodes)) {
		if (node.taskId === undefined) continue;
		const intent = clip(node.intent, PLAN_PANEL_LIMITS.intentChars);
		for (const attemptId of projection.tasks[node.taskId]?.attemptIds ?? []) byAttempt.set(attemptId, intent);
	}
	return byAttempt;
}

/** Work-panel rows for the plans `panelPlans` chose, one row per step under its plan's heading. */
export function planPanelRows(views: readonly PlanView[]): OrchestrationPanelRow[] {
	return views.flatMap((view) => view.nodes.map((node) => planNodePanelRow(view, node)));
}

/**
 * The `/status` line of one open plan, for example
 * `Plan "Add export to CSV": 3 of 7 done, 2 running, waiting on you for 1 step.`
 */
export function planStatusLine(view: Pick<PlanView, "title" | "status" | "counts">): string {
	const { counts } = view;
	const heldElsewhere = counts.held - counts.heldOnOwner;
	const parts = [
		`${counts.settled} of ${counts.total} done`,
		counts.running > 0 ? `${counts.running} running` : undefined,
		heldElsewhere > 0 ? `${heldElsewhere} held for a new plan or the root` : undefined,
		counts.heldOnOwner > 0 ? `waiting on you for ${steps(counts.heldOnOwner)}` : undefined,
		view.status === "paused" ? "paused" : undefined,
	].filter((part): part is string => part !== undefined);
	return `Plan "${clip(view.title, PLAN_LIMITS.titleChars)}": ${parts.join(", ")}.`;
}

export interface PlanInspectionOptions {
	/** A goal requirement's text by id; requirements it does not know are counted, never printed by id. */
	readonly requirementText?: (requirementId: string) => string | undefined;
}

function inspectOpenPlan(view: PlanView, options: PlanInspectionOptions): string[] {
	const shown = view.nodes.slice(0, PLAN_LIMITS.nodes);
	const known = view.rootOwned.flatMap((id) => {
		const text = options.requirementText?.(id);
		return text ? [clip(text, PLAN_PANEL_LIMITS.intentChars)] : [];
	});
	const unnamed = view.rootOwned.length - known.length;
	return [
		`Plan "${clip(view.title, PLAN_LIMITS.titleChars)}" (version ${view.version}, ${PLAN_STATUS_WORDS[view.status]}): ${planCountWords(view.counts).join(", ")}`,
		...(view.unjudged ? ["  Checked without System One: it was unavailable when the plan was recorded."] : []),
		...shown.map((node, index) => {
			const detail = node.held ? `: ${clip(node.held.detail, PLAN_PANEL_LIMITS.detailChars)}` : "";
			return `  ${index + 1}. ${clip(node.intent, PLAN_PANEL_LIMITS.intentChars)} (${nodeWords(node).join(", ")})${detail}`;
		}),
		...(view.nodes.length > shown.length ? [`  … ${steps(view.nodes.length - shown.length)} more`] : []),
		...(view.rootOwned.length > 0
			? [
					`  The root keeps ${view.rootOwned.length} requirement${view.rootOwned.length === 1 ? "" : "s"} no step covers${known.length > 0 ? ":" : "."}`,
					...known.map((text) => `    - ${text}`),
					...(known.length > 0 && unnamed > 0 ? [`    - and ${unnamed} more`] : []),
				]
			: []),
	];
}

function inspectClosedPlan(view: PlanView): string {
	if (view.status === "unsupported") return `Plan: ${view.title}; kept, not run by this version.`;
	const reason = view.closedReason ? `: ${clip(view.closedReason, PLAN_PANEL_LIMITS.detailChars)}` : "";
	return `Plan "${clip(view.title, PLAN_LIMITS.titleChars)}" (version ${view.version}) ${PLAN_STATUS_WORDS[view.status]}${reason}; ${view.counts.settled} of ${view.counts.total} done.`;
}

/** The `/plan` text: open plans step by step, closed and unsupported plans one line each. */
export function planInspectionText(views: readonly PlanView[], options: PlanInspectionOptions = {}): string {
	if (views.length === 0) return "No plan in this session.";
	return views
		.flatMap((view) => (isOpen(view) ? inspectOpenPlan(view, options) : [inspectClosedPlan(view)]))
		.join("\n");
}
