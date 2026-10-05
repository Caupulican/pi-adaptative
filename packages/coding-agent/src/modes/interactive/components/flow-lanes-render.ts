/**
 * The Lanes view: the flow trace drawn as a sequence diagram, one lifeline per actor (you, System
 * One, root, each worker by name), time flowing down, one row per action. An action that hands
 * something to another actor is an arrow between their lifelines; a running action is an in-flight
 * (dashed) message carrying a moving glyph, a settled one is solid and carries its outcome.
 *
 * The geometry lives in `sequence-layout.ts`, where the cell grid, glyph set and constraint code are
 * written down; where the carrier is lives in `flow-carrier.ts`. This module is the content and the
 * paint: one exhaustive table says how each kind of action looks, and one rule folds a run of finished
 * same-kind actions of one actor into a counted row with the average time. A new kind of action fails
 * the table's type until it is given a look; nothing else in the view knows any specific behavior.
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { FlowEvent, FlowKind } from "../../../core/operator-projection/flow-trace.ts";
import { type ThemeColor, theme } from "../../../presentation/theme-model.ts";
import type { DecisionGraphRows } from "./decision-graph-render.ts";
import { arrowCarrierCell, CARRIER_GLYPH, carrierActiveUntil } from "./flow-carrier.ts";
import {
	buildSequenceLayout,
	type FlowRow,
	foldFlow,
	type SequenceCell,
	type SequenceKindLook,
	type SequenceLayout,
	type SequenceRow,
} from "./sequence-layout.ts";

/** How each kind of action looks. Exhaustive: a new kind does not compile until it has a look. */
const KIND_LOOK: Readonly<Record<FlowKind, SequenceKindLook>> = {
	prompt: { glyph: "›", folds: false, plural: "prompts" },
	turn: { glyph: "●", folds: false, plural: "turns" },
	reply: { glyph: "·", folds: false, plural: "replies" },
	tool: { glyph: "▸", folds: true, plural: "tools" },
	background: { glyph: "▸", folds: false, plural: "background tools" },
	route: { glyph: "◇", folds: true, plural: "routes" },
	judgment: { glyph: "◆", folds: true, plural: "judgments" },
	delegate: { glyph: "›", folds: false, plural: "delegations" },
	worker: { glyph: "●", folds: false, plural: "workers" },
	report: { glyph: "‹", folds: false, plural: "reports" },
	question: { glyph: "?", folds: false, plural: "questions" },
	answer: { glyph: "›", folds: false, plural: "answers" },
	notice: { glyph: "·", folds: true, plural: "notices" },
	compaction: { glyph: "↺", folds: false, plural: "compactions" },
	retry: { glyph: "↺", folds: true, plural: "retries" },
	wait: { glyph: "○", folds: false, plural: "waits" },
};

/** The trace as rows, oldest first: consecutive finished same-kind actions of one actor fold. */
export function flowRows(flow: readonly FlowEvent[]): FlowRow[] {
	return foldFlow(flow, KIND_LOOK).rows;
}

interface PaintCell {
	readonly glyph: string;
	readonly tone: ThemeColor | undefined;
	readonly bold: boolean;
}

/** Cells to one string: runs of the same tone share one color escape; every glyph fills a whole cell. */
function paintCells(cells: readonly PaintCell[], cellWidth: number): string {
	let out = "";
	let run = "";
	let runTone: ThemeColor | undefined;
	let runBold = false;
	const flush = (): void => {
		if (!run) return;
		let text = runTone ? theme.fg(runTone, run) : run;
		if (runBold) text = theme.bold(text);
		out += text;
		run = "";
	};
	for (const cell of cells) {
		if (cell.tone !== runTone || cell.bold !== runBold) {
			flush();
			runTone = cell.tone;
			runBold = cell.bold;
		}
		run += cell.glyph + " ".repeat(Math.max(0, cellWidth - visibleWidth(cell.glyph)));
	}
	flush();
	return out;
}

/** The row's cells with the carrier on its arrow, when one is needed at `nowMs`. */
function rowCells(row: SequenceRow, nowMs: number, motion: boolean): readonly PaintCell[] {
	const cells: PaintCell[] = row.cells.map((cell: SequenceCell) => ({ ...cell, bold: false }));
	if (!motion || !row.arrow) return cells;
	const at = arrowCarrierCell(row.arrow, { startedAt: row.last.startedAt, endedAt: row.last.endedAt }, nowMs);
	if (at !== undefined)
		cells[at] = { glyph: CARRIER_GLYPH, tone: row.cells[row.arrow.from]?.tone ?? "accent", bold: true };
	return cells;
}

/** Header titles at their lifeline columns, then the legend for any title that did not fit. */
function headerRows(layout: SequenceLayout, width: number): string[] {
	let line = "";
	let pos = 0;
	for (const part of layout.header) {
		if (part.col > pos) {
			line += " ".repeat(part.col - pos);
			pos = part.col;
		}
		const shown = truncateToWidth(part.text, Math.max(0, width - pos), "…");
		const tinted = theme.fg(part.tone, shown);
		line += part.bold ? theme.bold(tinted) : tinted;
		pos += visibleWidth(shown);
	}
	return [line, ...layout.legend.map((entry) => theme.fg("dim", truncateToWidth(entry, width, "…")))];
}

export function renderFlowLanes(
	flow: readonly FlowEvent[],
	width: number,
	nowMs: number,
	motion = true,
): DecisionGraphRows {
	const layout = buildSequenceLayout(flow, { width, nowMs, look: KIND_LOOK });
	const rows = headerRows(layout, width);
	if (layout.rows.length === 0) {
		rows.push(theme.fg("dim", truncateToWidth("no activity yet · the lanes fill as work happens", width, "…")));
		return { rows, stageAt: rows.map(() => undefined), currentRow: 0, focusKey: "flow:empty" };
	}
	let motionUntil: number | undefined;
	for (const row of layout.rows) {
		const field = paintCells(rowCells(row, nowMs, motion), layout.cellWidth);
		const label = row.label ? theme.fg(row.labelTone, row.label) : "";
		rows.push(
			truncateToWidth(
				`${field}${" ".repeat(layout.labelCol - layout.fieldCells * layout.cellWidth)}${label}`,
				width,
				"",
			),
		);
		if (motion && row.arrow) {
			const until = carrierActiveUntil({ startedAt: row.last.startedAt, endedAt: row.last.endedAt }, nowMs);
			if (until !== undefined && (motionUntil === undefined || until > motionUntil)) motionUntil = until;
		}
	}
	const last = layout.rows.at(-1)!;
	return {
		rows,
		stageAt: rows.map(() => undefined),
		currentRow: rows.length - 1,
		focusKey: `flow:${last.first.id}:${last.count}`,
		...(motionUntil !== undefined ? { motionUntil } : {}),
	};
}
