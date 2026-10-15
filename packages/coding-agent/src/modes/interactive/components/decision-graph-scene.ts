/**
 * The Decision graph's diagram, built the handwired way: the model becomes one declarative tree of boxes,
 * one pure layout function places every box in integer terminal cells, and the placed boxes are painted
 * onto a cell canvas with box-drawing glyphs. Edges are routed from the placed rectangles, clicks are
 * answered from the canvas's hit map (per node, not per row), and the only motion is a pair of springs
 * that carry a focus bar from the node the loop left to the node it entered. Every frame is a pure
 * function of (model, width, the spring table the pane owns).
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import type { ThemeColor } from "../../../presentation/theme-model.ts";
import type { DecisionGraphModel } from "./decision-graph-model.ts";
import {
	composeDecisionDiagram,
	type DecisionGraphRows,
	type DiagramLevel,
	type DiagramNode,
	graphFocusKey,
} from "./decision-graph-render.ts";
import { type BoxBorder, CellCanvas, type CellStyle } from "./graph/canvas.ts";
import { cellWidthOf, paintCells, style } from "./graph/cells.ts";
import { type BoxSpec, layout, type NodeSpec } from "./graph/layout.ts";
import type { SpringTable } from "./graph/spring.ts";

/** Rows between two levels: one for the bus, one for the arrowhead. */
const EDGE_GAP = 2;
/** Cells between sibling cards. */
const SIBLING_GAP = 2;
/** The graph never lays out narrower than this; the workbench folds the pane well before. */
const MIN_WIDTH = 16;
/** While a spring is unsettled the animator is asked for frames this long ahead; each frame renews it. */
const MOTION_LEASE_MS = 120;
const FOCUS_BAR = "┃";
/** Every glyph the canvas draws that a CJK-codepage terminal may show two columns wide. */
const AMBIGUOUS_GLYPHS = [
	"─",
	"│",
	"┌",
	"┐",
	"└",
	"┘",
	"├",
	"┤",
	"┬",
	"┴",
	"┼",
	"╭",
	"╮",
	"╰",
	"╯",
	"┃",
	"┄",
	"┆",
	"↓",
	"↑",
	"→",
	"←",
	"…",
];

interface Segment {
	readonly text: string;
	readonly style: CellStyle;
}

interface CardLine {
	readonly segments: readonly Segment[];
	readonly stage?: DecisionStage;
	readonly current?: boolean;
}

interface Card {
	readonly id: string;
	readonly lines: readonly CardLine[];
	readonly border: BoxBorder;
	readonly style: CellStyle;
	readonly title?: string;
	readonly align: "center" | "start";
	readonly stage?: DecisionStage;
	readonly current: boolean;
}

interface SceneLevel {
	readonly cards: readonly Card[];
	readonly dashed?: boolean;
	/** One label per card, drawn beside the arrow that enters it. */
	readonly labels?: readonly string[];
}

function nodeLabel(node: DiagramNode): string {
	return `${node.text}${node.clock ?? ""}`;
}

/** A stage is clickable only where the model has detail for it. */
function stageIf(model: DecisionGraphModel, stage: DecisionStage | undefined): { readonly stage?: DecisionStage } {
	return stage !== undefined && model.stages.some((row) => row.stage === stage) ? { stage } : {};
}

function nodeCard(
	model: DecisionGraphModel,
	id: string,
	node: DiagramNode,
	border: BoxBorder,
	borderTone?: ThemeColor,
): Card {
	const lines: CardLine[] = [{ segments: [{ text: nodeLabel(node), style: style(node.tone, node.bold) }] }];
	if (node.sub) lines.push({ segments: [{ text: node.sub, style: style(node.subTone ?? "muted") }] });
	return {
		id,
		lines,
		border,
		style: style(borderTone ?? (node.current ? "accent" : "dim")),
		align: "center",
		...stageIf(model, node.stage),
		current: Boolean(node.current),
	};
}

