/**
 * The Decision graph's List view, built the handwired way: the model becomes rows (sections of heads and
 * items), each row a declarative box with a growing left text and a right-aligned meta, one pure layout
 * function places every box in integer terminal cells, and the placed texts are painted onto a cell canvas.
 * Long notes, reasons, event titles and routes wrap instead of truncating; the meta yields first when the
 * pane is narrow. The canvas draws text only, every glyph measured by `visibleWidth`, so an ambiguous-width
 * glyph occupies the columns the terminal gives it and a row is always exactly the pane's width.
 * Every frame is a pure function of (model, width, selected stage).
 */

import { visibleWidth } from "@caupulican/pi-tui";
import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import { formatCompactDuration } from "../../../core/util/format-duration.ts";
import { type ThemeColor, theme } from "../../../presentation/theme-model.ts";
import { type DecisionGraphModel, type DecisionStageRow, goalClosure } from "./decision-graph-model.ts";
import {
	type DecisionGraphRows,
	formatLastEvaluation,
	graphFocusKey,
	NO_RUN_YET,
	participantSubText,
	participantText,
	plainTurnStatus,
	planItems,
	planProgress,
	SYSTEM_ONE_TONE,
	shouldShowPlainTurnStatus,
	stageLabel,
} from "./decision-graph-render.ts";
import { CellCanvas, type CellStyle } from "./graph/canvas.ts";
import { type BoxSpec, layout, type NodeSpec } from "./graph/layout.ts";

/** Section titles: System One's own tone is reserved for System One. */
const TITLE_TONE: ThemeColor = "muted";
/** Cells of indent for an item under a head, and for the detail under an item. */
const ITEM_INDENT = 2;
const DETAIL_INDENT = 6;
/** Cells between the left text and the meta. */
const META_GAP = 2;
/** The left text never wraps narrower than this (or than itself, when shorter) while the meta can still yield. */
const LEFT_MIN = 12;
const MAX_LISTED = 4;

interface Run {
	readonly text: string;
	readonly tone?: ThemeColor | undefined;
}

interface ListRow {
	readonly indent: number;
	/** A one-cell mark before the text; a wrapped text hangs under the text, not under the mark. */
	readonly glyph?: Run | undefined;
	readonly left: Run;
	/** Right-aligned; wraps and yields first when the row is too narrow for both. */
	readonly meta?: Run | undefined;
	/** The stage a click on this row expands. */
	readonly stage?: DecisionStage | undefined;
	readonly current?: boolean | undefined;
}

/** Free text from the model on one logical line: runs of whitespace (newlines, tabs) become one space. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function style(run: Run): CellStyle {
	return run.tone ? { tone: run.tone } : {};
}

/** A closed stage's accumulated total with its passes; the current stage's clock is this visit, not the total. */
function stageMeta(stage: DecisionStageRow): Run {
	const passes = stage.passes > 1 ? ` ×${stage.passes}` : "";
	// `done` has no visit clock to tick.
	if (!stage.current || stage.stage === "done") {
		return { text: `${formatCompactDuration(stage.totalMs)}${passes}`, tone: "muted" };
	}
	const visited = stage.passes > 1 ? ` · total ${formatCompactDuration(stage.totalMs)}${passes}` : "";
	return { text: `now ${formatCompactDuration(stage.passMs)}${visited}` };
}

