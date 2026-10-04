/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */

import { Text } from "@caupulican/pi-tui";

export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: string[];
	/** Number of earlier logical lines plus hidden wrapped tail lines. */
	skippedCount: number;
}

function countLogicalLines(text: string): number {
	if (!text) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function tailLogicalLines(text: string, maxLines: number): { text: string; skippedCount: number } {
	if (maxLines <= 0) return { text: "", skippedCount: countLogicalLines(text) };

	let totalLines = 1;
	let tailLines = 1;
	let tailStart = 0;
	let foundTailStart = false;

	for (let i = text.length - 1; i >= 0; i--) {
		if (text.charCodeAt(i) !== 10) continue;
		totalLines++;
		if (tailLines < maxLines) {
			tailLines++;
		} else if (!foundTailStart) {
			tailStart = i + 1;
			foundTailStart = true;
		}
	}

	if (!foundTailStart) return { text, skippedCount: 0 };
	return { text: text.slice(tailStart), skippedCount: Math.max(0, totalLines - maxLines) };
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Rendering wide/ANSI text is expensive. Tool previews only need the tail,
	// and the last N logical lines always contain the last N visual lines because
	// every logical line renders to at least one visual line. Pre-slice before
	// constructing Text so streaming command previews do not re-wrap thousands of
	// old lines on every update tick.
	const tail = tailLogicalLines(text, maxVisualLines);
	const tempText = new Text(tail.text, paddingX, 0);
	const skippedLogicalLines = tail.skippedCount;
	const renderedVisualLines = tempText.render(width);

	if (renderedVisualLines.length <= maxVisualLines) {
		return { visualLines: renderedVisualLines, skippedCount: skippedLogicalLines };
	}

	const extraSkippedVisualLines = renderedVisualLines.length - maxVisualLines;
	return {
		visualLines: renderedVisualLines.slice(-maxVisualLines),
		skippedCount: skippedLogicalLines + extraSkippedVisualLines,
	};
}
