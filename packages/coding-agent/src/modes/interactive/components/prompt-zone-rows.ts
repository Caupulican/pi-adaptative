/** Applies transcript prompt-zone marks at the two ends of an indexed terminal layout. */
import type { TerminalRows } from "@caupulican/pi-tui";

const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";

export function markPromptZone(rows: TerminalRows): TerminalRows {
	if (!rows.length) return rows;
	return {
		length: rows.length,
		at(index) {
			const line = rows.at(index);
			if (line === undefined) return line;
			const start = index === 0 ? ZONE_START + line : line;
			return index === rows.length - 1 ? ZONE_END + start : start;
		},
	};
}
