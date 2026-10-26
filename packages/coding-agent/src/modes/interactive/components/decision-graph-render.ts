/**
 * What the Decision graph's two views share: the rows contract they return, the System One tone, the
 * labels and texts both draw from the model, and the levels the Diagram draws (composeDecisionDiagram).
 * decision-graph-list.ts lays out and paints the List; decision-graph-scene.ts lays out and paints the
 * Diagram. Pure: no clock, no state.
 */

import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import { evaluationResultText } from "../../../core/system-one/semantic-evaluation-ledger.ts";
import { formatCompactDuration } from "../../../core/util/format-duration.ts";
import type { ThemeColor } from "../../../presentation/theme-model.ts";
import {
	type DecisionGraphModel,
	type DecisionParticipant,
	type DecisionPlanStepStatus,
	goalClosure,
} from "./decision-graph-model.ts";

export interface DecisionGraphRows {
	readonly rows: readonly string[];
	/** `stageAt[i]` is the stage a click on row `i` expands, or undefined for a non-stage row. */
	readonly stageAt: readonly (DecisionStage | undefined)[];
	/**
	 * The stage under one content cell, for views that lay nodes side by side (a row alone cannot say which).
	 * Column is relative to the content's left edge; absent for views that are row-granular.
	 */
	readonly stageAtCell?: (column: number, row: number) => DecisionStage | undefined;
	/**
	 * The first `pinnedRows` rows (a header) stay at the top of the pane while the rest scroll beneath them.
	 * `currentRow`, `stageAt` and `stageAtCell` rows still index the whole `rows` array.
	 */
	readonly pinnedRows?: number;
	/** The row a following pane keeps in view: the current stage (List) or the current node (Diagram). */
	readonly currentRow: number;
	/** Semantic focus identity; row number alone is not stable across a reflow. */
	readonly focusKey: string;
	/** When a carrier is drawn: the moment it is no longer needed (always finite). Absent: no motion. */
	readonly motionUntil?: number;
}

/**
 * The decider's tone: the label tone marks System One everywhere in the Workbench. Only System One things
 * wear it (the decider, its evaluations, judgments and doubts); executors it did not choose do not.
 */
export const SYSTEM_ONE_TONE: ThemeColor = "customMessageLabel";

export const STAGE_LABEL: Readonly<Record<DecisionStage, string>> = {
	understand: "understand",
	plan: "plan",
	build: "build",
	dispatch: "dispatch",
	observe: "observe",
	verify: "verify",
	clarify: "clarify (ask you)",
	repair: "repair / replan",
	deliver: "deliver",
	done: "done",
};

const PLAN_GLYPH: Readonly<Record<DecisionPlanStepStatus, readonly [string, ThemeColor]>> = {
	done: ["✓", "success"],
	active: ["›", "accent"],
	pending: ["·", "dim"],
	blocked: ["!", "warning"],
	failed: ["✗", "error"],
	cancelled: ["×", "dim"],
};

export function participantText(participant: DecisionParticipant): string {
	// The session's own model is on the status line; the session itself is just the agent.
	if (participant.kind === "root") return participant.model ? `brain · ${participant.model}` : "brain";
	const head = `${participant.kind} ${participant.label}`;
	return participant.model ? `${head} · ${participant.model}` : head;
}

function queuedText(participant: DecisionParticipant): string {
	return `queued${participant.waitReason ? ` · ${participant.waitReason}` : ""}`;
}

export function formatLastEvaluation(model: DecisionGraphModel): string | undefined {
	const last = model.decider.last;
	if (!last) return undefined;
	const result = evaluationResultText(last) ?? last.verdict ?? last.outcome;
	return `${last.label} → ${result}`;
}

function distinctTask(participant: DecisionParticipant): string | undefined {
	const task = participant.task?.trim();
	if (!task) return undefined;
	return task.toLowerCase() !== participant.label.trim().toLowerCase() ? task : undefined;
}

/** The root's subtitle names the subagents it is orchestrating while any of them is active. */
function orchestratingText(model: DecisionGraphModel): string | undefined {
	const activeSubagents = model.participants.filter(
		(p) => (p.kind === "specialist" || p.kind === "worker") && (p.running || p.queued),
	).length;
	return activeSubagents > 0
		? `orchestrating ${activeSubagents} subagent${activeSubagents === 1 ? "" : "s"}`
		: undefined;
}

