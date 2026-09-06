export interface CenteredVisibleRange {
	startIndex: number;
	endIndex: number;
}

/** Centered window over a list. Empty count or maxVisible yields an empty range. */
export function getCenteredVisibleRange(
	selectedIndex: number,
	itemCount: number,
	maxVisible: number,
): CenteredVisibleRange {
	const boundedCount = Math.max(0, itemCount);
	const boundedVisible = Math.max(0, maxVisible);
	if (boundedCount === 0 || boundedVisible === 0) return { startIndex: 0, endIndex: 0 };

	const boundedIndex = Math.max(0, Math.min(selectedIndex, boundedCount - 1));
	const startIndex = Math.max(
		0,
		Math.min(boundedIndex - Math.floor(boundedVisible / 2), boundedCount - boundedVisible),
	);
	return {
		startIndex,
		endIndex: Math.min(startIndex + boundedVisible, boundedCount),
	};
}
