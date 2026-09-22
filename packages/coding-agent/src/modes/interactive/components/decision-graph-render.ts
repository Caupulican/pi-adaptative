/**
 * The Decision graph's two views, rendered from the model into plain rows the pane fits and tones.
 * List: the stages this task went through with accumulated timers, the next action, routing,
 * participants, evidence, checks and the goal verdict. Diagram: the task's own workflow drawn on the
 * cell grid — levels derived from the task, siblings spaced across the width, connectors composed
 * from the sibling counts, the clock on the current node only. Pure: no clock, no state.
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import { evaluationResultText } from "../../../core/system-one/semantic-evaluation-ledger.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { type DecisionGraphModel, type DecisionParticipant, MAX_DOUBTS } from "./decision-graph-model.ts";

export interface DecisionGraphRows {
	readonly rows: readonly string[];
	/** `stageAt[i]` is the stage a click on row `i` expands, or undefined for a non-stage row. */
	readonly stageAt: readonly (DecisionStage | undefined)[];
	/** The row a following pane keeps in view: the current stage (List) or the current node (Diagram). */
	readonly currentRow: number;
	/** Semantic focus identity; row number alone is not stable across a reflow. */
	readonly focusKey: string;
}

/** The decider's tone: the label tone marks System One everywhere in the Workbench. */
const SYSTEM_ONE_TONE: ThemeColor = "customMessageLabel";
const TITLE_TONE: ThemeColor = "customMessageLabel";

import { formatCompactDuration } from "../../../core/util/format-duration.ts";

/** The graph's clock text; one formatter for the pane, the previews and the Team rows. */
export const formatGraphDuration = formatCompactDuration;

const STAGE_LABEL: Readonly<Record<DecisionStage, string>> = {
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

const PLAN_GLYPH: Readonly<Record<string, [string, ThemeColor]>> = {
	done: ["✓", "success"],
	active: ["›", "accent"],
	pending: ["·", "dim"],
	blocked: ["!", "warning"],
	failed: ["✗", "error"],
	cancelled: ["×", "dim"],
};

/** Left text and right-aligned meta on one row of `width` cells; the right yields first. */
function metaLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (right && leftWidth + 2 + rightWidth <= width)
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	return truncateToWidth(left, width, "…");
}

function participantText(participant: DecisionParticipant): string {
	const head = participant.kind === "root" ? "root" : `${participant.kind} ${participant.label}`;
	return participant.model ? `${head} · ${participant.model}` : head;
}