/** What an executor is doing, in one line. Route text names who chose the model; it is never System One's tone. */
export function participantSubText(
	participant: DecisionParticipant,
	model: DecisionGraphModel,
): { readonly text: string; readonly tone: ThemeColor } | undefined {
	if (participant.queued) return { text: queuedText(participant), tone: "warning" };
	const task = distinctTask(participant);
	if (participant.running) {
		const orchestrating = participant.kind === "root" ? orchestratingText(model) : undefined;
		const text = [
			task,
			orchestrating,
			participant.routeText,
			participant.startedAt !== undefined ? formatCompactDuration(model.nowMs - participant.startedAt) : "",
		]
			.filter(Boolean)
			.join(" · ");
		if (!text) return undefined;
		return { text, tone: "muted" };
	}
	if (participant.kind === "root") {
		const orchestrating = orchestratingText(model);
		if (orchestrating) return { text: orchestrating, tone: "muted" };
		if (model.you.waiting) return { text: "waiting for you", tone: "dim" };
		if (model.decider.evaluating) return { text: "waiting for System One", tone: "dim" };
		if (model.idleText) return { text: model.idleText, tone: "dim" };
		if (participant.routeText) return { text: participant.routeText, tone: "muted" };
		return undefined;
	}
	if (participant.routeText) return { text: participant.routeText, tone: "dim" };
	if (task) return { text: task, tone: "dim" };
	return undefined;
}

export function stageLabel(stage: DecisionStage, model: DecisionGraphModel): string {
	return stage === "plan" && model.plan.length > 0
		? `${STAGE_LABEL.plan} (${planProgress(model)})`
		: STAGE_LABEL[stage];
}

export function shouldShowPlainTurnStatus(model: DecisionGraphModel): boolean {
	return (
		(!model.turnRunning && (model.lastTurnOutcome === "failed" || model.lastTurnOutcome === "cancelled")) ||
		model.peerFindings.length > 0 ||
		model.unresolvedDoubtCount > 0
	);
}