/** The model's levels as scene levels: every card carries its lines, border, stage and whether it is current. */
function sceneLevels(model: DecisionGraphModel, levels: readonly DiagramLevel[]): SceneLevel[] {
	const out: SceneLevel[] = [];
	const currentStage = model.current?.stage;
	levels.forEach((level, index) => {
		const id = `n${index}`;
		switch (level.kind) {
			case "you": {
				const card = nodeCard(model, id, level.node, "rounded");
				out.push({
					cards: [
						{
							...card,
							lines: [...card.lines, { segments: [{ text: level.note, style: style(level.noteTone) }] }],
						},
					],
				});
				break;
			}
			case "box":
				out.push({
					cards: [
						nodeCard(
							model,
							id,
							{ ...level.node, sub: level.sub, subTone: level.subTone },
							"rounded",
							level.boxTone,
						),
					],
				});
				break;
			case "tree":
				out.push({
					cards: [
						{
							id,
							title: level.title,
							border: "rounded",
							style: style("dim"),
							align: "start",
							current: level.items.some((item) => item.current),
							lines: level.items.map((item) => ({
								segments: [
									{ text: item.glyph, style: style(item.glyphTone) },
									{ text: ` ${item.text}${item.clock ?? ""}`, style: style(item.tone) },
								],
								...stageIf(model, item.stage),
								current: Boolean(item.current),
							})),
						},
					],
				});
				break;
			case "level":
				if (level.nodes.length > 0) {
					out.push({ cards: level.nodes.map((node, at) => nodeCard(model, `${id}c${at}`, node, "rounded")) });
				}
				break;
			case "branch": {
				out.push({ cards: [nodeCard(model, `${id}q`, level.question, "rounded")] });
				const yes = nodeCard(model, `${id}y`, { ...level.yes, current: currentStage === "deliver" }, "rounded");
				const no = level.no
					? nodeCard(
							model,
							`${id}n`,
							{
								...level.no,
								current: currentStage === "repair",
								...(level.no.loop ? { sub: level.no.loop, subTone: "muted" as ThemeColor } : {}),
							},
							"rounded",
						)
					: undefined;
				out.push({ cards: no ? [yes, no] : [yes], labels: no ? ["yes", "no"] : ["yes"] });
				break;
			}
			case "next":
				out.push({
					dashed: true,
					cards: [
						{
							id,
							border: "none",
							style: style(),
							align: "center",
							current: false,
							lines: [{ segments: [{ text: level.text, style: style("dim") }] }],
						},
					],
				});
				break;
		}
	});
	return out;
}

function lineWidth(line: CardLine): number {
	return line.segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
}

/** Cells a card needs to show its longest line and its title without cutting either. */
function cardMinWidth(card: Card): number {
	const widest = Math.max(0, ...card.lines.map(lineWidth), card.title ? visibleWidth(card.title) + 2 : 0);
	return widest + (card.border === "none" ? 2 : 4);
}

function cardSpec(card: Card, alone: boolean, avail: number): BoxSpec {
	const framed = card.border !== "none";
	const min = Math.min(cardMinWidth(card), avail);
	return {
		kind: "box",
		id: card.id,
		axis: "column",
		width: alone ? { kind: "fit", min, max: avail } : { kind: "grow", min },
		height: { kind: "fit" },
		padding: { left: framed ? 2 : 1, right: framed ? 2 : 1, top: framed ? 1 : 0, bottom: framed ? 1 : 0 },
		children: card.lines.map(
			(line, at): NodeSpec => ({
				kind: "text",
				id: `${card.id}#${at}`,
				text: line.segments.map((segment) => segment.text).join(""),
				// Only a single-segment line can wrap: a styled run cannot be re-cut across lines.
				wrap: line.segments.length === 1,
				width: { kind: "grow" },
			}),
		),
	};
}

export interface DecisionSceneOptions {
	/** False under reduced motion: springs jump to their target instead of travelling. */
	readonly motion: boolean;
}

