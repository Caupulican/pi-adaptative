import { visibleWidth } from "@caupulican/pi-tui";
import type { ThemeColor } from "../../../../presentation/theme-model.ts";

export interface CellStyle {
	readonly tone?: ThemeColor;
	readonly bold?: boolean;
}

export interface CanvasRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export type BoxBorder = "single" | "rounded" | "heavy" | "double" | "none";

export interface BoxOptions {
	readonly border: BoxBorder;
	readonly style?: CellStyle;
	readonly hit?: string;
	readonly title?: string;
	readonly titleStyle?: CellStyle;
}

export interface LineOptions {
	readonly style?: CellStyle;
	readonly arrow?: "none" | "start" | "end" | "both";
	readonly dashed?: boolean;
	readonly hit?: string;
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

const LIGHT = 0;
const HEAVY = 1;
const DOUBLE = 2;

/** Glyph per line mask (up=1, down=2, left=4, right=8), one table per weight class. */
const GLYPHS: readonly (readonly string[])[] = [
	[" ", "│", "│", "│", "─", "┘", "┐", "┤", "─", "└", "┌", "├", "─", "┴", "┬", "┼"],
	[" ", "┃", "┃", "┃", "━", "┛", "┓", "┫", "━", "┗", "┏", "┣", "━", "┻", "┳", "╋"],
	[" ", "║", "║", "║", "═", "╝", "╗", "╣", "═", "╚", "╔", "╠", "═", "╩", "╦", "╬"],
];

/** Rounded light corners; any further direction on the cell falls back to the tee in `GLYPHS`. */
const ROUNDED_CORNERS: Readonly<Record<number, string>> = {
	[UP | LEFT]: "╯",
	[DOWN | LEFT]: "╮",
	[UP | RIGHT]: "╰",
	[DOWN | RIGHT]: "╭",
};

/** Dashed straight runs per weight class; the double class has no dashed form and stays solid. */
const DASHED_HORIZONTAL: readonly (string | undefined)[] = ["┄", "┅", undefined];
const DASHED_VERTICAL: readonly (string | undefined)[] = ["┆", "┇", undefined];

const ARROW_DOWN = "↓";
const ARROW_UP = "↑";
const ARROW_RIGHT = "→";
const ARROW_LEFT = "←";
const ELLIPSIS = "…";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function requireInteger(name: string, value: number): void {
	if (!Number.isInteger(value)) throw new Error(`Canvas ${name} must be an integer, got ${value}`);
}

function requireSize(name: string, value: number): void {
	requireInteger(name, value);
	if (value < 0) throw new Error(`Canvas ${name} must not be negative, got ${value}`);
}

function requireRect(rect: CanvasRect): void {
	requireInteger("rect.x", rect.x);
	requireInteger("rect.y", rect.y);
	requireSize("rect.w", rect.w);
	requireSize("rect.h", rect.h);
}

function isControl(grapheme: string): boolean {
	const code = grapheme.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** Split text into display graphemes with their cell widths; control and zero-width clusters draw nothing. */
function measureGraphemes(text: string): { glyph: string; cells: number }[] {
	const out: { glyph: string; cells: number }[] = [];
	for (const { segment } of graphemeSegmenter.segment(text)) {
		if (isControl(segment)) continue;
		const cells = visibleWidth(segment);
		if (cells > 0) out.push({ glyph: segment, cells });
	}
	return out;
}

function checkGlyph(glyph: string): number {
	const parts = [...graphemeSegmenter.segment(glyph)];
	if (parts.length !== 1) throw new Error(`Canvas glyph must be exactly one grapheme, got ${JSON.stringify(glyph)}`);
	if (isControl(glyph)) throw new Error(`Canvas glyph must not be a control character, got ${JSON.stringify(glyph)}`);
	const cells = visibleWidth(glyph);
	if (cells !== 1 && cells !== 2) {
		throw new Error(`Canvas glyph must be 1 or 2 cells wide, got ${cells} for ${JSON.stringify(glyph)}`);
	}
	return cells;
}

function arrowFor(direction: number): string {
	if (direction === DOWN) return ARROW_DOWN;
	if (direction === UP) return ARROW_UP;
	if (direction === RIGHT) return ARROW_RIGHT;
	return ARROW_LEFT;
}

function deriveGlyph(mask: number, weight: number, rounded: boolean, dashed: boolean): string {
	if (rounded && weight === LIGHT) {
		const corner = ROUNDED_CORNERS[mask];
		if (corner) return corner;
	}
	if (dashed) {
		if ((mask & (UP | DOWN)) === 0) return DASHED_HORIZONTAL[weight] ?? GLYPHS[weight][mask];
		if ((mask & (LEFT | RIGHT)) === 0) return DASHED_VERTICAL[weight] ?? GLYPHS[weight][mask];
	}
	return GLYPHS[weight][mask];
}

/**
 * A grid of terminal cells painted with text and box-drawing glyphs. Lines and box borders write
 * direction masks, and the glyph of every line cell is derived from its accumulated mask, so
 * crossings, joins and tees merge on their own. Writes outside the grid are clipped: the canvas is
 * a viewport. The canvas holds no theme and emits no ANSI; `rows` hands styled runs to the caller.
 */
export class CellCanvas {
	readonly width: number;
	readonly height: number;
	private readonly glyphs: string[];
	private readonly tones: (ThemeColor | undefined)[];
	private readonly bolds: Uint8Array;
	private readonly hits: (string | undefined)[];
	private readonly masks: Uint8Array;
	private readonly weights: Uint8Array;
	private readonly rounded: Uint8Array;
	private readonly dashed: Uint8Array;
	private readonly arrows: string[];
	private readonly heads: Uint8Array;
	private readonly continuations: Uint8Array;

	constructor(width: number, height: number) {
		requireSize("width", width);
		requireSize("height", height);
		const count = width * height;
		this.width = width;
		this.height = height;
		this.glyphs = new Array<string>(count).fill(" ");
		this.tones = new Array<ThemeColor | undefined>(count).fill(undefined);
		this.bolds = new Uint8Array(count);
		this.hits = new Array<string | undefined>(count).fill(undefined);
		this.masks = new Uint8Array(count);
		this.weights = new Uint8Array(count);
		this.rounded = new Uint8Array(count);
		this.dashed = new Uint8Array(count);
		this.arrows = new Array<string>(count).fill("");
		this.heads = new Uint8Array(count);
		this.continuations = new Uint8Array(count);
	}

	put(x: number, y: number, glyph: string, style?: CellStyle, hit?: string): void {
		requireInteger("x", x);
		requireInteger("y", y);
		this.writeGlyph(x, y, glyph, checkGlyph(glyph), style, hit);
	}

	/**
	 * One decorative glyph in exactly one canvas cell, whatever its measured width: a glyph the terminal may
	 * draw two columns wide (East Asian ambiguous) must not shift the cells after it. The caller that owns the
	 * cell-to-column scaling pads the cell when it emits rows (see decision-graph-scene.ts).
	 */
	putCell(x: number, y: number, glyph: string, style?: CellStyle, hit?: string): void {
		requireInteger("x", x);
		requireInteger("y", y);
		checkGlyph(glyph);
		this.writeGlyph(x, y, glyph, 1, style, hit);
	}

	text(
		x: number,
		y: number,
		text: string,
		style?: CellStyle,
		options?: { readonly maxWidth?: number; readonly ellipsis?: boolean; readonly hit?: string },
	): void {
		requireInteger("x", x);
		requireInteger("y", y);
		if (options?.maxWidth !== undefined) requireSize("maxWidth", options.maxWidth);
		this.writeText(
			x,
			y,
			text,
			style,
			options?.maxWidth ?? Math.max(0, this.width - x),
			options?.ellipsis === true,
			options?.hit,
		);
	}

	fill(rect: CanvasRect, glyph: string, style?: CellStyle, hit?: string): void {
		requireRect(rect);
		const cells = checkGlyph(glyph);
		const right = rect.x + rect.w;
		for (let y = Math.max(0, rect.y); y < Math.min(this.height, rect.y + rect.h); y++) {
			for (let x = rect.x; x < right; x += cells) {
				// A wide glyph that would straddle the right edge leaves a blank half instead.
				if (cells === 2 && x + 1 >= right) this.writeGlyph(x, y, " ", 1, style, hit);
				else this.writeGlyph(x, y, glyph, cells, style, hit);
			}
		}
	}

	box(rect: CanvasRect, options: BoxOptions): void {
		requireRect(rect);
		const { border } = options;
		if (border !== "none") {
			if (rect.w < 2 || rect.h < 2)
				throw new Error(`Canvas box with a border needs at least 2x2 cells, got ${rect.w}x${rect.h}`);
			this.drawBorder(rect, border, options.style);
			this.drawTitle(rect, options);
		}
		if (options.hit !== undefined) {
			for (let y = Math.max(0, rect.y); y < Math.min(this.height, rect.y + rect.h); y++) {
				for (let x = Math.max(0, rect.x); x < Math.min(this.width, rect.x + rect.w); x++) {
					this.hits[y * this.width + x] = options.hit;
				}
			}
		}
	}

	line(points: readonly Point[], options: LineOptions = {}): void {
		if (points.length < 2) throw new Error(`Canvas line needs at least 2 points, got ${points.length}`);
		for (const point of points) {
			requireInteger("point.x", point.x);
			requireInteger("point.y", point.y);
		}
		const dashed = options.dashed === true;
		for (let i = 1; i < points.length; i++) {
			const from = points[i - 1];
			const to = points[i];
			if (from.x === to.x && from.y === to.y)
				throw new Error(`Canvas line segment ${i} has zero length at ${from.x},${from.y}`);
			if (from.x !== to.x && from.y !== to.y) {
				throw new Error(`Canvas line segment ${i} is not axis-aligned: ${from.x},${from.y} to ${to.x},${to.y}`);
			}
			if (from.y === to.y) {
				const lo = Math.min(from.x, to.x);
				const hi = Math.max(from.x, to.x);
				for (let x = Math.max(lo, 0); x <= Math.min(hi, this.width - 1); x++) {
					this.mergeLine(
						x,
						from.y,
						(x > lo ? LEFT : 0) | (x < hi ? RIGHT : 0),
						LIGHT,
						false,
						dashed,
						options.style,
						options.hit,
					);
				}
			} else {
				const lo = Math.min(from.y, to.y);
				const hi = Math.max(from.y, to.y);
				for (let y = Math.max(lo, 0); y <= Math.min(hi, this.height - 1); y++) {
					this.mergeLine(
						from.x,
						y,
						(y > lo ? UP : 0) | (y < hi ? DOWN : 0),
						LIGHT,
						false,
						dashed,
						options.style,
						options.hit,
					);
				}
			}
		}
		const arrow = options.arrow ?? "none";
		if (arrow === "end" || arrow === "both") {
			const from = points[points.length - 2];
			const to = points[points.length - 1];
			this.placeArrow(to, from.y === to.y ? (to.x > from.x ? RIGHT : LEFT) : to.y > from.y ? DOWN : UP);
		}
		if (arrow === "start" || arrow === "both") {
			// The head at the start points back out of the line, opposite to the first segment.
			const from = points[0];
			const to = points[1];
			this.placeArrow(from, from.y === to.y ? (to.x > from.x ? LEFT : RIGHT) : to.y > from.y ? UP : DOWN);
		}
	}

	hitAt(x: number, y: number): string | undefined {
		requireInteger("x", x);
		requireInteger("y", y);
		if (!this.inRange(x, y)) return undefined;
		return this.hits[y * this.width + x];
	}

	/** One string per row, exactly `width` cells: runs of equal style go through `paint`, wide-glyph continuations are skipped. */
	rows(paint: (text: string, style: CellStyle) => string): string[] {
		const out: string[] = [];
		for (let y = 0; y < this.height; y++) {
			let row = "";
			let run = "";
			let runTone: ThemeColor | undefined;
			let runBold = false;
			for (let x = 0; x < this.width; x++) {
				const i = y * this.width + x;
				if (this.continuations[i]) continue;
				const tone = this.tones[i];
				const bold = this.bolds[i] === 1;
				if (run !== "" && (tone !== runTone || bold !== runBold)) {
					row += paint(run, { tone: runTone, bold: runBold });
					run = "";
				}
				runTone = tone;
				runBold = bold;
				run += this.glyphs[i];
			}
			if (run !== "") row += paint(run, { tone: runTone, bold: runBold });
			out.push(row);
		}
		return out;
	}

	private inRange(x: number, y: number): boolean {
		return x >= 0 && x < this.width && y >= 0 && y < this.height;
	}

	/** Break the wide pair that cell `i` belongs to, blanking the half that is not being overwritten. */
	private releasePair(i: number): void {
		if (this.continuations[i]) {
			this.continuations[i] = 0;
			this.heads[i - 1] = 0;
			this.glyphs[i - 1] = " ";
		}
		if (this.heads[i]) {
			this.heads[i] = 0;
			this.continuations[i + 1] = 0;
			this.glyphs[i + 1] = " ";
		}
	}

	/** Make cell `i` a plain glyph cell: no line state, style replaced. */
	private resetCell(i: number, glyph: string, style: CellStyle | undefined, hit: string | undefined): void {
		this.releasePair(i);
		this.glyphs[i] = glyph;
		this.masks[i] = 0;
		this.weights[i] = LIGHT;
		this.rounded[i] = 0;
		this.dashed[i] = 0;
		this.arrows[i] = "";
		this.setStyle(i, style);
		if (hit !== undefined) this.hits[i] = hit;
	}

	private setStyle(i: number, style: CellStyle | undefined): void {
		this.tones[i] = style?.tone;
		this.bolds[i] = style?.bold ? 1 : 0;
	}

	private writeGlyph(
		x: number,
		y: number,
		glyph: string,
		cells: number,
		style: CellStyle | undefined,
		hit: string | undefined,
	): void {
		if (cells === 1) {
			if (this.inRange(x, y)) this.resetCell(y * this.width + x, glyph, style, hit);
			return;
		}
		// A wide glyph needs both halves on the canvas; a half that falls off leaves a blank behind.
		if (!this.inRange(x, y) || !this.inRange(x + 1, y)) {
			if (this.inRange(x, y)) this.resetCell(y * this.width + x, " ", style, hit);
			else if (this.inRange(x + 1, y)) this.resetCell(y * this.width + x + 1, " ", style, hit);
			return;
		}
		const i = y * this.width + x;
		this.resetCell(i, glyph, style, hit);
		this.resetCell(i + 1, "", style, hit);
		this.heads[i] = 1;
		this.continuations[i + 1] = 1;
	}

	/** Write graphemes left to right inside `limit` cells, returning the cells used (clipping by the canvas is not counted). */
	private writeText(
		x: number,
		y: number,
		text: string,
		style: CellStyle | undefined,
		limit: number,
		ellipsis: boolean,
		hit: string | undefined,
	): number {
		const graphemes = measureGraphemes(text);
		let total = 0;
		for (const g of graphemes) total += g.cells;
		let budget = limit;
		let tail = "";
		if (total > limit && ellipsis) {
			const ellipsisCells = visibleWidth(ELLIPSIS);
			if (ellipsisCells <= limit) {
				tail = ELLIPSIS;
				budget = limit - ellipsisCells;
			}
		}
		let cx = x;
		let used = 0;
		for (const g of graphemes) {
			if (used + g.cells > budget) break;
			this.writeGlyph(cx, y, g.glyph, g.cells, style, hit);
			cx += g.cells;
			used += g.cells;
		}
		if (tail !== "") {
			this.writeGlyph(cx, y, tail, visibleWidth(tail), style, hit);
			used += visibleWidth(tail);
		}
		return used;
	}

	/** OR `mask` into one line cell and re-derive its glyph; weights mix by taking the heavier. */
	private mergeLine(
		x: number,
		y: number,
		mask: number,
		weight: number,
		rounded: boolean,
		dashed: boolean,
		style: CellStyle | undefined,
		hit: string | undefined,
	): void {
		if (!this.inRange(x, y)) return;
		const i = y * this.width + x;
		const fresh = this.masks[i] === 0;
		if (fresh) {
			this.resetCell(i, " ", style, hit);
			this.dashed[i] = dashed ? 1 : 0;
			this.rounded[i] = rounded ? 1 : 0;
			this.weights[i] = weight;
		} else {
			this.releasePair(i);
			if (style !== undefined) this.setStyle(i, style);
			if (hit !== undefined) this.hits[i] = hit;
			this.dashed[i] = this.dashed[i] === 1 && dashed ? 1 : 0;
			this.rounded[i] = this.rounded[i] === 1 || rounded ? 1 : 0;
			this.weights[i] = Math.max(this.weights[i], weight);
		}
		this.masks[i] |= mask;
		this.glyphs[i] =
			this.arrows[i] || deriveGlyph(this.masks[i], this.weights[i], this.rounded[i] === 1, this.dashed[i] === 1);
	}

	private placeArrow(at: Point, direction: number): void {
		if (!this.inRange(at.x, at.y)) return;
		const i = at.y * this.width + at.x;
		this.arrows[i] = arrowFor(direction);
		this.glyphs[i] = this.arrows[i];
	}

	private drawBorder(rect: CanvasRect, border: Exclude<BoxBorder, "none">, style: CellStyle | undefined): void {
		const weight = border === "heavy" ? HEAVY : border === "double" ? DOUBLE : LIGHT;
		const round = border === "rounded";
		const left = rect.x;
		const right = rect.x + rect.w - 1;
		const top = rect.y;
		const bottom = rect.y + rect.h - 1;
		for (let x = Math.max(left, 0); x <= Math.min(right, this.width - 1); x++) {
			const corner = x === left || x === right;
			const across = x === left ? RIGHT : x === right ? LEFT : LEFT | RIGHT;
			this.mergeLine(x, top, across | (corner ? DOWN : 0), weight, round && corner, false, style, undefined);
			this.mergeLine(x, bottom, across | (corner ? UP : 0), weight, round && corner, false, style, undefined);
		}
		for (let y = Math.max(top + 1, 0); y <= Math.min(bottom - 1, this.height - 1); y++) {
			this.mergeLine(left, y, UP | DOWN, weight, false, false, style, undefined);
			this.mergeLine(right, y, UP | DOWN, weight, false, false, style, undefined);
		}
	}

	/** Title in the top border, two cells in with a blank either side; skipped when no cell is left for it. */
	private drawTitle(rect: CanvasRect, options: BoxOptions): void {
		const room = rect.w - 4;
		if (options.title === undefined || options.title === "" || room < 1) return;
		const style = options.titleStyle ?? options.style;
		const used = this.writeText(rect.x + 2, rect.y, options.title, style, room, true, undefined);
		this.writeGlyph(rect.x + 1, rect.y, " ", 1, style, undefined);
		this.writeGlyph(rect.x + 2 + used, rect.y, " ", 1, style, undefined);
	}
}
