import { visibleWidth } from "@caupulican/pi-tui";
import { type ThemeColor, theme } from "../../../../presentation/theme-model.ts";
import type { CellStyle } from "./canvas.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A cell style from the tone and weight the views speak in. */
export function style(tone?: ThemeColor, bold?: boolean): CellStyle {
	return { ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) };
}

function paintRun(text: string, cell: CellStyle): string {
	const tinted = cell.tone ? theme.fg(cell.tone, text) : text;
	return cell.bold ? theme.bold(tinted) : tinted;
}

/**
 * How many terminal columns one canvas cell is: the widest of the glyphs a view draws (two under
 * `PI_AMBIGUOUS_WIDTH=wide`, where box-drawing and arrows are East Asian ambiguous), so a row never
 * outgrows its pane.
 */
export function cellWidthOf(glyphs: readonly string[]): number {
	return Math.max(1, ...glyphs.map((glyph) => visibleWidth(glyph)));
}

/** The painter `CellCanvas.rows` takes: themed runs, every cell padded out to `cellWidth` columns. */
export function paintCells(cellWidth: number): (text: string, cell: CellStyle) => string {
	if (cellWidth === 1) return paintRun;
	return (text, cell) =>
		paintRun(
			Array.from(
				graphemes.segment(text),
				({ segment }) => segment + " ".repeat(Math.max(0, cellWidth - visibleWidth(segment))),
			).join(""),
			cell,
		);
}
