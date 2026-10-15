/**
 * The Lanes view: the flow trace drawn as a sequence diagram, one lifeline per actor (you, System
 * One, root, each worker by name), time flowing down, one row per action. An action that hands
 * something to another actor is an arrow between their lifelines; a running action is an in-flight
 * (dashed) message carrying a moving glyph, a settled one is solid and carries its outcome.
 *
 * The geometry lives in `sequence-layout.ts` (lifelines, pitch, folds, bar runs, labels), where the
 * glyph rules and constraint code are written down; where the carrier is lives in `flow-carrier.ts`.
 * This module is the content and the paint: one exhaustive table says how each kind of action looks,
 * and the geometry is drawn on a cell canvas the way the Diagram view is: lifelines are vertical lines,
 * a hand-over is a horizontal line with an arrowhead, so a crossing or a join becomes `┼` `├` `┤` on its
 * own, and activation bars and kind glyphs are set on their cells afterwards. A canvas cell is as many
 * columns as the widest glyph it draws (two under PI_AMBIGUOUS_WIDTH=wide). The label column is a second
 * canvas in plain columns, so text is never stretched to the cell width. The lifeline header comes first
 * and is pinned; the legend of tagged lifelines follows and scrolls with the rows.
 *
 * Kind glyphs, one meaning each (the field glyphs are listed in `sequence-layout.ts`):
 *
 *   owner   prompt »   answer ↵
 *   root    turn ■   reply «   tool ▸   background ▹   route ◇   delegate ›   question ?
 *           notice ▲   compaction ≡   retry ↻   wait ○
 *   System One   judgment ◆
 *   worker  worker □   report ‹
 *   carrier ● (no kind uses it)
 *
 * A new kind of action fails the table's type until it is given a look; nothing else in the view knows
 * any specific behavior.
 */

import { truncateToWidth } from "@caupulican/pi-tui";
import type { FlowEvent, FlowKind } from "../../../core/operator-projection/flow-trace.ts";
import { theme } from "../../../presentation/theme-model.ts";
import type { DecisionGraphRows } from "./decision-graph-render.ts";
import { arrowCarrierCell, CARRIER_GLYPH, carrierActiveUntil } from "./flow-carrier.ts";
import { CellCanvas } from "./graph/canvas.ts";
import { paintCells, style } from "./graph/cells.ts";
import {
	BAR_GLYPH,
	buildSequenceLayout,
	CLAIMED_GLYPH,
	type SequenceKindLook,
	type SequenceLayout,
} from "./sequence-layout.ts";

/** How each kind of action looks. Exhaustive: a new kind does not compile until it has a look. */
const KIND_LOOK: Readonly<Record<FlowKind, SequenceKindLook>> = {
	prompt: { glyph: "»", folds: false, plural: "prompts" },
	turn: { glyph: "■", folds: true, plural: "turns" },
	reply: { glyph: "«", folds: false, plural: "replies" },
	tool: { glyph: "▸", folds: true, plural: "tools" },
	background: { glyph: "▹", folds: false, plural: "background tools" },
	route: { glyph: "◇", folds: true, plural: "routes" },
	judgment: { glyph: "◆", folds: true, plural: "judgments" },
	delegate: { glyph: "›", folds: false, plural: "delegations" },
	worker: { glyph: "□", folds: false, plural: "workers" },
	report: { glyph: "‹", folds: false, plural: "reports" },
	question: { glyph: "?", folds: false, plural: "questions" },
	answer: { glyph: "↵", folds: false, plural: "answers" },
	notice: { glyph: "▲", folds: true, plural: "notices" },
	compaction: { glyph: "≡", folds: true, plural: "compactions" },
	retry: { glyph: "↻", folds: true, plural: "retries" },
	wait: { glyph: "○", folds: true, plural: "waits" },
};

/** The titles at their lifeline columns (the pinned header), then the legend for any title that did not fit. */
function headRows(layout: SequenceLayout, width: number): string[] {
	const hasHeader = layout.header.length > 0;
	const canvas = new CellCanvas(width, (hasHeader ? 1 : 0) + layout.legend.length);
	if (hasHeader) {
		for (const part of layout.header) {
			if (part.col >= width) break;
			canvas.text(part.col, 0, part.text, style(part.tone, part.bold), {
				maxWidth: width - part.col,
				ellipsis: true,
			});
		}
	}
	layout.legend.forEach((entry, at) => {
		canvas.text(0, (hasHeader ? 1 : 0) + at, entry, style("dim"), { maxWidth: width, ellipsis: true });
	});
	return canvas.rows(paintCells(1));
}

/**
 * The lifeline field, one canvas row per layout row: lifelines first, then the hand-over lines (which
 * merge into junctions where they meet a lifeline), then bars and kind glyphs on cells no arrow runs
 * through, then the carrier. Returns when the carrier next needs a frame, if it does.
 */
