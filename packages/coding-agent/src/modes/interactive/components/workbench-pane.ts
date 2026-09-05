import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";

const CELL_RESET = "\x1b[0m\x1b]8;;\x1b\\";

/** All pane borders consume cells inside, never outside, the allocated rectangle. */
export function framePane(title: string, content: string[], width: number, height: number): string[] {
	if (height <= 0) return [];
	const inner = Math.max(0, width - 2);
	const edge = (left: string, middle: string, right: string) =>
		theme.fg("border", truncateToWidth(left + middle + right, width, ""));
	const label = truncateToWidth(` ${title} `, inner, "");
	const heading = edge("┌", label + "─".repeat(Math.max(0, inner - visibleWidth(label))), "┐");
	if (height === 1) return [heading];
	return [
		heading,
		...Array.from(
			{ length: height - 2 },
			(_, row) =>
				theme.fg("border", "│") +
				truncateToWidth(content[row] ?? "", inner, "", true) +
				CELL_RESET +
				theme.fg("border", "│"),
		),
		edge("└", "─".repeat(inner), "┘"),
	].map((line) => truncateToWidth(line, width, ""));
}

/** Small current-evidence viewport. It owns scroll position, not task/history state. */
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

	render(title: string, lines: string[], x: number, y: number, width: number, height: number): string[] {
		this.x = x + 1;
		this.y = y + 1;
		this.width = Math.max(0, width - 2);
		this.height = Math.max(0, height - 2);
		this.count = lines.length;
		this.offset = Math.min(this.offset, Math.max(0, lines.length - this.height));
		const range =
			lines.length > this.height && this.height > 0
				? ` · ${this.offset + 1}-${Math.min(lines.length, this.offset + this.height)}/${lines.length} ↕`
				: "";
		return framePane(title + range, lines.slice(this.offset, this.offset + this.height), width, height);
	}
}
