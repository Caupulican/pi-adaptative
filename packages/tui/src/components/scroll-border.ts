/**
 * The border a scrolled edit frame draws over the lines it hides: the hidden count in the interface language, fitted to
 * the frame's width so a longer word never pushes the border past it.
 */

import { libraryText } from "../library-text.ts";
import { sliceByColumn, visibleWidth } from "../utils.ts";

/** The border for `hiddenLineCount` hidden lines; `direction` says whether they sit above or below the frame. */
export function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const indicator = libraryText().scrollBorder(direction, hiddenLineCount);
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}