function fieldRows(layout: SequenceLayout, nowMs: number, motion: boolean): { rows: string[]; motionUntil?: number } {
	const height = layout.rows.length;
	const canvas = new CellCanvas(layout.fieldCells, height);
	const lifelineCells = new Set(layout.lifelines.map((lifeline) => lifeline.cell));
	// Past both ends of the rows, so the first and last row of a lifeline are crossings, not corners.
	for (const cell of lifelineCells) {
		canvas.line(
			[
				{ x: cell, y: -1 },
				{ x: cell, y: height },
			],
			{ style: style("dim") },
		);
	}
	layout.rows.forEach((row, y) => {
		const arrow = row.arrow;
		if (!arrow) return;
		const direction = arrow.to > arrow.from ? 1 : -1;
		const head = arrow.to - direction;
		const edge = style(arrow.tone);
		const dashed = arrow.state === "flight";
		canvas.line(
			[
				{ x: arrow.from, y },
				{ x: head, y },
			],
			{ style: edge, arrow: "end", dashed },
		);
		canvas.line(
			[
				{ x: head, y },
				{ x: arrow.to, y },
			],
			{ style: edge, dashed },
		);
		if (arrow.state !== "claimed") return;
		for (let cell = arrow.from + direction; cell !== head; cell += direction) {
			if (!lifelineCells.has(cell)) canvas.putCell(cell, y, CLAIMED_GLYPH, edge);
		}
	});
	for (const bar of layout.bars) {
		for (let y = bar.fromRow; y <= bar.toRow; y++) {
			const arrow = layout.rows[y]?.arrow;
			if (arrow && bar.cell >= Math.min(arrow.from, arrow.to) && bar.cell <= Math.max(arrow.from, arrow.to))
				continue;
			canvas.putCell(bar.cell, y, BAR_GLYPH[bar.kind], style(bar.tone));
		}
	}
	let motionUntil: number | undefined;
	layout.rows.forEach((row, y) => {
		if (row.mark) canvas.putCell(row.mark.cell, y, row.mark.glyph, style(row.mark.tone));
		if (!motion || !row.arrow) return;
		const timing = { startedAt: row.last.startedAt, endedAt: row.last.endedAt };
		const at = arrowCarrierCell(row.arrow, timing, nowMs);
		if (at !== undefined) canvas.putCell(at, y, CARRIER_GLYPH, style(row.arrow.tone, true));
		const until = carrierActiveUntil(timing, nowMs);
		if (until !== undefined && (motionUntil === undefined || until > motionUntil)) motionUntil = until;
	});
	return { rows: canvas.rows(paintCells(layout.cellWidth)), ...(motionUntil !== undefined ? { motionUntil } : {}) };
}

/** The label of every row, in plain columns, clipped to the label column. */
function labelRows(layout: SequenceLayout): string[] {
	const canvas = new CellCanvas(layout.labelWidth, layout.rows.length);
	layout.rows.forEach((row, y) => {
		canvas.text(0, y, row.label, style(row.labelTone), { maxWidth: layout.labelWidth, ellipsis: true });
	});
	return canvas.rows(paintCells(1));
}

export function renderFlowLanes(
	flow: readonly FlowEvent[],
	width: number,
	nowMs: number,
	motion = true,
): DecisionGraphRows {
	const layout = buildSequenceLayout(flow, { width, nowMs, look: KIND_LOOK });
	const head = headRows(layout, width);
	const pinnedRows = layout.header.length > 0 ? 1 : 0;
	const pinned = pinnedRows > 0 ? { pinnedRows } : {};
	if (layout.rows.length === 0) {
		const rows = [
			...head,
			theme.fg("dim", truncateToWidth("no activity yet · the lanes fill as work happens", width, "…")),
		];
		return { rows, stageAt: rows.map(() => undefined), currentRow: 0, focusKey: "flow:empty", ...pinned };
	}
	const labels = labelRows(layout);
	let body: string[];
	let motionUntil: number | undefined;
	if (layout.fieldCells === 0) body = labels;
	else {
		const field = fieldRows(layout, nowMs, motion);
		const gap = " ".repeat(layout.labelCol - layout.fieldCells * layout.cellWidth);
		body = field.rows.map((row, y) => `${row}${gap}${labels[y]}`);
		motionUntil = field.motionUntil;
	}
	const rows = [...head, ...body];
	const last = layout.rows.at(-1)!;
	return {
		rows,
		stageAt: rows.map(() => undefined),
		currentRow: rows.length - 1,
		focusKey: `flow:${last.first.id}:${last.count}`,
		...pinned,
		...(motionUntil !== undefined ? { motionUntil } : {}),
	};
}
