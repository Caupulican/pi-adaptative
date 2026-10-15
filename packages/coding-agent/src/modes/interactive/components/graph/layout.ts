import { visibleWidth } from "@caupulican/pi-tui";

export type Axis = "row" | "column";
export type Sizing =
	| { readonly kind: "fixed"; readonly cells: number }
	| { readonly kind: "fit"; readonly min?: number; readonly max?: number }
	| { readonly kind: "grow"; readonly min?: number; readonly max?: number };
export interface Insets {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}
export type Align = "start" | "center" | "end";
export interface BoxSpec {
	readonly kind: "box";
	readonly id: string;
	readonly axis: Axis;
	readonly width: Sizing;
	readonly height: Sizing;
	/** A number applies to all four sides. */
	readonly padding?: Insets | number;
	/** Cells between consecutive children on the main axis. */
	readonly gap?: number;
	/** Where children sit on the main axis when there is slack and no grow child. */
	readonly alignMain?: Align;
	/** Cross-axis placement of children that do not fill it. */
	readonly alignCross?: Align;
	readonly children: readonly NodeSpec[];
}
export interface TextSpec {
	readonly kind: "text";
	readonly id: string;
	/** Plain text (no ANSI); may contain "\n". */
	readonly text: string;
	/** Default false: lines are kept whole and clipped by the renderer. */
	readonly wrap?: boolean;
	/** Default fit. */
	readonly width?: Sizing;
	/** Default fit. */
	readonly height?: Sizing;
}
export interface SpaceSpec {
	readonly kind: "space";
	readonly id: string;
	readonly width: Sizing;
	readonly height: Sizing;
}
export type NodeSpec = BoxSpec | TextSpec | SpaceSpec;
/** Absolute cells, origin at the root's top-left. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}
export interface LayoutResult {
	readonly width: number;
	readonly height: number;
	readonly rects: ReadonlyMap<string, Rect>;
	/** Ids in depth-first pre-order. */
	readonly order: readonly string[];
	/** Text node id to its final lines: wrapped when `wrap`, otherwise the unwrapped source lines. */
	readonly lines: ReadonlyMap<string, readonly string[]>;
}

type Dim = "w" | "h";
interface Pair {
	w: number;
	h: number;
}

/** Internal mirror of a spec node; the passes fill `content`, `nat`, `size` and `lines` in place. */
interface Item {
	readonly spec: NodeSpec;
	readonly children: Item[];
	readonly pad: Insets;
	readonly gap: number;
	readonly axis: Axis;
	readonly sizing: Record<Dim, Sizing>;
	/** Cells of the longest unbreakable word (wrapped text only): the width floor when shrinking. */
	readonly longestWord: number;
	lines: string[];
	/** Size the node needs for its own content, before its sizing rule applies. */
	readonly content: Pair;
	/** Size the node asks its parent for. */
	readonly nat: Pair;
	/** Final size. */
	readonly size: Pair;
}

const FIT: Sizing = { kind: "fit" };
const NO_PADDING: Insets = { left: 0, top: 0, right: 0, bottom: 0 };
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function assertCells(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`layout: ${label} must be a non-negative integer, got ${value}`);
	}
}

function checkSizing(sizing: Sizing, id: string): void {
	if (sizing.kind === "fixed") {
		assertCells(sizing.cells, `${id} fixed cells`);
		return;
	}
	if (sizing.min !== undefined) assertCells(sizing.min, `${id} min`);
	if (sizing.max !== undefined) assertCells(sizing.max, `${id} max`);
	if (sizing.min !== undefined && sizing.max !== undefined && sizing.min > sizing.max) {
		throw new Error(`layout: ${id} min ${sizing.min} exceeds max ${sizing.max}`);
	}
}

function clamp(value: number, sizing: Sizing): number {
	if (sizing.kind === "fixed") return sizing.cells;
	return Math.min(sizing.max ?? Infinity, Math.max(sizing.min ?? 0, value));
}

function splitWords(line: string): string[] {
	return line.split(" ").filter((word) => word !== "");
}

