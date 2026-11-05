import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

/** Allocation-bounded structural projection for observers that do not need the full document. */
export interface EditorChangeSummary {
	firstNonWhitespace: string | undefined;
}

/** A range of editor text in UTF-16 code-unit offsets, `end` exclusive. */
export interface EditorTextRange {
	readonly start: number;
	readonly end: number;
}

/** `ranges` sorted, with empty ones dropped and overlapping or touching ones merged: the form editors report. */
export function mergeTextRanges(ranges: readonly EditorTextRange[]): EditorTextRange[] {
	const result: EditorTextRange[] = [];
	for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
		if (range.start >= range.end) continue;
		const last = result.at(-1);
		if (last && range.start <= last.end)
			result[result.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
		else result.push(range);
	}
	return result;
}

/**
 * `ranges` after `[start, end)` of their text was replaced by `inserted` code units: ranges before it stay, ranges after
 * it shift, a range overlapping it keeps only its parts outside it. The inserted text is added as a range when `pasted`.
 */
export function replaceTextRanges(
	ranges: readonly EditorTextRange[],
	start: number,
	end: number,
	inserted: number,
	pasted: boolean,
): EditorTextRange[] {
	const delta = inserted - (end - start);
	const result: EditorTextRange[] = [];
	for (const range of ranges) {
		if (range.end <= start) result.push(range);
		else if (range.start >= end) result.push({ start: range.start + delta, end: range.end + delta });
		else {
			if (range.start < start) result.push({ start: range.start, end: start });
			if (range.end > end) result.push({ start: start + inserted, end: range.end + delta });
		}
	}
	if (pasted) result.push({ start, end: start + inserted });
	return mergeTextRanges(result);
}

/**
 * `ranges` of `previous` carried onto `next`, a rewrite of it: the text between their common prefix and common suffix is
 * the rewritten part. `typed` (an edit, the editor's own rule) makes it typed; `pasted` (a rewrite the user did not type,
 * such as a template expansion) makes it pasted when it touched a pasted range, so pasted words never turn typed.
 */
export function carryTextRanges(
	previous: string,
	next: string,
	ranges: readonly EditorTextRange[],
	rewritten: "typed" | "pasted",
): EditorTextRange[] {
	if (ranges.length === 0 || previous === next) return mergeTextRanges(ranges);
	const limit = Math.min(previous.length, next.length);
	let prefix = 0;
	while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix++;
	const end = previous.length - suffix;
	const touched = rewritten === "pasted" && ranges.some((range) => range.start < end && range.end > prefix);
	return replaceTextRanges(ranges, prefix, end, next.length - suffix - prefix, touched);
}

export function firstNonWhitespaceCharacter(text: string): string | undefined {
	const index = text.search(/\S/u);
	return index === -1 ? undefined : text[index];
}

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/**
	 * Set the text content. An editor that tracks paste provenance takes `pasted`, the ranges of `text` the user pasted
	 * (text restored to the editor keeps them); without it, or in an editor that does not track provenance, it is typed.
	 */
	setText(text: string, pasted?: readonly EditorTextRange[]): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	/** Direct paste ingestion without wrapping into terminal escape sequences. */
	pasteText?(text: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/**
	 * Called when user submits (e.g., Enter key). An editor that tracks paste provenance passes `pasted`: the sorted,
	 * disjoint ranges of `text` the user pasted rather than typed (a pasted part the user edited counts as typed).
	 */
	onSubmit?: (text: string, pasted?: readonly EditorTextRange[]) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	/** Explicit capability flag for structural change notifications. */
	readonly supportsChangeSummary?: true;

	/** Called without materializing the full document when supported. */
	onChangeSummary?: (summary: EditorChangeSummary) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation, with the ranges of it the user pasted; recalling it restores them. */
	addToHistory?(text: string, pasted?: readonly EditorTextRange[]): void;

	/** Replace the full input-history recall buffer, oldest entry first. */
	setHistory?(texts: readonly string[]): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	/** Ranges of `getExpandedText()` the user pasted rather than typed, for an editor that tracks paste provenance. */
	getPastedRanges?(): readonly EditorTextRange[];

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