/** Siblings that do not fit side by side stack as a level each, so labels stay readable and no edge breaks. */
function fitLevels(levels: readonly SceneLevel[], avail: number): SceneLevel[] {
	return levels.flatMap((level): SceneLevel[] => {
		const cards = level.cards;
		const need = cards.reduce((sum, card) => sum + cardMinWidth(card), 0) + SIBLING_GAP * (cards.length - 1);
		if (cards.length < 2 || need <= avail) return [level];
		return cards.map((card, at) => ({
			cards: [card],
			...(level.dashed ? { dashed: true } : {}),
			...(level.labels?.[at] !== undefined ? { labels: [level.labels[at]] } : {}),
		}));
	});
}

export function renderDecisionScene(
	model: DecisionGraphModel,
	width: number,
	springs: SpringTable,
	options: DecisionSceneOptions,
): DecisionGraphRows {
	// One canvas cell is as many columns as the widest glyph it draws (two under PI_AMBIGUOUS_WIDTH=wide), so a
	// row never outgrows the pane; layout and edges work in cells, painting pads each cell to its columns.
	const cellWidth = cellWidthOf(AMBIGUOUS_GLYPHS);
	const W = Math.max(MIN_WIDTH, Math.floor(width / cellWidth));
	const avail = W - 2;
	const levels = fitLevels(sceneLevels(model, composeDecisionDiagram(model)), avail);

	const tree: BoxSpec = {
		kind: "box",
		id: "root",
		axis: "column",
		width: { kind: "fixed", cells: W },
		height: { kind: "fit" },
		padding: { left: 1, right: 1, top: 0, bottom: 0 },
		gap: EDGE_GAP,
		alignCross: "center",
		children: levels.map(
			(level, at): BoxSpec => ({
				kind: "box",
				id: `L${at}`,
				axis: "row",
				width: { kind: "grow" },
				height: { kind: "fit" },
				gap: SIBLING_GAP,
				alignMain: "center",
				alignCross: "start",
				children: level.cards.map((card) => cardSpec(card, level.cards.length === 1, avail)),
			}),
		),
	};
	const placed = layout(tree, W);
	const canvas = new CellCanvas(W, Math.max(1, placed.height));
	const rectOf = (id: string) => {
		const rect = placed.rects.get(id);
		if (!rect) throw new Error(`decision graph scene: no rect for ${id}`);
		return rect;
	};

	// Edges first: borders drawn after merge with them into tees through the canvas's line masks.
	for (let at = 1; at < levels.length; at++) {
		const above = levels[at - 1]!;
		const below = levels[at]!;
		const sources = above.cards.map((card) => rectOf(card.id));
		const targets = below.cards.map((card) => rectOf(card.id));
		const sourceBottom = Math.max(...sources.map((rect) => rect.y + rect.h - 1));
		const busY = sourceBottom + 1;
		const centerOf = (rect: { readonly x: number; readonly w: number }) => rect.x + Math.floor((rect.w - 1) / 2);
		const xs = [...sources, ...targets].map(centerOf);
		const dashed = below.dashed === true;
		below.cards.forEach((card, to) => {
			const target = targets[to]!;
			const edge: CellStyle = style(card.current ? "accent" : dashed ? "dim" : "muted");
			const x = centerOf(target);
			canvas.line(
				[
					{ x, y: busY },
					{ x, y: target.y - 1 },
				],
				{ style: edge, arrow: "end", dashed },
			);
			const label = below.labels?.[to];
			if (label) canvas.text(x + 2, target.y - 1, label, style("dim"));
		});
		for (const source of sources) {
			canvas.line(
				[
					{ x: centerOf(source), y: source.y + source.h - 1 },
					{ x: centerOf(source), y: busY },
				],
				{ style: style("muted"), dashed },
			);
		}
		if (Math.min(...xs) < Math.max(...xs)) {
			canvas.line(
				[
					{ x: Math.min(...xs), y: busY },
					{ x: Math.max(...xs), y: busY },
				],
				{ style: style("muted"), dashed },
			);
		}
	}

	// Cards: the frame (with the stage hit over the whole card), then each line (its own stage hit wins).
	let focus: { readonly top: number; readonly bottom: number } | undefined;
	for (const level of levels) {
		for (const card of level.cards) {
			const rect = rectOf(card.id);
			const hit = card.stage ? `stage:${card.stage}` : undefined;
			canvas.box(rect, {
				border: card.border,
				style: card.style,
				...(hit ? { hit } : {}),
				...(card.title ? { title: card.title, titleStyle: style("muted") } : {}),
			});
			if (card.current && !card.lines.some((line) => line.current))
				focus = { top: rect.y, bottom: rect.y + rect.h - 1 };
			card.lines.forEach((line, at) => {
				const textRect = rectOf(`${card.id}#${at}`);
				const wrapped = placed.lines.get(`${card.id}#${at}`) ?? [];
				const lineHit = line.stage ? `stage:${line.stage}` : hit;
				if (line.current) focus = { top: textRect.y, bottom: textRect.y };
				if (line.segments.length === 1) {
					const segment = line.segments[0]!;
					wrapped.forEach((text, row) => {
						const shown = truncateToWidth(text, textRect.w, "…");
						const x =
							card.align === "center"
								? textRect.x + Math.max(0, Math.floor((textRect.w - visibleWidth(shown)) / 2))
								: textRect.x;
						canvas.text(x, textRect.y + row, shown, segment.style, {
							maxWidth: textRect.w,
							...(lineHit ? { hit: lineHit } : {}),
						});
					});
					return;
				}
				let x =
					card.align === "center"
						? textRect.x + Math.max(0, Math.floor((textRect.w - lineWidth(line)) / 2))
						: textRect.x;
				for (const segment of line.segments) {
					const room = textRect.x + textRect.w - x;
					if (room <= 0) break;
					canvas.text(x, textRect.y, segment.text, segment.style, {
						maxWidth: room,
						ellipsis: true,
						...(lineHit ? { hit: lineHit } : {}),
					});
					x += Math.min(visibleWidth(segment.text), room);
				}
			});
		}
	}

	// The focus bar: two springs (top and bottom) so it stretches and slides between nodes instead of jumping.
	if (focus) {
		springs.set("focusTop", focus.top, { jump: !options.motion });
		springs.set("focusBottom", focus.bottom, { jump: !options.motion });
	} else {
		springs.delete("focusTop");
		springs.delete("focusBottom");
	}
	springs.step(model.nowMs);
	const top = springs.value("focusTop");
	const bottom = springs.value("focusBottom");
	if (top !== undefined && bottom !== undefined) {
		for (let row = Math.round(Math.min(top, bottom)); row <= Math.round(Math.max(top, bottom)); row++) {
			canvas.putCell(0, row, FOCUS_BAR, style("accent", true));
		}
	}

	const rows = canvas.rows(paintCells(cellWidth));
	const stageOf = (hit: string | undefined): DecisionStage | undefined =>
		hit?.startsWith("stage:") ? (hit.slice("stage:".length) as DecisionStage) : undefined;
	const stageAtCell = (column: number, row: number): DecisionStage | undefined =>
		stageOf(canvas.hitAt(Math.floor(column / cellWidth), row));
	const stageAt = rows.map((_, row) => {
		for (let column = 0; column < W; column++) {
			const stage = stageOf(canvas.hitAt(column, row));
			if (stage) return stage;
		}
		return undefined;
	});
	return {
		rows,
		stageAt,
		stageAtCell,
		currentRow: focus ? focus.top : 0,
		focusKey: graphFocusKey(model),
		...(springs.settled() ? {} : { motionUntil: model.nowMs + MOTION_LEASE_MS }),
	};
}