/** Greedy word wrap at spaces and "\n"; runs of spaces collapse, over-wide words are split by grapheme. */
function wrapLines(text: string, width: number): string[] {
	const out: string[] = [];
	for (const logical of text.split("\n")) {
		if (width <= 0) {
			out.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const word of splitWords(logical)) {
			const wordWidth = visibleWidth(word);
			if (current !== "" && currentWidth + 1 + wordWidth <= width) {
				current += ` ${word}`;
				currentWidth += 1 + wordWidth;
				continue;
			}
			if (current !== "") {
				out.push(current);
				current = "";
				currentWidth = 0;
			}
			if (wordWidth <= width) {
				current = word;
				currentWidth = wordWidth;
				continue;
			}
			for (const { segment } of graphemeSegmenter.segment(word)) {
				const segmentWidth = visibleWidth(segment);
				// A grapheme wider than the whole width still takes a line of its own; the renderer clips it.
				if (current !== "" && currentWidth + segmentWidth > width) {
					out.push(current);
					current = "";
					currentWidth = 0;
				}
				current += segment;
				currentWidth += segmentWidth;
			}
		}
		out.push(current);
	}
	return out;
}

function build(spec: NodeSpec, seen: Set<string>): Item {
	if (seen.has(spec.id)) throw new Error(`layout: duplicate id ${spec.id}`);
	seen.add(spec.id);
	let sizing: Record<Dim, Sizing>;
	let pad = NO_PADDING;
	let gap = 0;
	let axis: Axis = "row";
	let lines: string[] = [];
	let longestWord = 0;
	let children: Item[] = [];
	if (spec.kind === "box") {
		sizing = { w: spec.width, h: spec.height };
		axis = spec.axis;
		if (typeof spec.padding === "number") {
			pad = { left: spec.padding, top: spec.padding, right: spec.padding, bottom: spec.padding };
		} else if (spec.padding) {
			pad = spec.padding;
		}
		for (const side of [pad.left, pad.top, pad.right, pad.bottom]) assertCells(side, `${spec.id} padding`);
		gap = spec.gap ?? 0;
		assertCells(gap, `${spec.id} gap`);
		children = spec.children.map((child) => build(child, seen));
	} else if (spec.kind === "text") {
		sizing = { w: spec.width ?? FIT, h: spec.height ?? FIT };
		lines = spec.text.split("\n");
		if (spec.wrap) longestWord = Math.max(0, ...lines.flatMap(splitWords).map((word) => visibleWidth(word)));
	} else {
		sizing = { w: spec.width, h: spec.height };
	}
	checkSizing(sizing.w, spec.id);
	checkSizing(sizing.h, spec.id);
	return {
		spec,
		children,
		pad,
		gap,
		axis,
		sizing,
		longestWord,
		lines,
		content: { w: 0, h: 0 },
		nat: { w: 0, h: 0 },
		size: { w: 0, h: 0 },
	};
}

function mainDim(item: Item): Dim {
	return item.axis === "row" ? "w" : "h";
}

function padTotal(item: Item, dim: Dim): number {
	return dim === "w" ? item.pad.left + item.pad.right : item.pad.top + item.pad.bottom;
}

/**
 * Natural sizes, bottom-up (passes 1 and 4): fixed is its cells, fit is its clamped content, and a grow
 * node asks its parent only for its min.
 */
function natural(item: Item, dim: Dim): void {
	for (const child of item.children) natural(child, dim);
	const spec = item.spec;
	let content = 0;
	if (spec.kind === "text") {
		content = dim === "w" ? Math.max(0, ...item.lines.map((line) => visibleWidth(line))) : item.lines.length;
	} else if (spec.kind === "box") {
		const sizes = item.children.map((child) => child.nat[dim]);
		const run =
			mainDim(item) === dim
				? sizes.reduce((sum, size) => sum + size, 0) + item.gap * Math.max(0, sizes.length - 1)
				: Math.max(0, ...sizes);
		content = padTotal(item, dim) + run;
	}
	item.content[dim] = content;
	const sizing = item.sizing[dim];
	item.nat[dim] = sizing.kind === "grow" ? (sizing.min ?? 0) : clamp(content, sizing);
}