/* ============================================================ List view */
export function renderDecisionList(
	model: DecisionGraphModel,
	width: number,
	selected?: DecisionStage,
): DecisionGraphRows {
	const rows: string[] = [];
	const stageAt: (DecisionStage | undefined)[] = [];
	let currentRow = 0;
	const push = (row: string, stage?: DecisionStage, isCurrent = false): void => {
		if (isCurrent) currentRow = rows.length;
		rows.push(truncateToWidth(row, width, "…"));
		stageAt.push(stage);
	};
	const head = (title: string, right: string, tone: ThemeColor = TITLE_TONE): void =>
		push(metaLine(theme.fg(tone, title), right, width));
	const item = (
		glyph: string,
		glyphTone: ThemeColor,
		text: string,
		tone: ThemeColor | undefined,
		right = "",
		stage?: DecisionStage,
		isCurrent = false,
	): void =>
		push(
			metaLine(`  ${theme.fg(glyphTone, glyph)} ${tone ? theme.fg(tone, text) : text}`, right, width),
			stage,
			isCurrent,
		);
	const arrow = (label = ""): void => push(theme.fg("dim", `  ↓${label ? `  ${label}` : ""}`));
	const now = model.nowMs;

	if (model.stageLogEmpty) {
		push(theme.fg("dim", "No task yet · the graph composes when work starts"));
		return { rows, stageAt, currentRow, focusKey: graphFocusKey(model) };
	}

	if (model.you.present) {
		head(
			"YOU",
			model.you.waiting
				? theme.fg(
						"warning",
						`? waiting ${model.you.waitingSinceMs !== undefined ? formatGraphDuration(now - model.you.waitingSinceMs) : ""}`.trimEnd(),
					)
				: theme.fg("dim", `asked ${model.you.asked} · answered ${model.you.answered}`),
			model.you.waiting ? "warning" : TITLE_TONE,
		);
		push(theme.fg("dim", "  ↑  only when needed"));
	}

	const evaluating = model.decider.evaluating;
	head(
		"SYSTEM ONE",
		evaluating
			? theme.fg(SYSTEM_ONE_TONE, `◆ evaluating  ${formatGraphDuration(now - evaluating.startedAt)}`)
			: theme.fg("dim", model.decider.doing),
	);
	if (evaluating) push(theme.fg(SYSTEM_ONE_TONE, `  ◆ ${evaluating.label}`));
	else if (model.decider.last)
		push(
			theme.fg(
				"dim",
				`  last verdict: ${model.decider.last.label} → ${model.decider.last.verdict ?? model.decider.last.outcome}`,
			),
		);
	for (const stage of model.stages) {
		const shown = formatGraphDuration(stage.current ? stage.passMs : stage.totalMs);
		const right = [
			stage.current ? shown : theme.fg("muted", shown),
			stage.passes > 1 ? theme.fg("dim", ` ×${stage.passes}`) : "",
			stage.current ? theme.fg("accent", "  ← now") : "",
		].join("");
		item(
			stage.current ? "●" : "✓",
			"success",
			stage.current ? `${STAGE_LABEL[stage.stage]} · loop ${stage.loop}` : STAGE_LABEL[stage.stage],
			stage.current ? undefined : "muted",
			right,
			stage.stage,
			stage.current,
		);
		if (selected === stage.stage) {
			if (stage.note) push(theme.fg("muted", `      ${stage.note}`), stage.stage);
			if (stage.reasonCode) push(theme.fg("dim", `      reason: ${stage.reasonCode}`), stage.stage);
			for (const event of stage.events) {
				const tone: ThemeColor =
					event.severity === "failure" ? "error" : event.severity === "warning" ? "warning" : "muted";
				push(theme.fg(tone, `      · ${event.title}`), stage.stage);
			}
			if (stage.current && evaluating) push(theme.fg(SYSTEM_ONE_TONE, `      ◆ ${evaluating.label}`), stage.stage);
		}
	}
	if (model.next && model.goal.branch !== "delivered") item("·", "dim", `next → ${model.next}`, "dim");
	arrow();

	head(
		`ROUTER · H-MoE${model.participants.some((p) => p.kind === "capability") ? " · CAPABILITY" : ""}`,
		model.routing.length ? "" : theme.fg("dim", "no routed choice"),
	);
	for (const choice of model.routing) push(theme.fg(choice.live ? SYSTEM_ONE_TONE : "dim", `  · ${choice.text}`));
	for (const capability of model.participants.filter((p) => p.kind === "capability"))
		push(
			theme.fg(
				capability.running ? SYSTEM_ONE_TONE : "muted",
				`  ◇ capability ${capability.label} · ${capability.task ?? "active"}`,
			),
		);
	arrow();

	head("EXECUTORS", "");
	for (const participant of model.participants.filter((p) => p.kind !== "capability")) {
		const right = participant.running
			? `${theme.fg("muted", participant.task ?? "")}${participant.startedAt !== undefined ? theme.fg("muted", ` ${formatGraphDuration(now - participant.startedAt)}`) : ""}`
			: theme.fg(
					"dim",
					participant.kind === "root"
						? model.you.waiting
							? "waiting for you"
							: evaluating
								? "waiting for System One"
								: ""
						: (participant.task ?? ""),
				);
		item(
			participant.running ? "●" : "○",
			participant.running ? "success" : "dim",
			participantText(participant),
			participant.running ? (participant.kind === "root" ? undefined : SYSTEM_ONE_TONE) : "muted",
			right,
		);
	}
	arrow();

	head(
		"EVIDENCE",
		theme.fg(
			model.evidence.failures ? "warning" : "muted",
			model.evidence.actions
				? `${model.evidence.actions} actions · ${model.evidence.fileEffects} file effects${model.evidence.failures ? ` · ${model.evidence.failures} failure` : ""}`
				: "none yet",
		),
	);
	if (model.checks.length) {
		const ok = model.checks.filter((check) => check.status === "satisfied").length;
		head("CHECKS", theme.fg(ok === model.checks.length ? "success" : "muted", `${ok}/${model.checks.length}`));
		for (const check of model.checks) {
			const [glyph, tone]: [string, ThemeColor] =
				check.status === "satisfied" ? ["✓", "success"] : check.status === "failed" ? ["✗", "error"] : ["·", "dim"];
			item(glyph, tone, check.text, check.status === "pending" ? "dim" : "muted");
		}
	}
	if (model.doubts.length) {
		// The open doubts, named. A judgment that settled nothing is why the loop is going round
		// again, and it used to be invisible: drawn either as a quiet pass or as nothing at all.
		head("DOUBTS", theme.fg(SYSTEM_ONE_TONE, `${model.doubts.length} open`));
		for (const doubt of model.doubts.slice(0, MAX_DOUBTS)) {
			item("?", SYSTEM_ONE_TONE, doubt.text, "muted", theme.fg("dim", `  ${doubt.label}`));
		}
	}
	arrow("back to System One");
	const openChecks = model.checks.filter((check) => check.status !== "satisfied").length;
	const doubts = model.doubts.length;
	const openNote = [
		openChecks > 0 ? `${openChecks} open` : "",
		doubts > 0 ? `${doubts} ${doubts === 1 ? "doubt" : "doubts"}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	// A doubt keeps the goal open exactly like an unmet check: neither is a failure, and neither is
	// a yes. Only a clean run with nothing open and nothing unsettled reaches "yes".
	const verdict: [string, ThemeColor] =
		model.goal.branch === "delivered" && !openNote
			? ["yes → delivered", "success"]
			: model.goal.branch === "deliver" && !openNote
				? ["yes → deliver", "success"]
				: openNote
					? [`not closed · ${openNote}`, doubts > 0 ? SYSTEM_ONE_TONE : "dim"]
					: model.blocked
						? [`blocked → replan`, "warning"]
						: model.goal.branch === "repair"
							? [`no → repair (loop ${model.loop})`, "warning"]
							: model.goal.branch === "clarify"
								? ["not yet → ask you", "warning"]
								: ["not closed", "dim"];
	head("goal satisfied?", theme.fg(verdict[1], verdict[0]));
	return { rows, stageAt, currentRow, focusKey: graphFocusKey(model) };
}

/* ============================================================ Diagram view */
interface DiagramNode {
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

type DiagramLevel =
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

function graphFocusKey(model: DecisionGraphModel): string {
	const evaluating = model.decider.evaluating?.label ?? "";
	const evalId = model.decider.last?.evaluationId ?? "";
	const evalCount = model.decider.evaluations;
	const open = model.checks.filter((check) => check.status !== "satisfied").length;
	const activeParticipants = model.participants
		.filter((p) => p.running)
		.map((p) => `${p.id}:${p.acted}`)
		.join(",");
	const proof = `${model.evidence.actions}:${model.evidence.fileEffects}:${model.evidence.failures}`;
	return `obj:${model.objectiveId}/stage:${model.current?.stage ?? "idle"}/loop:${model.current?.loop ?? model.loop}/branch:${model.goal.branch}/eval:${evaluating}:${evalId}:${evalCount}/proof:${proof}/parts:${activeParticipants}/open:${open}/next:${model.next ?? ""}`;
}

function goalYesNode(
	model: DecisionGraphModel,
	currentStage: DecisionStage | undefined,
): DiagramNode & { readonly lit: boolean } {
	const pending = model.checks.filter((check) => check.status !== "satisfied").length;
	const doubts = model.doubts.length;
	// An unsettled judgment holds the goal open the same way an unmet check does. Delivering over
	// one would be the drawing claiming a yes that System One never gave.
	const open = pending + doubts;
	const delivered = model.goal.branch === "delivered" && open === 0;
	const delivering = (model.goal.branch === "deliver" || currentStage === "deliver") && open === 0;
	if (delivered || delivering) {
		return {
			text: delivered ? "delivered" : "DELIVER",
			tone: delivered ? "success" : "accent",
			bold: delivering,
			stage: "deliver",
			lit: true,
		};
	}
	const note = [pending > 0 ? `${pending} open` : "", doubts > 0 ? `${doubts} unsure` : ""]
		.filter(Boolean)
		.join(" · ");
	return {
		text: note ? `not closed · ${note}` : "not closed",
		tone: doubts > 0 ? SYSTEM_ONE_TONE : "dim",
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
	if (model.stageLogEmpty) return [{ kind: "level", nodes: [{ text: "no task yet", tone: "dim" }] }];

	if (model.you.present) {
		const isCur = currentStage === "clarify";
		levels.push({
			kind: "you",
			node: {
				text: "YOU",
				tone: isCur ? "warning" : undefined,
				bold: isCur,
				stage: "clarify",
			},
			note: isCur ? "waiting for your answer" : `asked ${model.you.asked} · answered ${model.you.answered}`,
			noteTone: isCur ? "warning" : "dim",
		});
	}
	const s1Stages: readonly (DecisionStage | undefined)[] = ["understand", "plan", "observe"];
	const s1cur = s1Stages.includes(currentStage) && !evaluating;
	levels.push({
		kind: "box",
		node: {
			text: "SYSTEM ONE",
			tone: s1cur ? "accent" : undefined,
			bold: s1cur,
			stage: currentStage && s1Stages.includes(currentStage) ? currentStage : undefined,
		},
		sub: evaluating
			? `◆ ${evaluating.label}  ${formatGraphDuration(now - evaluating.startedAt)}`
			: model.decider.doing,
		subTone: evaluating ? SYSTEM_ONE_TONE : "muted",
		boxTone: s1cur || evaluating ? SYSTEM_ONE_TONE : "muted",
	});
	if (model.stages.length) {
		levels.push({
			kind: "tree",
			title: `${model.loop > 1 ? "↺ " : ""}loop ${model.loop}`,
			items: model.stages.map((stage) => ({
				text: STAGE_LABEL[stage.stage],
				glyph: stage.current ? "●" : "✓",
				glyphTone: stage.current ? "accent" : "success",
				tone: stage.current ? undefined : "muted",
				stage: stage.stage,
				current: stage.current,
				...(stage.current && stage.stage !== "done" ? { clock: `  ${formatGraphDuration(stage.passMs)}` } : {}),
			})),
		});
	}
	if (model.plan.length) {
		const done = model.plan.filter((step) => step.status === "done").length;
		const total = model.plan.filter((step) => step.status !== "cancelled").length;
		levels.push({
			kind: "tree",
			title: `plan ${done}/${total}`,
			items: model.plan.map((step) => {
				const [glyph, glyphTone] = PLAN_GLYPH[step.status] ?? PLAN_GLYPH.pending!;
				return {
					text: step.title,
					glyph,
					glyphTone,
					tone: step.status === "active" ? undefined : step.status === "done" ? "muted" : "dim",
				};
			}),
		});
	}
	const executors: DiagramNode[] = model.participants.map((participant) => {
		return {
			text: participantText(participant),
			tone: participant.running
				? participant.kind === "capability"
					? SYSTEM_ONE_TONE
					: "accent"
				: participant.acted
					? undefined
					: "dim",
			bold: participant.running,
			stage: participant.kind === "root" ? "build" : participant.kind === "capability" ? undefined : "dispatch",
			...(participant.routeText
				? { sub: participant.routeText, subTone: SYSTEM_ONE_TONE as ThemeColor }
				: participant.running && participant.task
					? {
							sub: `${participant.task}${participant.startedAt !== undefined ? ` ${formatGraphDuration(now - participant.startedAt)}` : ""}`,
							subTone: "muted" as ThemeColor,
						}
					: {}),
		};
	});
	levels.push({ kind: "level", nodes: executors });
	const evidenceNodes: DiagramNode[] = [
		{
			text: model.evidence.actions
				? `EVIDENCE ${model.evidence.actions} actions · ${model.evidence.fileEffects} effects`
				: "EVIDENCE none yet",
			tone: model.evidence.actions ? undefined : "dim",
		},
	];
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
	levels.push({ kind: "level", nodes: evidenceNodes });
	if (!evaluating && model.decider.evaluations) {
		const last = model.decider.last;
		levels.push({
			kind: "level",
			nodes: [
				{
					text: `◆ System One · ${model.decider.evaluations} evaluation${model.decider.evaluations > 1 ? "s" : ""}${
						last
							? ` · last ${last.label}${evaluationResultText(last) ? ` → ${evaluationResultText(last)}` : ""}`
							: ""
					}`,
					tone: SYSTEM_ONE_TONE,
				},
			],
		});
	}
	if (model.doubts.length) {
		// Named on the drawing, under the judgment that raised them: the chain of thought the pane
		// can actually keep true is the judgments and what each one left unresolved.
		levels.push({
			kind: "tree",
			title: `unsure · ${model.doubts.length}`,
			items: model.doubts.slice(0, MAX_DOUBTS).map((doubt) => ({
				text: doubt.text,
				glyph: "?",
				glyphTone: SYSTEM_ONE_TONE,
				tone: "muted" as ThemeColor,
			})),
		});
	}
	if (model.blocked)
		levels.push({ kind: "level", nodes: [{ text: `BLOCKED · ${model.blocked}`, tone: "warning", bold: true }] });
	// A request without an objective has no goal to satisfy: it ends when its turn does.
	if (!model.goal.present) {
		const unsure = model.doubts.length ? ` · ${model.doubts.length} unsure` : "";
		levels.push({
			kind: "level",
			nodes: [
				// A plain turn may end without a done phase; the open stage row is what says it is still running.
				model.current && model.current.stage !== "done"
					? { text: `turn running${unsure}`, tone: "accent" }
					: {
							text: `turn finished${unsure}`,
							tone: model.doubts.length ? SYSTEM_ONE_TONE : "success",
						},
			],
		});
		return levels;
	}
	const repairTaken = model.stages.some((row) => row.stage === "repair");
	const branch: DiagramLevel = {
		kind: "branch",
		question: {
			text: `goal satisfied?${evaluating && /^(verify|completion)/.test(evaluating.label) ? `  ◆ ${formatGraphDuration(now - evaluating.startedAt)}` : ""}`,
			tone: evaluating ? SYSTEM_ONE_TONE : model.decider.last ? undefined : "dim",
			bold: Boolean(evaluating),
		},
		yes: goalYesNode(model, currentStage),
		...(repairTaken || model.blocked
			? {
					no: {
						text: "repair",
						tone: currentStage === "repair" ? "warning" : "muted",
						bold: currentStage === "repair",
						stage: "repair",
						...(model.loop > 1 ? { loop: `↺ loop ${model.loop} → SYSTEM ONE` } : {}),
					},
				}
			: {}),
	};
	levels.push(branch);
	if (model.next && model.goal.branch !== "delivered") levels.push({ kind: "next", text: `next → ${model.next}` });
	return levels;
}

interface Part {
	readonly col: number;
	readonly text: string;
	readonly tone?: ThemeColor;
	readonly bold?: boolean;
}

export function renderDecisionDiagram(model: DecisionGraphModel, width: number): DecisionGraphRows {
	const levels = composeDecisionDiagram(model);
	const rows: string[] = [];
	const stageAt: (DecisionStage | undefined)[] = [];
	let currentRow = 0;
	const inner = Math.max(20, width - 2);
	const pad = 1;
	const C = pad + Math.floor(inner / 2);
	const paint = (part: Part): string => {
		let text = part.text;
		if (part.tone) text = theme.fg(part.tone, text);
		if (part.bold) text = theme.bold(text);
		return text;
	};
	const place = (parts: Part[]): string => {
		let out = "";
		let pos = 0;
		for (const part of [...parts].sort((a, b) => a.col - b.col)) {
			if (part.col > pos) {
				out += " ".repeat(part.col - pos);
				pos = part.col;
			}
			const room = Math.max(0, width - pos);
			const text = truncateToWidth(part.text, room, "…");
			out += paint({ ...part, text });
			pos += visibleWidth(text);
		}
		return out;
	};
	const push = (parts: Part[], stage?: DecisionStage, isCurrent = false): void => {
		if (isCurrent) currentRow = rows.length;
		rows.push(place(parts));
		stageAt.push(stage);
	};
	const centered = (text: string, col: number, maxWidth: number, tone?: ThemeColor, bold?: boolean): Part => {
		const shown = truncateToWidth(text, maxWidth, "…");
		return {
			col: Math.max(pad, col - Math.floor(visibleWidth(shown) / 2)),
			text: shown,
			...(tone ? { tone } : {}),
			...(bold ? { bold } : {}),
		};
	};
	/** The node's label shortened to fit beside its clock; the clock is never cut. */
	const nodeText = (node: DiagramNode, maxWidth: number): string => {
		let clockText = node.clock ?? "";
		// The time survives any width; the loop number is the first thing a narrow column gives up.
		if (clockText && visibleWidth(clockText) + 2 > maxWidth) clockText = clockText.replace(/ · loop \d+$/, "");
		const room = Math.max(1, maxWidth - visibleWidth(clockText));
		return `${truncateToWidth(node.text, room, "…")}${clockText}`;
	};
	const centersFor = (count: number): number[] =>
		Array.from({ length: count }, (_, index) => pad + Math.floor(((index + 0.5) * inner) / count));
	const slot = (count: number): number => Math.floor(inner / count) - 2;
	/** Below this slot width a label cannot sit beside its clock, so the level stacks instead. */
	const MIN_SLOT = 10;
	const connector = (fromCount: number, toCount: number): void => {
		const tone: ThemeColor = "muted";
		// Nothing above: the first level has no edge to draw.
		if (fromCount === 0 && toCount <= 1) return;
		if (fromCount <= 1 && toCount <= 1) {
			push([{ col: C, text: "↓", tone }]);
			return;
		}
		if (fromCount > 1) {
			const centers = centersFor(fromCount);
			const left = centers[0]!;
			const right = centers[centers.length - 1]!;
			const cells = Array.from({ length: right - left + 1 }, () => "─");
			for (const center of centers) cells[center - left] = center === left ? "└" : center === right ? "┘" : "┴";
			if (C > left && C < right) cells[C - left] = centers.includes(C) ? "┼" : "┬";
			push([{ col: left, text: cells.join(""), tone }]);
		}
		if (toCount > 1) {
			const centers = centersFor(toCount);
			const left = centers[0]!;
			const right = centers[centers.length - 1]!;
			const cells = Array.from({ length: right - left + 1 }, () => "─");
			for (const center of centers) cells[center - left] = center === left ? "┌" : center === right ? "┐" : "┬";
			if (C > left && C < right) cells[C - left] = centers.includes(C) ? "┼" : "┴";
			push([{ col: left, text: cells.join(""), tone }]);
			push(centers.map((center) => ({ col: center, text: "↓", tone })));
		} else push([{ col: C, text: "↓", tone }]);
	};

	let previousCount = 0;
	for (const level of levels) {
		switch (level.kind) {
			case "you": {
				push(
					[centered(nodeText(level.node, inner), C, inner, level.node.tone, level.node.bold)],
					level.node.stage,
					level.node.current,
				);
				push([{ col: C, text: "↑", tone: level.node.current ? "warning" : "muted" }]);
				push([centered(level.note, C, inner, level.noteTone)]);
				push([{ col: C, text: "│", tone: "muted" }]);
				previousCount = 1;
				break;
			}
			case "box": {
				const text = nodeText(level.node, inner - 4);
				const boxWidth = Math.max(
					visibleWidth(text) + 4,
					visibleWidth(truncateToWidth(level.sub, inner - 4, "…")) + 4,
				);
				const left = Math.max(pad, C - Math.floor(boxWidth / 2));
				const edge = (glyph: string): Part => ({ col: left, text: glyph, tone: level.boxTone });
				push([{ col: left, text: `┌${"─".repeat(boxWidth - 2)}┐`, tone: level.boxTone }]);
				push(
					[
						edge("│"),
						centered(text, left + Math.floor(boxWidth / 2), boxWidth - 2, level.node.tone, level.node.bold),
						{ col: left + boxWidth - 1, text: "│", tone: level.boxTone },
					],
					level.node.stage,
					level.node.current,
				);
				push([
					edge("│"),
					centered(
						level.sub,
						left + Math.floor(boxWidth / 2),
						boxWidth - 2,
						level.subTone,
						level.subTone === SYSTEM_ONE_TONE,
					),
					{ col: left + boxWidth - 1, text: "│", tone: level.boxTone },
				]);
				push([{ col: left, text: `└${"─".repeat(boxWidth - 2)}┘`, tone: level.boxTone }]);
				previousCount = 1;
				break;
			}
			case "tree": {
				push([{ col: C, text: "│", tone: "muted" }]);
				const leftCol = Math.max(pad, C - Math.min(12, Math.floor(inner / 4)));
				push([
					{ col: leftCol, text: truncateToWidth(level.title, Math.max(1, C - leftCol - 1), "…"), tone: "muted" },
					{ col: C, text: "│", tone: "muted" },
				]);
				level.items.forEach((item, index) => {
					const last = index === level.items.length - 1;
					const clockText = item.clock ?? "";
					const room = Math.max(1, pad + inner - (C + 5));
					const label = `${truncateToWidth(item.text, Math.max(1, room - visibleWidth(clockText)), "…")}${clockText}`;
					push(
						[
							{ col: C, text: last ? "└─ " : "├─ ", tone: "muted" },
							{ col: C + 3, text: item.glyph, tone: item.glyphTone },
							{
								col: C + 5,
								text: label,
								...(item.tone ? { tone: item.tone } : {}),
							},
						],
						item.stage,
						Boolean(item.current),
					);
				});
				previousCount = 1;
				break;
			}
			case "level": {
				const count = level.nodes.length;
				const slotWidth = slot(count);
				if (count > 1 && slotWidth < MIN_SLOT) {
					// Too narrow for siblings side by side: the level reflows into a stack on the spine,
					// one node per row, so labels stay readable and no edge is broken.
					connector(previousCount, 1);
					const textCol = C + 3;
					const room = Math.max(1, pad + inner - textCol);
					// The row the pane follows is the node carrying the clock, else the first current one.
					const clockIndex = level.nodes.findIndex((node) => node.clock);
					const currentIndex = clockIndex >= 0 ? clockIndex : level.nodes.findIndex((node) => node.current);
					level.nodes.forEach((node, index) => {
						const last = index === level.nodes.length - 1;
						push(
							[
								{ col: C, text: last ? "└─ " : "├─ ", tone: "muted" },
								{
									col: textCol,
									text: nodeText(node, room),
									...(node.tone ? { tone: node.tone } : {}),
									...(node.bold ? { bold: node.bold } : {}),
								},
							],
							node.stage,
							index === currentIndex,
						);
						if (node.sub)
							push([
								...(last ? [] : [{ col: C, text: "│", tone: "muted" as ThemeColor }]),
								{
									col: textCol + 2,
									text: truncateToWidth(node.sub, Math.max(1, room - 2), "…"),
									tone: node.subTone ?? "muted",
								},
							]);
					});
					previousCount = 1;
					break;
				}
				connector(previousCount, count);
				const centers = centersFor(count);
				push(
					level.nodes.map((node, index) =>
						centered(nodeText(node, slotWidth), centers[index]!, slotWidth, node.tone, node.bold),
					),
					level.nodes.find((node) => node.current)?.stage,
					level.nodes.some((node) => node.current),
				);
				if (level.nodes.some((node) => node.sub))
					push(
						level.nodes.flatMap((node, index) =>
							node.sub ? [centered(node.sub, centers[index]!, slotWidth, node.subTone ?? "muted")] : [],
						),
					);
				previousCount = count;
				break;
			}
			case "branch": {
				connector(previousCount, 1);
				push(
					[centered(nodeText(level.question, inner), C, inner, level.question.tone, level.question.bold)],
					"verify",
					level.question.current,
				);
				if (level.no === undefined) {
					push([{ col: C, text: "↓", tone: level.yes.lit ? "muted" : "dim" }]);
					push(
						[centered(nodeText(level.yes, inner), C, inner, level.yes.tone, level.yes.bold)],
						level.yes.stage,
						false,
					);
					previousCount = 1;
					break;
				}
				const hasNo = true;
				const leftEnd = (text: string, tone?: ThemeColor, bold?: boolean): Part => ({
					col: Math.max(pad, C - 4 - visibleWidth(text)),
					text,
					...(tone ? { tone } : {}),
					...(bold ? { bold } : {}),
				});
				const rightStart = (text: string, tone?: ThemeColor, bold?: boolean): Part => ({
					col: C + 4,
					text: truncateToWidth(text, Math.max(1, pad + inner - (C + 4)), "…"),
					...(tone ? { tone } : {}),
					...(bold ? { bold } : {}),
				});
				push([
					{ col: C - 6, text: "/", tone: level.yes.lit ? "muted" : "dim" },
					...(hasNo ? [{ col: C + 6, text: "\\", tone: "muted" as ThemeColor }] : []),
				]);
				push([
					leftEnd("yes", level.yes.lit ? "muted" : "dim"),
					...(hasNo ? [rightStart("no", level.no?.current ? "warning" : "muted")] : []),
				]);
				push([leftEnd("↓", level.yes.lit ? "muted" : "dim"), ...(hasNo ? [rightStart("↓", "muted")] : [])]);
				push(
					[
						leftEnd(nodeText(level.yes, Math.max(1, C - 4 - pad)), level.yes.tone, level.yes.bold),
						...(hasNo && level.no
							? [
									rightStart(
										nodeText(level.no, Math.max(1, pad + inner - (C + 4))),
										level.no.tone,
										level.no.bold,
									),
								]
							: []),
					],
					level.no?.current ? "repair" : level.yes.current ? "deliver" : undefined,
					Boolean(level.yes.current || level.no?.current),
				);
				if (level.no?.loop) push([rightStart(level.no.loop, level.no.current ? "warning" : "muted")]);
				previousCount = 1;
				break;
			}
			case "next": {
				push([{ col: C, text: "╎", tone: "dim" }]);
				push([centered(level.text, C, inner, "dim")]);
				previousCount = 1;
				break;
			}
		}
	}
	return { rows, stageAt, currentRow, focusKey: graphFocusKey(model) };
}
