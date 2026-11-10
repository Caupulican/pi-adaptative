/**
 * The owner's view of a plan, in plain words: the work-panel rows, the `/status` line and the `/plan` inspection text,
 * all built from one `PlanView` (`plan-view.ts`). Pure builders: no TUI, no I/O, no ids on screen. Every output is
 * bounded: intents and titles are clipped and the inspection lists at most `PLAN_LIMITS.nodes` steps per plan.
 */

import { interfaceText } from "../language/interface-text.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { OrchestrationPanelRow, OrchestrationRowStatus } from "../tools/orchestration-panel.ts";
import { PLAN_LIMITS } from "./plan-graph.ts";
import { PIN_MUST_LOCAL } from "./plan-placement.ts";
import type { PlanCounts, PlanNodeView, PlanView } from "./plan-view.ts";

/** Characters a step intent, a plan title and a held step's detail keep on screen. */
export const PLAN_PANEL_LIMITS = { intentChars: 120, titleChars: 60, detailChars: 240 } as const;

/** One line of model or owner text, whitespace folded, clipped to `max` characters. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function steps(count: number): string {
	return interfaceText().autonomyCommands.plan.steps(count);
}

function isOpen(view: PlanView): boolean {
	return view.status === "active" || view.status === "paused";
}

function stateWord(node: PlanNodeView): string {
	const words = interfaceText().autonomyCommands.plan;
	if (node.state === "held") return node.held ? words.hold[node.held.reason] : words.state.held;
	return words.state[node.state];
}

/** Where a released step runs, in plain words: a must-pinned step that ran here says so, and a machine is named when known. */
function placementWord(node: PlanNodeView): string | undefined {
	const words = interfaceText().autonomyCommands.plan;
	if (!node.placement) return undefined;
	if (node.placementExit === PIN_MUST_LOCAL) return words.pinnedUnavailable;
	if (node.placement.kind === "remote_machine" && node.placementName !== undefined)
		return words.machine(node.placementName);
	return words.placement[node.placement.kind];
}

/** The machine a must-pinned step waits for, in plain words: its name when the fleet names it, else that it is not linked. */
function pinnedMachineWords(node: PlanNodeView): string {
	const words = interfaceText().autonomyCommands.plan;
	return node.pinnedMachineName !== undefined ? words.machine(node.pinnedMachineName) : words.unlinkedMachine;
}

/**
 * The lines a step carries beyond its state: a must-pinned step that ran here, then each of the planner's doubts. Shared by
 * the work-panel rows and the `/plan` text so both read the same.
 */