/** Smallest size a fit box (to its min) or wrapped text's width (to its longest word) can shrink to. */
function shrinkFloor(item: Item, dim: Dim): number | undefined {
	const sizing = item.sizing[dim];
	if (sizing.kind !== "fit") return undefined;
	if (item.spec.kind === "box") return Math.min(sizing.min ?? 0, item.nat[dim]);
	if (item.spec.kind === "text" && item.spec.wrap && dim === "w") {
		return Math.min(Math.max(sizing.min ?? 0, item.longestWord), item.nat[dim]);
	}
	return undefined;
}

/** Share `total` among the grow children (by index into `sizes`): equal split, frozen at min/max, remainder to the earliest. */
function waterFill(items: readonly Item[], dim: Dim, indices: readonly number[], total: number, sizes: number[]): void {
	let remaining = Math.max(0, total);
	let open = [...indices];
	const bounds = (index: number): { min: number; max: number } => {
		const sizing = items[index].sizing[dim];
		if (sizing.kind === "fixed") throw new Error("layout: fixed node in grow set");
		return { min: sizing.min ?? 0, max: sizing.max ?? Infinity };
	};
	while (open.length > 0) {
		const share = remaining / open.length;
		let violation = 0;
		const violators: number[] = [];
		for (const index of open) {
			const { min, max } = bounds(index);
			const clamped = Math.min(max, Math.max(min, share));
			if (clamped !== share) {
				violators.push(index);
				violation += clamped - share;
			}
		}
		if (violators.length === 0) break;
		// Freeze only the violators on the side the total pressure points to; the rest re-split.
		const frozen = violators.filter((index) => {
			const { min, max } = bounds(index);
			return violation > 0 ? share < min : violation < 0 ? share > max : true;
		});
		for (const index of frozen) {
			const { min, max } = bounds(index);
			sizes[index] = Math.min(max, Math.max(min, share));
			remaining -= sizes[index];
		}
		open = open.filter((index) => !frozen.includes(index));
		remaining = Math.max(0, remaining);
	}
	if (open.length === 0) return;
	const base = Math.floor(remaining / open.length);
	let extra = remaining - base * open.length;
	for (const index of open) {
		sizes[index] = base;
		if (extra > 0 && base < bounds(index).max) {
			sizes[index] += 1;
			extra -= 1;
		}
	}
}

/** Main-axis sizes: fixed/fit keep natural, growers water-fill the leftover, overflow shrinks shrinkable children last-to-first. */
function distributeMain(children: readonly Item[], dim: Dim, room: number): number[] {
	const sizes = children.map((child) => (child.sizing[dim].kind === "grow" ? 0 : child.nat[dim]));
	const growers: number[] = [];
	children.forEach((child, index) => {
		if (child.sizing[dim].kind === "grow") growers.push(index);
	});
	if (growers.length > 0) {
		waterFill(children, dim, growers, room - sizes.reduce((sum, size) => sum + size, 0), sizes);
	}
	let overflow = sizes.reduce((sum, size) => sum + size, 0) - room;
	const floors = children.map((child) => shrinkFloor(child, dim));
	let progressed = true;
	while (overflow > 0 && progressed) {
		progressed = false;
		for (let index = children.length - 1; index >= 0 && overflow > 0; index--) {
			const floor = floors[index];
			if (floor !== undefined && sizes[index] > floor) {
				sizes[index] -= 1;
				overflow -= 1;
				progressed = true;
			}
		}
	}
	return sizes;
}

/** Cross-axis size: grow fills (clamped), others keep natural; shrinkable ones yield to the available space. */
function crossSize(child: Item, dim: Dim, avail: number): number {
	const sizing = child.sizing[dim];
	if (sizing.kind === "grow") return clamp(avail, sizing);
	const floor = shrinkFloor(child, dim);
	if (floor !== undefined && child.nat[dim] > avail) return Math.max(floor, avail);
	return child.nat[dim];
}

