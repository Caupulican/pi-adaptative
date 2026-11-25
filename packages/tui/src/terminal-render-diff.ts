/** Computes and paints differential terminal rows. */

import { isImageLine } from "./terminal-image.ts";
import { fitToWidth, visibleWidth } from "./utils.ts";

/** Finds the logical row range a terminal repaint needs to consider. */
export function changedTerminalRows(previous: readonly string[], next: readonly string[]): [number, number] {
	let first = -1;
	let last = -1;
	const limit = Math.max(previous.length, next.length);
	for (let row = 0; row < limit; row++) {
		if ((previous[row] ?? "") === (next[row] ?? "")) continue;
		if (first === -1) first = row;
		last = row;
	}
	if (next.length > previous.length) {
		if (first === -1) first = previous.length;
		last = next.length - 1;
	}
	return [first, last];
}

/** End of an unchanged interior gap when moving the cursor costs fewer bytes than repainting it. */
function economicalTerminalRowGap(
	previous: readonly string[],
	next: readonly string[],
	start: number,
	end: number,
	width: number,
): number {
	let row = start;
	let repaint = 2;
	while (row < end && previous[row] === next[row]) {
		repaint += 2 + Math.min(width, next[row]!.length);
		row++;
	}
	const move = 4 + String(row - start + 1).length;
	return repaint > move ? row : start;
}

/** Paint a changed interval from column zero of its first row, ending on its last row. */
export function paintChangedTerminalRows(
	previous: readonly string[],
	next: readonly string[],
	start: number,
	end: number,
	width: number,
	insidePreviousViewport: boolean,
): string {
	const canSkip =
		end - start > 1 &&
		insidePreviousViewport &&
		previous.length === next.length &&
		!previous.some(isImageLine) &&
		!next.some(isImageLine);
	let buffer = "";
	for (let row = start; row <= end; row++) {
		if (row > start) {
			const changed = canSkip ? economicalTerminalRowGap(previous, next, row, end, width) : row;
			if (changed > row) {
				buffer += `\r\x1b[${changed - row + 1}B`;
				row = changed;
			} else {
				buffer += "\r\n";
			}
		}

		const line = next[row]!;
		if (isImageLine(line)) {
			buffer += `\x1b[2K${line}`;
			continue;
		}
		// Paint over the old row before clearing the tail, so terminals never flash a blank row.
		buffer += fitToWidth(line, width);
		if (Math.min(visibleWidth(line), width) < Math.min(visibleWidth(previous[row] ?? ""), width)) {
			buffer += "\x1b[K";
		}
	}
	return buffer;
}
