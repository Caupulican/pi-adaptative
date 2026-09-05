import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";

const FULL_RESET = "\x1b[0m";
const BG_RESET = "\x1b[49m";

/**
 * Pad or clip one row to exactly `width` cells. Rows that already fit skip the grapheme scan, which
 * is the per-frame hot path: the width lookup is cached per string, the scan is not.
 */
export function fitRow(content: string, width: number): string {
	if (width <= 0) return "";
	const visible = visibleWidth(content);
	if (visible === width) return content;
	if (visible < width) return content + " ".repeat(width - visible);
	return truncateToWidth(content, width, "", true);
}

/** Paint the pane surface under one row. Inner resets re-open the surface; rows never exceed `width`. */
export function surfaceRow(content: string, width: number): string {
	if (width <= 0) return "";
	const surface = theme.getBgAnsi("workbenchSurface");
	const padded = fitRow(content, width);
	return `${surface}${padded
		.split(FULL_RESET)
		.join(FULL_RESET + surface)
		.split(BG_RESET)
		.join(BG_RESET + surface)}${BG_RESET}`;
}

/** Bold title on the left, muted meta right-aligned, exactly `width` cells. Meta yields before the title. */
export function labelRow(title: string, meta: string, width: number): string {
	if (width <= 0) return "";
	const titleWidth = visibleWidth(title);
	const metaWidth = visibleWidth(meta);
	if (meta && titleWidth + 2 + metaWidth <= width) {
		return `${theme.bold(theme.fg("text", title))}${" ".repeat(width - titleWidth - metaWidth)}${theme.fg("muted", meta)}`;
	}
	return truncateToWidth(theme.bold(theme.fg("text", title)), width, "…", true);
}

/** Small current-evidence viewport on a surface tone. It owns scroll position, not task/history state. */
export class WorkbenchPane {
	private offset = 0;
	private count = 0;
	private x = 0;
	private y = 0;
	private width = 0;
	private height = 0;

	reset(): void {
		this.offset = 0;
		this.hide();
	}

	hide(): void {
		this.width = 0;
		this.height = 0;
	}

	scrollAt(column: number, row: number, delta: number): boolean {
		if (column < this.x || column >= this.x + this.width || row < this.y || row >= this.y + this.height) return false;
		const step = Math.sign(delta) * Math.min(Math.abs(delta), this.height);
		this.offset = Math.max(0, Math.min(Math.max(0, this.count - this.height), this.offset + step));
		return true;
	}

	/**
	 * One title row followed by `height - 1` content rows, all `width` cells wide with one-cell gutters.
	 * The visible row range joins the meta when content overflows; only content rows accept wheel input.
	 */
	render(title: string, meta: string, lines: string[], x: number, y: number, width: number, height: number): string[] {
		if (height <= 0 || width <= 0) {
			this.hide();
			return [];
		}
		this.x = x + 1;
		this.y = y + 1;
		this.width = Math.max(0, width - 2);
		this.height = Math.max(0, height - 1);
		this.count = lines.length;
		this.offset = Math.min(this.offset, Math.max(0, lines.length - this.height));
		const range =
			lines.length > this.height && this.height > 0
				? `${this.offset + 1}-${Math.min(lines.length, this.offset + this.height)}/${lines.length} ↕`
				: "";
		const rows = [` ${labelRow(title, [meta, range].filter(Boolean).join(" · "), this.width)} `];
		for (let row = 0; row < this.height; row++) {
			rows.push(` ${fitRow(lines[this.offset + row] ?? "", this.width)} `);
		}
		return rows.map((row) => surfaceRow(row, width));
	}
}