/** Final sizes, top-down (passes 2 and 5): hand each box's inner space to its children along `dim`. */
function resolve(item: Item, dim: Dim, size: number): void {
	item.size[dim] = size;
	if (item.children.length === 0) return;
	const avail = Math.max(0, size - padTotal(item, dim));
	if (mainDim(item) === dim) {
		const gaps = item.gap * (item.children.length - 1);
		const sizes = distributeMain(item.children, dim, avail - gaps);
		item.children.forEach((child, index) => {
			resolve(child, dim, sizes[index]);
		});
		return;
	}
	for (const child of item.children) resolve(child, dim, crossSize(child, dim, avail));
}

function offsetFor(align: Align | undefined, slack: number): number {
	if (align === "center") return Math.floor(slack / 2);
	if (align === "end") return slack;
	return 0;
}

/** Positions (pass 6): children run along the main axis from the padding; slack only shifts when nothing grows. */
function place(item: Item, x: number, y: number, rects: Map<string, Rect>, order: string[]): void {
	rects.set(item.spec.id, { x, y, w: item.size.w, h: item.size.h });
	order.push(item.spec.id);
	if (item.spec.kind !== "box") return;
	const alignMain = item.spec.alignMain;
	const alignCross = item.spec.alignCross;
	const row = item.axis === "row";
	const main = mainDim(item);
	const cross: Dim = row ? "h" : "w";
	const availMain = Math.max(0, item.size[main] - padTotal(item, main));
	const availCross = Math.max(0, item.size[cross] - padTotal(item, cross));
	const run =
		item.children.reduce((sum, child) => sum + child.size[main], 0) +
		item.gap * Math.max(0, item.children.length - 1);
	const hasGrow = item.children.some((child) => child.sizing[main].kind === "grow");
	let cursor =
		(row ? x + item.pad.left : y + item.pad.top) + (hasGrow ? 0 : offsetFor(alignMain, Math.max(0, availMain - run)));
	const crossStart = row ? y + item.pad.top : x + item.pad.left;
	for (const child of item.children) {
		const crossAt = crossStart + offsetFor(alignCross, Math.max(0, availCross - child.size[cross]));
		if (row) place(child, cursor, crossAt, rects, order);
		else place(child, crossAt, cursor, rects, order);
		cursor += child.size[main] + item.gap;
	}
}

function collectLines(item: Item, out: Map<string, readonly string[]>): void {
	if (item.spec.kind === "text") out.set(item.spec.id, item.lines);
	for (const child of item.children) collectLines(child, out);
}

/** Pass 3: wrapped text takes its final width; the next height pass sees the wrapped line counts. */
function wrapTexts(item: Item): void {
	if (item.spec.kind === "text" && item.spec.wrap) item.lines = wrapLines(item.spec.text, item.size.w);
	for (const child of item.children) wrapTexts(child);
}

/**
 * Lay out a box tree in integer terminal cells. Passes: natural widths, final widths, wrap, natural
 * heights, final heights, positions. A root grow width resolves to `width`; a root grow height to
 * `height` when given, otherwise to its content.
 */
export function layout(root: NodeSpec, width: number, height?: number): LayoutResult {
	assertCells(width, "width");
	if (height !== undefined) assertCells(height, "height");
	const item = build(root, new Set());

	natural(item, "w");
	const widthRule = item.sizing.w;
	resolve(
		item,
		"w",
		widthRule.kind === "grow"
			? clamp(width, widthRule)
			: widthRule.kind === "fit"
				? Math.min(item.nat.w, width)
				: item.nat.w,
	);
	wrapTexts(item);
	natural(item, "h");
	const heightRule = item.sizing.h;
	let rootHeight = item.nat.h;
	if (heightRule.kind === "grow") rootHeight = clamp(height ?? item.content.h, heightRule);
	resolve(item, "h", rootHeight);

	const rects = new Map<string, Rect>();
	const order: string[] = [];
	place(item, 0, 0, rects, order);
	const lines = new Map<string, readonly string[]>();
	collectLines(item, lines);
	return { width: item.size.w, height: item.size.h, rects, order, lines };
}