export function plainTurnStatus(model: DecisionGraphModel): [string, ThemeColor] {
	const open = [
		model.peerFindings.length
			? `${model.peerFindings.length} peer finding${model.peerFindings.length === 1 ? "" : "s"}`
			: "",
		model.unresolvedDoubtCount ? `${model.unresolvedDoubtCount} unsure` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const suffix = open ? ` · ${open}` : "";
	if (model.turnRunning) return [`turn running${suffix}`, "accent"];
	if (model.lastTurnOutcome === "failed") return [`turn failed${suffix}`, "error"];
	if (model.lastTurnOutcome === "cancelled") return [`turn cancelled${suffix}`, "dim"];
	// Peer findings are reviewers' findings; only an unresolved doubt is System One's own.
	return [
		`turn finished${suffix}`,
		model.peerFindings.length > 0 ? "warning" : model.unresolvedDoubtCount > 0 ? SYSTEM_ONE_TONE : "success",
	];
}

export function planProgress(model: DecisionGraphModel): string {
	const done = model.plan.filter((step) => step.status === "done").length;
	const total = model.plan.filter((step) => step.status !== "cancelled").length;
	return `${done}/${total}`;
}

export interface PlanItem {
	readonly text: string;
	readonly glyph: string;
	readonly glyphTone: ThemeColor;
	readonly tone: ThemeColor | undefined;
}

export function planItems(model: DecisionGraphModel): PlanItem[] {
	return model.plan.map((step): PlanItem => {
		const [glyph, glyphTone] = PLAN_GLYPH[step.status];
		const tone: ThemeColor | undefined =
			step.status === "active" ? undefined : step.status === "done" ? "muted" : "dim";
		return { text: step.title, glyph, glyphTone, tone };
	});
}

export const NO_RUN_YET = "no run yet · the graph composes when work starts";

/* ============================================================ Diagram view */
export interface DiagramNode {
	readonly text: string;
	/** The running clock, kept whole while the label shortens. */
	readonly clock?: string;
	readonly tone: ThemeColor | undefined;
	readonly bold?: boolean;
	readonly current?: boolean;
	readonly sub?: string;
	readonly subTone?: ThemeColor;
	readonly stage?: DecisionStage;
}

export type DiagramLevel =
	| { readonly kind: "you"; readonly node: DiagramNode; readonly note: string; readonly noteTone: ThemeColor }
	| {
			readonly kind: "box";
			readonly node: DiagramNode;
			readonly sub: string;
			readonly subTone: ThemeColor;
			readonly boxTone: ThemeColor;
	  }
	| {
			readonly kind: "tree";
			readonly title: string;
			readonly items: readonly {
				readonly text: string;
				readonly glyph: string;
				readonly glyphTone: ThemeColor;
				readonly tone: ThemeColor | undefined;
				readonly stage?: DecisionStage;
				readonly current?: boolean;
				readonly clock?: string;
			}[];
	  }
	| { readonly kind: "level"; readonly nodes: readonly DiagramNode[] }
	| {
			readonly kind: "branch";
			readonly question: DiagramNode;
			readonly yes: DiagramNode & { readonly lit: boolean };
			readonly no?: DiagramNode & { readonly loop?: string };
	  }
	| { readonly kind: "next"; readonly text: string };

/**
 * The semantic focus of a view: the objective, the stage the loop is in, which loop, and the goal branch.
 * A pane re-centres only when this changes; receipts, evaluations and participants moving do not.
 */
export function graphFocusKey(model: DecisionGraphModel): string {
	return `obj:${model.objectiveId}/stage:${model.current?.stage ?? "idle"}/loop:${model.current?.loop ?? model.loop}/branch:${model.goal.branch}`;
}

function goalYesNode(model: DecisionGraphModel): DiagramNode & { readonly lit: boolean } {
	const { delivered, delivering } = goalClosure(model);
	if (delivered || delivering) {
		return {
			text: delivered ? "delivered" : "DELIVER",
			tone: delivered ? "success" : "accent",
			bold: delivering,
			stage: "deliver",
			lit: true,
		};
	}
	return {
		text: "not closed",
		tone: model.unresolvedDoubtCount > 0 ? SYSTEM_ONE_TONE : "dim",
		stage: "deliver",
		lit: false,
	};
}

/** Levels derived from the task; nothing here is fixed. */
export function composeDecisionDiagram(model: DecisionGraphModel): DiagramLevel[] {
	const now = model.nowMs;
	const cur = model.current;
	const currentStage = cur?.stage;
	const evaluating = model.decider.evaluating;
	const levels: DiagramLevel[] = [];
	if (model.stageLogEmpty) {
		const quiet: DiagramLevel[] = model.plan.length
			? [
					{ kind: "tree", title: `plan ${planProgress(model)}`, items: planItems(model) },
					{ kind: "level", nodes: [{ text: NO_RUN_YET, tone: "dim" }] },
				]
			: [{ kind: "level", nodes: [{ text: "no task yet", tone: "dim" }] }];
		const statuses: DiagramNode[] = [];
		if (model.checks.length) {
			const openChecks = model.checks.filter((check) => check.status !== "satisfied").length;
			statuses.push({
				text: `CHECKS ${model.checks.length - openChecks}/${model.checks.length}`,
				tone: openChecks ? "warning" : "success",
			});
		}
		if (model.peerFindings.length)
			statuses.push({ text: `PEER FINDINGS ${model.peerFindings.length} active`, tone: "warning" });
		if (model.unresolvedDoubtCount)
			statuses.push({ text: `ADVISORY DOUBTS ${model.unresolvedDoubtCount}`, tone: SYSTEM_ONE_TONE });
		if (statuses.length) quiet.push({ kind: "level", nodes: statuses });
		return quiet;
	}

	if (model.you.present) {
		const isCur = currentStage === "clarify";
		levels.push({
			kind: "you",
			node: {
				text: "YOU",
				tone: isCur ? "warning" : undefined,
				bold: isCur,
				current: isCur,
				stage: "clarify",
			},
			note: isCur ? "waiting for your answer" : `asked ${model.you.asked} · answered ${model.you.answered}`,
			noteTone: isCur ? "warning" : "dim",
		});
	}
	const s1Stages: readonly (DecisionStage | undefined)[] = ["understand", "plan", "observe"];
	const rootOwned = model.decider.rootOwned;
	const s1cur = !rootOwned && s1Stages.includes(currentStage) && !evaluating;
	const lastEvaluation = formatLastEvaluation(model);
	levels.push({
		kind: "box",
		node: {
			text: "SYSTEM ONE",
			tone: s1cur ? "accent" : rootOwned ? "dim" : undefined,
			bold: s1cur,
			current: s1cur || Boolean(evaluating),
			stage: !rootOwned && currentStage && s1Stages.includes(currentStage) ? currentStage : undefined,
		},
		sub: evaluating
			? `◆ ${evaluating.label}  ${formatCompactDuration(now - evaluating.startedAt)}`
			: lastEvaluation
				? `◇ ${lastEvaluation}${model.decider.evaluations > 1 ? ` (${model.decider.evaluations})` : ""}`
				: rootOwned
					? `${model.decider.doing} · root decides`
					: model.decider.doing,
		subTone: evaluating ? SYSTEM_ONE_TONE : lastEvaluation ? "muted" : rootOwned ? "dim" : "muted",
		boxTone: s1cur || evaluating ? SYSTEM_ONE_TONE : "muted",
	});
	if (model.stages.length) {
		levels.push({
			kind: "tree",
			title: `${model.loop > 1 ? "↺ " : ""}loop ${model.loop}`,
			items: model.stages.map((stage) => ({
				text: stageLabel(stage.stage, model),
				glyph: stage.current ? "●" : "✓",
				glyphTone: stage.current ? "accent" : "success",
				tone: stage.current ? undefined : "muted",
				stage: stage.stage,
				current: stage.current,
				...(stage.current && stage.stage !== "done" ? { clock: `  ${formatCompactDuration(stage.passMs)}` } : {}),
			})),
		});
	}
	const executors: DiagramNode[] = model.participants.map((participant) => {
		const sub = participantSubText(participant, model);
		const subagentActive = model.participants.some(
			(p) => (p.kind === "specialist" || p.kind === "worker") && p.running,
		);
		return {
			text: participantText(participant),
			tone:
				participant.kind === "root"
					? participant.running || subagentActive
						? "accent"
						: participant.acted
							? undefined
							: "dim"
					: participant.running
						? participant.kind === "capability"
							? SYSTEM_ONE_TONE
							: "accent"
						: participant.acted
							? undefined
							: "dim",
			bold: participant.kind === "root" || participant.running,
			current: participant.running,
			stage: participant.kind === "root" ? "build" : participant.kind === "capability" ? undefined : "dispatch",
			...(sub ? { sub: sub.text, subTone: sub.tone } : {}),
		};
	});
	// Brain on its own level; delegated subagents, capabilities and tools branch down beneath it.
	levels.push({ kind: "level", nodes: executors.slice(0, 1) });
	if (executors.length > 1) levels.push({ kind: "level", nodes: executors.slice(1) });
	const evidenceNodes: DiagramNode[] = [];
	if (model.evidence.actions > 0 || model.evidence.fileEffects > 0 || model.evidence.failures > 0) {
		evidenceNodes.push({
			text: `EVIDENCE ${model.evidence.actions} actions · ${model.evidence.fileEffects} effects`,
			tone: model.evidence.failures ? "warning" : undefined,
		});
	}
	if (model.checks.length) {
		const ok = model.checks.filter((check) => check.status === "satisfied").length;
		const failing = model.checks.some((check) => check.status === "failed");
		const isCur = currentStage === "verify" && !evaluating;
		evidenceNodes.push({
			text: `CHECKS ${ok}/${model.checks.length}${failing ? " ✗" : ""}`,
			tone: isCur ? "accent" : failing ? "error" : ok === model.checks.length ? "success" : undefined,
			bold: isCur,
			stage: "verify",
		});
	}
	if (model.peerFindings.length) {
		evidenceNodes.push({
			text: `PEER FINDINGS ${model.peerFindings.length} active`,
			tone: "warning",
		});
	}
	if (model.unresolvedDoubtCount > 0) {
		evidenceNodes.push({
			text: `DOUBTS ${model.unresolvedDoubtCount}`,
			tone: SYSTEM_ONE_TONE,
		});
	}
	if (evidenceNodes.length > 0) levels.push({ kind: "level", nodes: evidenceNodes });
	if (model.blocked)
		levels.push({ kind: "level", nodes: [{ text: `BLOCKED · ${model.blocked}`, tone: "warning", bold: true }] });
	// A request without an objective has no goal to satisfy: it ends when its turn does.
	if (!model.goal.present) {
		if (shouldShowPlainTurnStatus(model)) {
			const [text, tone] = plainTurnStatus(model);
			levels.push({ kind: "level", nodes: [{ text, tone }] });
		}
		return levels;
	}
	const repairTaken = model.stages.some((row) => row.stage === "repair");
	const branch: DiagramLevel = {
		kind: "branch",
		question: {
			text: "goal satisfied?",
			tone: evaluating ? SYSTEM_ONE_TONE : model.decider.last ? undefined : "dim",
			bold: Boolean(evaluating),
			current: Boolean(evaluating),
		},
		yes: goalYesNode(model),
		...(repairTaken || model.blocked
			? {
					no: {
						text: "repair",
						tone: currentStage === "repair" ? "warning" : "muted",
						bold: currentStage === "repair",
						stage: "repair",
						...(model.loop > 1 ? { loop: "↺ → SYSTEM ONE" } : {}),
					},
				}
			: {}),
	};
	levels.push(branch);
	if (model.next && model.goal.branch !== "delivered") levels.push({ kind: "next", text: `next → ${model.next}` });
	return levels;
}