/** The goal's verdict. The closure is the model's: a check, a peer finding or a doubt each keep the goal open. */
function goalVerdict(model: DecisionGraphModel): Run {
	const closure = goalClosure(model);
	if (closure.delivered) return { text: "yes → delivered", tone: "success" };
	if (closure.delivering) return { text: "yes → deliver", tone: "success" };
	const openChecks = model.checks.filter((check) => check.status !== "satisfied").length;
	const peerFindings = model.peerFindings.length;
	const doubts = model.unresolvedDoubtCount;
	if (closure.open > 0) {
		const note = [
			openChecks > 0 ? `${openChecks} check${openChecks === 1 ? "" : "s"}` : "",
			peerFindings > 0 ? `${peerFindings} peer` : "",
			doubts > 0 ? `${doubts} doubt${doubts === 1 ? "" : "s"}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return { text: `not closed · ${note}`, tone: doubts > 0 ? SYSTEM_ONE_TONE : "dim" };
	}
	if (model.blocked) return { text: "blocked → replan", tone: "warning" };
	if (model.goal.branch === "repair") return { text: `no → repair (loop ${model.loop})`, tone: "warning" };
	if (model.goal.branch === "clarify") return { text: "not yet → ask you", tone: "warning" };
	return { text: "not closed", tone: "dim" };
}

/** The model as rows, top to bottom. */
function listRows(model: DecisionGraphModel, selected: DecisionStage | undefined): ListRow[] {
	const rows: ListRow[] = [];
	const head = (title: string, meta?: Run, tone: ThemeColor = TITLE_TONE): void => {
		rows.push({ indent: 0, left: { text: title, tone }, meta });
	};
	const line = (indent: number, text: string, tone: ThemeColor | undefined, stage?: DecisionStage): void => {
		rows.push({ indent, left: { text: flat(text), tone }, stage });
	};
	const item = (
		indent: number,
		glyph: string,
		glyphTone: ThemeColor,
		text: string,
		tone: ThemeColor | undefined,
		options: {
			readonly meta?: Run | undefined;
			readonly stage?: DecisionStage | undefined;
			readonly current?: boolean | undefined;
		} = {},
	): void => {
		rows.push({
			indent,
			glyph: { text: glyph, tone: glyphTone },
			left: { text: flat(text), tone },
			meta: options.meta,
			stage: options.stage,
			current: options.current,
		});
	};
	const peerFindings = (): void => {
		if (!model.peerFindings.length) return;
		head("PEER FINDINGS", { text: `${model.peerFindings.length} active`, tone: "warning" }, "warning");
		for (const finding of model.peerFindings.slice(0, MAX_LISTED))
			item(ITEM_INDENT, "!", "warning", `${finding.reason} · ${finding.scope}`, "warning");
		if (model.peerFindings.length > MAX_LISTED)
			line(ITEM_INDENT, `+${model.peerFindings.length - MAX_LISTED} more`, "dim");
	};
	const historyFailure = (): void => {
		if (model.stageHistoryFailure) item(0, "!", "warning", `stage history: ${model.stageHistoryFailure}`, "dim");
	};

	if (model.stageLogEmpty) {
		historyFailure();
		if (!model.plan.length) {
			line(0, "No task yet · the graph composes when work starts", "dim");
			peerFindings();
			return rows;
		}
		head("PLAN", { text: planProgress(model), tone: "muted" });
		for (const step of planItems(model)) item(ITEM_INDENT, step.glyph, step.glyphTone, step.text, step.tone);
		line(0, NO_RUN_YET, "dim");
		peerFindings();
		return rows;
	}

	if (model.you.present) {
		if (model.you.waiting) {
			const since =
				model.you.waitingSinceMs !== undefined
					? ` ${formatCompactDuration(model.nowMs - model.you.waitingSinceMs)}`
					: "";
			head("YOU", { text: `? waiting${since}`, tone: "warning" }, "warning");
			if (model.you.question) item(ITEM_INDENT, "?", "muted", model.you.question, "muted");
		} else {
			head("YOU", { text: `asked ${model.you.asked} · answered ${model.you.answered}`, tone: "dim" });
		}
	}

	const evaluating = model.decider.evaluating;
	const evalPrefix =
		model.decider.evaluations > 0
			? `${model.decider.evaluations} eval${model.decider.evaluations === 1 ? "" : "s"} · `
			: "";
	head(
		"SYSTEM ONE",
		evaluating
			? { text: `◆ judging ${formatCompactDuration(model.nowMs - evaluating.startedAt)}`, tone: SYSTEM_ONE_TONE }
			: { text: `${evalPrefix}${model.decider.doing}`, tone: "dim" },
		SYSTEM_ONE_TONE,
	);
	const lastEvaluation = formatLastEvaluation(model);
	if (evaluating) item(ITEM_INDENT, "◆", SYSTEM_ONE_TONE, evaluating.label, SYSTEM_ONE_TONE);
	else if (lastEvaluation) item(ITEM_INDENT, "◇", "dim", lastEvaluation, "dim");

	historyFailure();
	for (const stage of model.stages) {
		const baseLabel = stageLabel(stage.stage, model);
		item(
			ITEM_INDENT,
			stage.current ? "●" : "✓",
			stage.current ? "accent" : "success",
			stage.current && stage.loop > 1 ? `${baseLabel} · loop ${stage.loop}` : baseLabel,
			stage.current ? undefined : "muted",
			{ meta: stageMeta(stage), stage: stage.stage, current: stage.current },
		);
		if (selected !== stage.stage) continue;
		if (stage.note) line(DETAIL_INDENT, stage.note, "muted", stage.stage);
		if (stage.reasonCode) line(DETAIL_INDENT, `reason: ${stage.reasonCode}`, "dim", stage.stage);
		for (const event of stage.events) {
			const tone: ThemeColor =
				event.severity === "failure" ? "error" : event.severity === "warning" ? "warning" : "muted";
			item(DETAIL_INDENT, "·", tone, event.title, tone, { stage: stage.stage });
		}
	}
	if (model.next && model.goal.branch !== "delivered") item(ITEM_INDENT, "›", "dim", `next → ${model.next}`, "dim");

	const participantItem = (participant: (typeof model.participants)[number]) => {
		const detail = participantSubText(participant, model);
		item(
			ITEM_INDENT,
			participant.running ? "●" : participant.queued ? "◌" : "○",
			participant.running ? "success" : participant.queued ? "warning" : "dim",
			participantText(participant),
			participant.running ? "accent" : "muted",
			{ meta: detail },
		);
	};

	head("BRAIN");
	const brain = model.participants.filter((p) => p.kind === "root");
	const subagents = model.participants.filter((p) => p.kind !== "root" && p.kind !== "capability");
	for (const participant of brain) {
		participantItem(participant);
	}
	if (subagents.length > 0) {
		const activeCount = subagents.filter((p) => p.running || p.queued).length;
		head("SUBAGENTS", {
			text: `${activeCount} active · ${subagents.length} total`,
			tone: activeCount > 0 ? "accent" : "muted",
		});
	}
	for (const participant of subagents) {
		participantItem(participant);
	}
	for (const capability of model.participants.filter((p) => p.kind === "capability")) {
		const tone: ThemeColor = capability.running ? "accent" : "muted";
		item(ITEM_INDENT, "◇", tone, `capability ${capability.label}`, tone, {
			meta: { text: flat(capability.task ?? "active"), tone: "muted" },
		});
	}

	const hasEvidence = model.evidence.actions > 0 || model.evidence.fileEffects > 0 || model.evidence.failures > 0;
	if (hasEvidence || (model.checks.length === 0 && model.peerFindings.length === 0 && !model.goal.present)) {
		head("EVIDENCE", {
			text: hasEvidence
				? `${model.evidence.actions} actions · ${model.evidence.fileEffects} file effects${model.evidence.failures ? ` · ${model.evidence.failures} failure` : ""}`
				: "none yet",
			tone: model.evidence.failures ? "warning" : "muted",
		});
	}
	if (model.checks.length > 0) {
		const ok = model.checks.filter((check) => check.status === "satisfied").length;
		if (ok === model.checks.length) {
			head("CHECKS", { text: `✓ ${ok}/${model.checks.length}`, tone: "success" });
		} else {
			head("CHECKS", { text: `${ok}/${model.checks.length}`, tone: "muted" });
			const openChecks = model.checks.filter((check) => check.status !== "satisfied");
			for (const check of openChecks.slice(0, MAX_LISTED)) {
				const failed = check.status === "failed";
				item(
					ITEM_INDENT,
					failed ? "✗" : "·",
					failed ? "error" : "dim",
					check.text,
					check.status === "pending" ? "dim" : "muted",
				);
			}
			if (openChecks.length > MAX_LISTED) line(ITEM_INDENT, `+${openChecks.length - MAX_LISTED} more`, "dim");
		}
	}
	peerFindings();

	if (!model.goal.present) {
		if (shouldShowPlainTurnStatus(model)) {
			const [status, tone] = plainTurnStatus(model);
			head(status, undefined, tone);
		}
		return rows;
	}
	const verdict = goalVerdict(model);
	head("GOAL", verdict);
	return rows;
}

/** One row as a box: [indent] [glyph] [left, growing and wrapping] [gap] [meta, yielding first]. */
function rowSpec(row: ListRow, at: number): BoxSpec {
	const id = `r${at}`;
	const children: NodeSpec[] = [];
	if (row.glyph) {
		children.push({ kind: "text", id: `${id}g`, text: `${row.glyph.text} ` });
	}
	children.push({
		kind: "text",
		id: `${id}l`,
		text: row.left.text,
		wrap: true,
		width: { kind: "grow", min: Math.min(LEFT_MIN, visibleWidth(row.left.text)) },
	});
	if (row.meta) {
		children.push(
			{ kind: "space", id: `${id}s`, width: { kind: "fixed", cells: META_GAP }, height: { kind: "fit" } },
			{ kind: "text", id: `${id}m`, text: row.meta.text, wrap: true },
		);
	}
	return {
		kind: "box",
		id,
		axis: "row",
		width: { kind: "grow" },
		height: { kind: "fit" },
		padding: { left: row.indent, right: 0, top: 0, bottom: 0 },
		children,
	};
}

export function renderDecisionList(
	model: DecisionGraphModel,
	width: number,
	selected?: DecisionStage,
): DecisionGraphRows {
	const rows = listRows(model, selected);
	const W = Math.max(1, Math.floor(width));
	const placed = layout(
		{
			kind: "box",
			id: "root",
			axis: "column",
			width: { kind: "fixed", cells: W },
			height: { kind: "fit" },
			children: rows.map(rowSpec),
		},
		W,
	);
	const canvas = new CellCanvas(W, Math.max(1, placed.height));
	const rectOf = (id: string) => {
		const rect = placed.rects.get(id);
		if (!rect) throw new Error(`decision graph list: no rect for ${id}`);
		return rect;
	};
	const stageAt: (DecisionStage | undefined)[] = new Array<DecisionStage | undefined>(canvas.height).fill(undefined);
	let currentRow = 0;
	let foundCurrent = false;
	rows.forEach((row, at) => {
		const id = `r${at}`;
		const box = rectOf(id);
		if (row.current && !foundCurrent) {
			currentRow = box.y;
			foundCurrent = true;
		}
		for (let y = box.y; y < box.y + box.h; y++) stageAt[y] = row.stage;
		const cells: readonly [string, Run | undefined][] = [
			[`${id}g`, row.glyph],
			[`${id}l`, row.left],
			[`${id}m`, row.meta],
		];
		for (const [cellId, run] of cells) {
			if (!run) continue;
			const rect = rectOf(cellId);
			(placed.lines.get(cellId) ?? []).forEach((text, k) => {
				canvas.text(rect.x, rect.y + k, text, style(run), { maxWidth: rect.w, ellipsis: true });
			});
		}
	});
	return {
		rows: canvas.rows((text, cellStyle) => {
			let out = text;
			if (cellStyle.tone) out = theme.fg(cellStyle.tone, out);
			if (cellStyle.bold) out = theme.bold(out);
			return out;
		}),
		stageAt,
		currentRow,
		focusKey: graphFocusKey(model),
	};
}