function stepDetailLines(node: PlanNodeView): string[] {
	const words = interfaceText().autonomyCommands.plan;
	const pinned =
		node.placementExit === PIN_MUST_LOCAL && node.pinnedMachine !== undefined
			? [words.pinnedNoMachine(pinnedMachineWords(node))]
			: [];
	return [
		...pinned.map((line) => clip(line, PLAN_PANEL_LIMITS.detailChars)),
		...(node.doubts ?? []).map((doubt) => clip(words.doubt(doubt), PLAN_PANEL_LIMITS.detailChars)),
	];
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
 * The words of a step's kind. A collect join that settles on a quorum says there how many of its members it needs, so it
 * never reads as if every one of them were needed.
 */
function kindWords(node: PlanNodeView): string | undefined {
	const join = node.join;
	if (node.kind === "collect" && join?.quorum !== undefined)
		return interfaceText().autonomyCommands.plan.quorumKind(join.quorum, steps(join.members));
	return interfaceText().autonomyCommands.plan.kind[node.kind];
}

/**
 * The state, dependency, kind, effort, placement, attempt and outcome of one step in plain words, in that order. The
 * dependency is shown only while the step still waits; a finished step's count is history.
 */
function nodeWords(node: PlanNodeView): string[] {
	const words = interfaceText().autonomyCommands.plan;
	const waiting = node.state === "planned" || node.state === "ready";
	// A quorum join states its quorum in its kind words, in place of a count of every step it reads.
	const quorumJoin = node.kind === "collect" && node.join?.quorum !== undefined;
	const outcome = node.state === "settled" && node.outcomeStatus ? words.outcome[node.outcomeStatus] : undefined;
	const next = node.state === "settled" && node.nextAction ? words.nextAction[node.nextAction] : undefined;
	return [
		stateWord(node),
		waiting && !quorumJoin && node.predecessors > 0 ? words.afterSteps(steps(node.predecessors)) : undefined,
		kindWords(node),
		node.effort === "deep" ? words.hardStep : undefined,
		placementWord(node),
		node.attempts > 1 ? words.attempt(node.attempts) : undefined,
		outcome,
		next,
	].filter((word): word is string => word !== undefined);
}

/** `3 of 7 done`, then running, waiting and held counts that are not zero. */
export function planCountWords(counts: PlanCounts): string[] {
	const words = interfaceText().autonomyCommands.plan;
	const heldElsewhere = counts.held - counts.heldOnOwner;
	return [
		words.doneCount(counts.settled, counts.total),
		counts.running > 0 ? words.running(counts.running) : undefined,
		counts.waiting > 0 ? words.waiting(counts.waiting) : undefined,
		counts.heldOnOwner > 0 ? words.needsYou(counts.heldOnOwner) : undefined,
		heldElsewhere > 0 ? words.heldCount(heldElsewhere) : undefined,
	].filter((word): word is string => word !== undefined);
}

/** The section heading the plan's rows sit under: title, then counts or how it ended. */
export function planSectionHeading(view: PlanView): string {
	const words = interfaceText().autonomyCommands.plan;
	const title = clip(view.title, PLAN_PANEL_LIMITS.titleChars);
	if (view.status === "unsupported") return words.heading(title);
	const tail = view.status === "active" ? planCountWords(view.counts) : [words.status[view.status]];
	return [words.heading(title), ...tail].join(" · ");
}

export function planNodePanelRow(view: PlanView, node: PlanNodeView): OrchestrationPanelRow {
	return {
		status: rowStatus(node),
		label: clip(node.intent, PLAN_PANEL_LIMITS.intentChars),
		section: planSectionHeading(view),
		meta: nodeWords(node),
		details: [
			...(node.held ? [clip(node.held.detail, PLAN_PANEL_LIMITS.detailChars)] : []),
			...stepDetailLines(node),
		],
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
	const words = interfaceText().autonomyCommands.plan;
	const { counts } = view;
	const heldElsewhere = counts.held - counts.heldOnOwner;
	const parts = [
		words.doneCount(counts.settled, counts.total),
		counts.running > 0 ? words.running(counts.running) : undefined,
		heldElsewhere > 0 ? words.statusLineHeldElsewhere(heldElsewhere) : undefined,
		counts.heldOnOwner > 0 ? words.statusLineWaitingOnOwner(steps(counts.heldOnOwner)) : undefined,
		view.status === "paused" ? words.paused : undefined,
	].filter((part): part is string => part !== undefined);
	return words.statusLine(clip(view.title, PLAN_LIMITS.titleChars), parts.join(", "));
}

export interface PlanInspectionOptions {
	/** A goal requirement's text by id; requirements it does not know are counted, never printed by id. */
	readonly requirementText?: (requirementId: string) => string | undefined;
}

function inspectOpenPlan(view: PlanView, options: PlanInspectionOptions): string[] {
	const words = interfaceText().autonomyCommands.plan;
	const shown = view.nodes.slice(0, PLAN_LIMITS.nodes);
	const known = view.rootOwned.flatMap((id) => {
		const text = options.requirementText?.(id);
		return text ? [clip(text, PLAN_PANEL_LIMITS.intentChars)] : [];
	});
	const unnamed = view.rootOwned.length - known.length;
	return [
		words.openHead(
			clip(view.title, PLAN_LIMITS.titleChars),
			view.version,
			words.status[view.status],
			planCountWords(view.counts).join(", "),
		),
		...(view.unjudged ? [words.unjudged] : []),
		...shown.flatMap((node, index) => {
			const detail = node.held ? `: ${clip(node.held.detail, PLAN_PANEL_LIMITS.detailChars)}` : "";
			const step = words.openStep(
				index + 1,
				clip(node.intent, PLAN_PANEL_LIMITS.intentChars),
				nodeWords(node).join(", "),
			);
			return [`${step}${detail}`, ...stepDetailLines(node).map((line) => `     ${line}`)];
		}),
		...(view.nodes.length > shown.length ? [words.moreSteps(steps(view.nodes.length - shown.length))] : []),
		...(view.rootOwned.length > 0
			? [
					words.rootKeeps(view.rootOwned.length, known.length > 0),
					...known.map((text) => words.rootKeepsItem(text)),
					...(known.length > 0 && unnamed > 0 ? [words.rootKeepsMore(unnamed)] : []),
				]
			: []),
	];
}

function inspectClosedPlan(view: PlanView): string {
	const words = interfaceText().autonomyCommands.plan;
	if (view.status === "unsupported") return words.unsupportedHeading(view.title);
	const reason = view.closedReason ? words.closedReason(clip(view.closedReason, PLAN_PANEL_LIMITS.detailChars)) : "";
	return words.closed(
		clip(view.title, PLAN_LIMITS.titleChars),
		view.version,
		words.status[view.status],
		reason,
		view.counts.settled,
		view.counts.total,
	);
}

/** The `/plan` text: open plans step by step, closed and unsupported plans one line each. */
export function planInspectionText(views: readonly PlanView[], options: PlanInspectionOptions = {}): string {
	if (views.length === 0) return interfaceText().autonomyCommands.plan.none;
	return views
		.flatMap((view) => (isOpen(view) ? inspectOpenPlan(view, options) : [inspectClosedPlan(view)]))
		.join("\n");
}
