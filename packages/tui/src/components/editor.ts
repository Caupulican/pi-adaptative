import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import { BracketedPasteBuffer } from "../bracketed-paste.ts";
import {
	DELETE_CHARACTER_BACKWARD,
	DELETE_CHARACTER_FORWARD,
	DELETE_TO_LINE_END,
	DELETE_TO_LINE_START,
	DELETE_WORD_BACKWARD,
	DELETE_WORD_FORWARD,
	dispatchDeletionInput,
} from "../editing-actions.ts";
import {
	type EditorChangeSummary,
	type EditorHistoryEntry,
	type EditorTextRange,
	firstNonWhitespaceCharacter,
	mergeTextRanges,
	replaceTextRanges,
} from "../editor-component.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, isLegacyMultilineNewline, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, getWordSegmenter, isWhitespaceChar, truncateToWidth, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import {
	CodeHighlightCache,
	chooseHighlightSpan,
	type EditorCodeTheme,
	fenceRowRuns,
	findFenceRegions,
	paintRange,
	type StyleRun,
	styledRuns,
} from "./editor-code.ts";
import { createScrollBorder } from "./scroll-border.ts";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	// Fast path: no paste markers in the text or no valid IDs.
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	// Find all marker spans with valid IDs.
	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	// Build merged segment list.
	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		// Skip past markers that are entirely before this segment.
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// This segment falls inside a marker.
			// If this is the first segment of the marker, emit a merged segment.
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
			// Otherwise skip (already merged into the first segment).
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			const subGraphemes = [...graphemeSegmenter.segment(grapheme)];
			if (subGraphemes.length <= 1) {
				// A grapheme is atomic. If it is wider than the layout width,
				// render it as an overflowing visual chunk instead of recursing
				// with identical arguments.
				const endIndex = charIndex + grapheme.length;
				chunks.push({ text: grapheme, startIndex: charIndex, endIndex });
				chunkStart = endIndex;
				currentWidth = 0;
				wrapOppIndex = -1;
				continue;
			}

			// Multi-grapheme atomic segments wider than maxWidth (e.g. paste
			// markers in a narrow terminal) can still be visually split at
			// grapheme granularity. The segment remains logically atomic for
			// cursor movement / editing.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	// Push final chunk.
	if (chunkStart < line.length || chunks.length === 0) {
		chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	}

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface EditorSnapshot {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
	pastedRanges: EditorTextRange[];
}

/** An edit that states its own effect on the pasted ranges, instead of having it reconstructed from the text. */
type ProvenanceEdit =
	| { readonly kind: "paste"; readonly at: number; readonly length: number }
	| { readonly kind: "restore"; readonly ranges: EditorTextRange[] };

function piecesLength(pieces: readonly string[]): number {
	let length = 0;
	for (const piece of pieces) length += piece.length;
	return length;
}

/** Length of the common prefix of two texts given as pieces; pieces that are the same string are passed whole. */
function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
	let total = 0;
	let leftIndex = 0;
	let rightIndex = 0;
	let leftOffset = 0;
	let rightOffset = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPiece = left[leftIndex]!;
		const rightPiece = right[rightIndex]!;
		if (leftOffset === 0 && rightOffset === 0 && leftPiece === rightPiece) {
			total += leftPiece.length;
			leftIndex++;
			rightIndex++;
			continue;
		}
		while (
			leftOffset < leftPiece.length &&
			rightOffset < rightPiece.length &&
			leftPiece.charCodeAt(leftOffset) === rightPiece.charCodeAt(rightOffset)
		) {
			leftOffset++;
			rightOffset++;
			total++;
		}
		if (leftOffset < leftPiece.length && rightOffset < rightPiece.length) return total;
		if (leftOffset === leftPiece.length) {
			leftIndex++;
			leftOffset = 0;
		}
		if (rightOffset === rightPiece.length) {
			rightIndex++;
			rightOffset = 0;
		}
	}
	return total;
}

/** Length of the common suffix of two texts given as pieces, at most `limit`. */
function commonSuffixLength(left: readonly string[], right: readonly string[], limit: number): number {
	let total = 0;
	let leftIndex = left.length - 1;
	let rightIndex = right.length - 1;
	let leftOffset = 0;
	let rightOffset = 0;
	while (leftIndex >= 0 && rightIndex >= 0 && total < limit) {
		const leftPiece = left[leftIndex]!;
		const rightPiece = right[rightIndex]!;
		if (leftOffset === 0 && rightOffset === 0 && leftPiece === rightPiece && total + leftPiece.length <= limit) {
			total += leftPiece.length;
			leftIndex--;
			rightIndex--;
			continue;
		}
		while (
			total < limit &&
			leftOffset < leftPiece.length &&
			rightOffset < rightPiece.length &&
			leftPiece.charCodeAt(leftPiece.length - 1 - leftOffset) ===
				rightPiece.charCodeAt(rightPiece.length - 1 - rightOffset)
		) {
			leftOffset++;
			rightOffset++;
			total++;
		}
		if (total >= limit || (leftOffset < leftPiece.length && rightOffset < rightPiece.length)) return total;
		if (leftOffset === leftPiece.length) {
			leftIndex--;
			leftOffset = 0;
		}
		if (rightOffset === rightPiece.length) {
			rightIndex--;
			rightOffset = 0;
		}
	}
	return total;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
	/** Logical buffer line this row was laid out from. */
	lineIndex: number;
	/** Offset of `text` inside that logical line. */
	startIndex: number;
}

interface EditorLayout {
	width: number;
	pasteIds: string;
	text: string[];
	lines: TextChunk[][];
	offsets: number[];
	rowCount: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	/** Optional colorization of fenced code blocks. Applied at render time only; the buffer is never changed. */
	code?: EditorCodeTheme;
	/** Optional color for empty-editor placeholder text. */
	placeholderColor?: (str: string) => string;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
	/** Optional placeholder text shown when the editor is empty. */
	placeholder?: string;
	/**
	 * Keep visible owner-entered content out of autocomplete, prompt history, undo snapshots, and
	 * the kill ring. Large pastes stay expanded and submit preserves surrounding whitespace.
	 */
	privateContent?: boolean;
	/**
	 * Return the text exactly as edited: tabs are kept and submit does not trim. Unlike
	 * `privateContent`, undo, history and autocomplete behave normally. For text whose bytes matter,
	 * such as a system prompt.
	 */
	exactText?: boolean;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;

/** A placeholder of " · " separated hints, kept to whole hints that fit; the tail is dropped, never cut mid-word. */
function fitPlaceholder(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const [first = "", ...rest] = text.split(" · ");
	let fitted = first;
	for (const hint of rest) {
		const next = `${fitted} · ${hint}`;
		if (visibleWidth(next) > width) break;
		fitted = next;
	}
	return fitted;
}

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render width for cursor navigation
	private lastWidth: number = 80;
	private editorLayout?: EditorLayout;
	private layoutDirty = true;
	private layoutDirtyLine?: number;

	// Vertical scrolling support
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	/** If it returns true, the default text insertion is skipped. */
	public onPaste?: (pastedText: string) => boolean | undefined;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteInFlight = 0;
	private queuedAutocomplete?: { token: number; options: { force: boolean; explicitTab: boolean } };
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	/**
	 * Paste provenance: the ranges of the expanded text (paste markers expanded) the user pasted rather than typed,
	 * sorted and disjoint, reported with each submission. A paste adds its exact span; any other edit is reconstructed
	 * at `notifyChange` by diffing the expanded text against `provenanceBaseline`, and the changed part becomes typed.
	 */
	private pastedRanges: EditorTextRange[] = [];
	/** The expanded text, as pieces, that `pastedRanges` describe; undefined while none is tracked (diffing costs nothing). */
	private provenanceBaseline: string[] | undefined;
	/** Set by the next edit when it states its own effect on `pastedRanges`; consumed by its `notifyChange`. */
	private provenanceEdit: ProvenanceEdit | undefined;

	// Bracketed paste mode buffering
	private bracketedPaste = new BracketedPasteBuffer();

	// Prompt history for up/down navigation
	private history: Array<{ readonly text: string; readonly pasted: readonly EditorTextRange[] }> = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

	/**
	 * Consulted on Up arrow in an empty editor, before history navigation.
	 * Return true after restoring queued message(s) into the editor to consume
	 * the key; return false to fall through to history.
	 */
	onRecallQueued?: () => boolean;

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	private jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	private snappedFromCursorCol: number | null = null;

	// Undo support
	private undoStack = new UndoStack<EditorSnapshot>();
	private readonly privateContent: boolean;
	private readonly exactText: boolean;
	private readonly placeholder?: string;

	// Highlighted spans of fenced code blocks, keyed by exact text (render-time only).
	private readonly codeCache = new CodeHighlightCache();

	public onSubmit?: (text: string, pasted?: readonly EditorTextRange[]) => void;
	public onChange?: (text: string) => void;
	public readonly supportsChangeSummary = true as const;
	public onChangeSummary?: (summary: EditorChangeSummary) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		this.privateContent = options.privateContent ?? false;
		this.exactText = options.exactText ?? false;
		this.placeholder = options.placeholder;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	private invalidateLayout(line?: number): void {
		if (!this.layoutDirty) this.layoutDirtyLine = line;
		else if (line !== this.layoutDirtyLine) this.layoutDirtyLine = undefined;
		this.layoutDirty = true;
	}

	private notifyChange(line?: number): void {
		this.invalidateLayout(line);
		this.reconcilePastedRanges();
		if (this.onChangeSummary) {
			let firstNonWhitespace: string | undefined;
			for (const line of this.state.lines) {
				firstNonWhitespace = firstNonWhitespaceCharacter(line);
				if (firstNonWhitespace !== undefined) break;
			}
			this.onChangeSummary({ firstNonWhitespace });
		}
		if (this.onChange) this.onChange(this.getText());
	}

	/**
	 * Bring `pastedRanges` up to date with the current text. A stated edit applies exactly; any other change is the
	 * span between the common prefix and common suffix of the previous and current expanded text, now typed. Among
	 * identical characters that span is ambiguous, but the typed and pasted contents are the same under any alignment.
	 */
	private reconcilePastedRanges(): void {
		const edit = this.provenanceEdit;
		this.provenanceEdit = undefined;
		if (!edit && !this.provenanceBaseline) return;
		if (edit?.kind === "restore") this.pastedRanges = edit.ranges;
		const next = this.expandedPieces(this.state.lines);
		if (edit?.kind === "paste") {
			this.pastedRanges = replaceTextRanges(this.pastedRanges, edit.at, edit.at, edit.length, true);
		} else if (!edit && this.provenanceBaseline) {
			const previous = this.provenanceBaseline;
			const previousLength = piecesLength(previous);
			const nextLength = piecesLength(next);
			const prefix = commonPrefixLength(previous, next);
			const suffix = commonSuffixLength(previous, next, Math.min(previousLength, nextLength) - prefix);
			this.pastedRanges = replaceTextRanges(
				this.pastedRanges,
				prefix,
				previousLength - suffix,
				nextLength - suffix - prefix,
				false,
			);
		}
		this.provenanceBaseline = this.pastedRanges.length > 0 ? next : undefined;
	}

	/**
	 * The expanded text of `lines` as pieces: raw segments, each valid marker's paste content (the stored string itself,
	 * so an unchanged paste compares by identity) and line breaks. Joined, they are the expanded text.
	 */
	private expandedPieces(lines: readonly string[]): string[] {
		const pieces: string[] = [];
		for (const [index, line] of lines.entries()) {
			if (index > 0) pieces.push("\n");
			let from = 0;
			if (this.pastes.size > 0 && line.includes("[paste #")) {
				for (const match of line.matchAll(PASTE_MARKER_REGEX)) {
					const content = this.pastes.get(Number(match[1]));
					if (content === undefined) continue;
					pieces.push(line.slice(from, match.index), content);
					from = match.index + match[0].length;
				}
			}
			pieces.push(from === 0 ? line : line.slice(from));
		}
		return pieces;
	}

	/**
	 * Ranges of `getExpandedText()` the user pasted rather than typed: whatever they kept verbatim from a paste. A paste
	 * they edited is typed where they edited it.
	 */
	getPastedRanges(): EditorTextRange[] {
		this.reconcilePastedRanges();
		return this.pastedRanges.map((range) => ({ start: range.start, end: range.end }));
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	private segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		if (this.privateContent) return;
		this.autocompleteProvider = provider;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string, pasted?: readonly EditorTextRange[]): void {
		if (this.privateContent) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		// The ranges of the trimmed text the user pasted, so recalling it restores them.
		const from = text.length - text.trimStart().length;
		const ranges = mergeTextRanges(
			(pasted ?? []).map((range) => ({
				start: Math.max(0, range.start - from),
				end: Math.min(trimmed.length, range.end - from),
			})),
		);
		// Don't add consecutive duplicates; the newest submission's provenance is the one recalled.
		if (this.history.length > 0 && this.history[0]!.text === trimmed) {
			this.history[0] = { text: trimmed, pasted: ranges };
			return;
		}
		this.history.unshift({ text: trimmed, pasted: ranges });
		// Limit history size
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	/** Replace the prompt history buffer. Input is oldest entry first, each entry with the ranges of it the user pasted. */
	setHistory(entries: readonly EditorHistoryEntry[]): void {
		this.history = [];
		this.historyIndex = -1;
		if (this.privateContent) return;
		for (const entry of entries) {
			this.addToHistory(entry.text, entry.pasted);
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const layout = this.getEditorLayout(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(layout);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const layout = this.getEditorLayout(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(layout);
		return currentVisualLine === layout.rowCount - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		if (this.privateContent) return;
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
		}

		this.historyIndex = newIndex;

		// A recalled entry is restored with the ranges of it the user pasted, never re-derived from the text it replaces.
		const entry = this.historyIndex === -1 ? undefined : this.history[this.historyIndex];
		this.provenanceEdit = { kind: "restore", ranges: entry ? [...entry.pasted] : [] };
		// Returned to "current" state (-1): clear editor
		this.setTextInternal(entry?.text ?? "");
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		this.scrollOffset = 0;

		this.notifyChange();
	}

	invalidate(): void {
		this.editorLayout = undefined;
		// Highlighted spans carry the previous theme's colors.
		this.codeCache.clear();
	}

	/** Replace valid paste markers with same-length filler so the highlighter never lexes them as code. */
	private maskPasteMarkers(line: string): string {
		if (this.pastes.size === 0 || !line.includes("[paste #")) return line;
		return line.replace(PASTE_MARKER_REGEX, (marker, idGroup) =>
			this.pastes.has(Number(idGroup)) ? "_".repeat(marker.length) : marker,
		);
	}

	/**
	 * Style runs for every visible row that belongs to a fenced code block (fence rows included),
	 * keyed by logical line. A key with an undefined value is a code row that stays unstyled.
	 */
	private resolveCodeRows(visibleLines: LayoutLine[]): Map<number, StyleRun[] | undefined> | undefined {
		const code = this.theme.code;
		const lines = this.state.lines;
		if (!code || this.privateContent || visibleLines.length === 0) return undefined;
		const regions = findFenceRegions(lines);
		if (regions.length === 0) return undefined;
		const firstVisible = visibleLines[0]!.lineIndex;
		const lastVisible = visibleLines[visibleLines.length - 1]!.lineIndex;
		const rows = new Map<number, StyleRun[] | undefined>();
		for (const region of regions) {
			const bodyStart = region.open + 1;
			const bodyEnd = region.close ?? lines.length;
			if (bodyEnd < firstVisible || region.open > lastVisible) continue;
			rows.set(region.open, fenceRowRuns(lines[region.open]!, true, code));
			if (region.close !== undefined) rows.set(region.close, fenceRowRuns(lines[region.close]!, false, code));
			const first = Math.max(bodyStart, firstVisible);
			const last = Math.min(bodyEnd - 1, lastVisible);
			if (last < first) continue;
			const span = chooseHighlightSpan(lines, bodyStart, bodyEnd, first, last);
			const highlighted = this.codeCache.highlight(
				lines.slice(span.from, span.to).map((line) => this.maskPasteMarkers(line)),
				region.lang,
				code,
			);
			for (let row = first; row <= last; row++) {
				const line = lines[row]!;
				const runs =
					row >= span.from && row < span.to
						? highlighted[row - span.from]
						: styledRuns(line, [{ start: 0, end: line.length, format: code.plain }]);
				rows.set(row, runs);
			}
		}
		return rows;
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		this.lastWidth = layoutWidth;

		const horizontal = this.borderColor("─");

		// Layout the text
		const layout = this.getEditorLayout(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		const cursorLineIndex = this.findCurrentVisualLine(layout);

		// Adjust scroll offset to keep cursor visible
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layout.rowCount - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		const visibleLines = this.layoutVisibleLines(layout, maxVisibleLines, cursorLineIndex);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		if (this.scrollOffset > 0) {
			result.push(this.borderColor(createScrollBorder("↑", this.scrollOffset, width)));
		} else {
			result.push(horizontal.repeat(width));
		}

		// Render each visible layout line
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.autocompleteState;
		const codeRows = this.resolveCodeRows(visibleLines);

		for (const layoutLine of visibleLines) {
			// Code rows are colored from style runs over the raw buffer line; the text itself is never altered.
			const isCodeRow = codeRows?.has(layoutLine.lineIndex) ?? false;
			const runs = isCodeRow ? codeRows?.get(layoutLine.lineIndex) : undefined;
			const rawLine = this.state.lines[layoutLine.lineIndex] ?? "";
			const paint = (from: number, to: number): string =>
				runs
					? paintRange(rawLine, runs, layoutLine.startIndex + from, layoutLine.startIndex + to)
					: layoutLine.text.slice(from, to);
			// A code row keeps its surface tone behind the cursor, so the cursor closes only reverse video.
			const cursorEnd = isCodeRow ? "\x1b[27m" : "\x1b[0m";
			let displayText = paint(0, layoutLine.text.length);
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = paint(0, layoutLine.cursorPos);
				const after = layoutLine.text.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...this.segment(after, "grapheme")];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = paint(layoutLine.cursorPos + firstGrapheme.length, layoutLine.text.length);
					const cursor = `\x1b[7m${firstGrapheme}${cursorEnd}`;
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else if (this.placeholder && !this.privateContent && this.isEditorEmpty()) {
					const hint = truncateToWidth(
						fitPlaceholder(this.placeholder, contentWidth),
						Math.max(1, contentWidth),
						"",
					);
					const hintGraphemes = [...graphemeSegmenter.segment(hint)];
					const firstGrapheme = hintGraphemes[0]?.segment || " ";
					const restHint = hint.slice(firstGrapheme.length);
					const formatPlaceholder = this.theme.placeholderColor ?? ((s: string) => `\x1b[2m${s}\x1b[22m`);
					const cursor = `\x1b[7m${formatPlaceholder(firstGrapheme)}${cursorEnd}`;
					displayText = before + marker + cursor + (restHint ? formatPlaceholder(restHint) : "");
					lineVisibleWidth = visibleWidth(firstGrapheme) + visibleWidth(restHint);
				} else {
					// Cursor is at the end - add highlighted space
					const cursor = `\x1b[7m ${cursorEnd}`;
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			const row = `${leftPadding}${displayText}${padding}${lineRightPadding}`;
			const surface = layoutLine.hasCursor
				? (this.theme.code?.activeSurface ?? this.theme.code?.surface)
				: this.theme.code?.surface;
			result.push(isCodeRow && surface ? surface(row) : row);
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layout.rowCount - (this.scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			result.push(this.borderColor(createScrollBorder("↓", linesBelow, width)));
		} else {
			result.push(horizontal.repeat(width));
		}

		// Add autocomplete list if active
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				// Printable character - perform the jump
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.jumpMode = null;
		}

		const pasteResult = this.bracketedPaste.consume(data);
		if (pasteResult.kind === "pending") return;
		if (pasteResult.kind === "complete") {
			this.handlePaste(pasteResult.content);
			if (pasteResult.remainder.length > 0) {
				this.handleInput(pasteResult.remainder);
			}
			return;
		}
		data = pasteResult.data;

		// Ctrl+C - let parent handle (exit/clear)
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			if (!this.privateContent) this.undo();
			return;
		}

		// Handle autocomplete mode
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				if (this.applySelectedAutocomplete()) {
					this.cancelAutocomplete();
					this.notifyChange();
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				if (this.applySelectedAutocomplete()) {
					if (this.autocompletePrefix.startsWith("/")) {
						this.cancelAutocomplete();
						// Fall through to submit
					} else {
						this.cancelAutocomplete();
						this.notifyChange();
						return;
					}
				}
			}
		}

		// Tab - trigger completion
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		if (dispatchDeletionInput(data, this)) return;

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			if (!this.privateContent) this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			if (!this.privateContent) this.yankPop();
			return;
		}

		// Cursor movement actions
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// New line
		if (kb.matches(data, "tui.input.newLine") || isLegacyMultilineNewline(data)) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this[DELETE_CHARACTER_BACKWARD]();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// Submit (Enter)
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this[DELETE_CHARACTER_BACKWARD]();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// Arrow key navigation (with history support)
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (this.isEditorEmpty()) {
				if (this.onRecallQueued?.()) {
					return;
				}
				this.navigateHistory(-1);
			} else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down - scroll by page and move cursor
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// Character jump mode triggers
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space - insert regular space
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		// Regular characters
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private applySelectedAutocomplete(): boolean {
		const selected = this.autocompleteList?.getSelectedItem();
		if (!selected || !this.autocompleteProvider) return false;

		this.pushUndoSnapshot();
		this.lastAction = null;
		const result = this.autocompleteProvider.applyCompletion(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			selected,
			this.autocompletePrefix,
		);
		this.state.lines = result.lines;
		this.invalidateLayout();
		this.state.cursorLine = result.cursorLine;
		this.setCursorCol(result.cursorCol);
		return true;
	}

	/** Wrapping is shared by paint and navigation. Reuse unchanged logical lines across edits. */
	private getEditorLayout(width: number): EditorLayout {
		const previous = this.editorLayout;
		if (previous?.width === width && !this.layoutDirty) return previous;

		const validIds = this.validPasteIds();
		const pasteIds = [...validIds].join(",");
		const dirtyLine = this.layoutDirtyLine;
		this.layoutDirtyLine = undefined;
		this.layoutDirty = false;
		if (
			previous?.width === width &&
			previous.pasteIds === pasteIds &&
			previous.lines.length === this.state.lines.length &&
			dirtyLine !== undefined
		) {
			const text = this.state.lines[dirtyLine]!;
			if (text === previous.text[dirtyLine]) return previous;
			const chunks = this.wrapEditorLine(text, width, validIds);
			const change = chunks.length - previous.lines[dirtyLine]!.length;
			previous.text[dirtyLine] = text;
			previous.lines[dirtyLine] = chunks;
			if (change !== 0) {
				for (let index = dirtyLine + 1; index < previous.offsets.length; index++) {
					previous.offsets[index]! += change;
				}
				previous.rowCount += change;
			}
			return previous;
		}

		const wraps = new Map<string, TextChunk[]>();
		if (previous?.width === width) {
			for (const [index, line] of previous.text.entries()) {
				if (previous.pasteIds === pasteIds || !line.includes("[paste #")) wraps.set(line, previous.lines[index]!);
			}
		}
		const text = this.state.lines.slice();
		const offsets: number[] = [];
		let rowCount = 0;
		const lines = text.map((line) => {
			const chunks = wraps.get(line) ?? this.wrapEditorLine(line, width, validIds);
			wraps.set(line, chunks);
			offsets.push(rowCount);
			rowCount += chunks.length;
			return chunks;
		});
		this.editorLayout = { width, pasteIds, text, offsets, lines, rowCount };
		return this.editorLayout;
	}

	private wrapEditorLine(line: string, width: number, validIds: Set<number>): TextChunk[] {
		return visibleWidth(line) <= width
			? [{ text: line, startIndex: 0, endIndex: line.length }]
			: wordWrapLine(line, width, [...segmentWithMarkers(line, graphemeSegmenter, validIds)]);
	}

	private logicalLineAt(layout: EditorLayout, row: number): number {
		let low = 0;
		let high = layout.offsets.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (layout.offsets[middle]! <= row) low = middle;
			else high = middle;
		}
		return low;
	}

	private layoutVisibleLines(layout: EditorLayout, height: number, cursorRow: number): LayoutLine[] {
		const visible: LayoutLine[] = [];
		const end = Math.min(layout.rowCount, this.scrollOffset + height);
		let lineIndex = this.logicalLineAt(layout, this.scrollOffset);
		for (let row = this.scrollOffset; row < end; row++) {
			if (row === layout.offsets[lineIndex + 1]) lineIndex++;
			const chunks = layout.lines[lineIndex]!;
			const chunkIndex = row - layout.offsets[lineIndex]!;
			const chunk = chunks[chunkIndex]!;
			const hasCursor = row === cursorRow;
			let cursorPos: number | undefined;
			if (hasCursor) {
				cursorPos = this.state.cursorCol - chunk.startIndex;
				if (chunkIndex < chunks.length - 1) cursorPos = Math.min(cursorPos, chunk.text.length);
			}
			visible.push({ text: chunk.text, hasCursor, cursorPos, lineIndex, startIndex: chunk.startIndex });
		}
		return visible;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		return text.replace(PASTE_MARKER_REGEX, (marker, idGroup) => this.pastes.get(Number(idGroup)) ?? marker);
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	/** Replace the text; `pasted` are the ranges of `text` the user pasted (restored text keeps them), else it is typed. */
	setText(text: string, pasted?: readonly EditorTextRange[]): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.historyIndex = -1; // Exit history browsing mode
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.pastes.clear();
		this.pasteCounter = 0;
		this.provenanceEdit = { kind: "restore", ranges: pasted?.length ? this.normalizeRanges(text, pasted) : [] };
		this.setTextInternal(normalized);
	}

	/** `ranges` of `text` as offsets of `normalizeText(text)`: a line ending or tab it rewrites moves what follows it. */
	private normalizeRanges(text: string, ranges: readonly EditorTextRange[]): EditorTextRange[] {
		const expandTabs = !(this.privateContent || this.exactText);
		const at: number[] = [];
		let offset = 0;
		for (let index = 0; index < text.length; index++) {
			at.push(offset);
			// "\r\n" becomes one "\n": both of its offsets map to that line break.
			if (text[index] === "\r" && text[index + 1] === "\n") continue;
			offset += expandTabs && text[index] === "\t" ? 4 : 1;
		}
		at.push(offset);
		const clamp = (value: number): number => at[Math.min(Math.max(0, value), text.length)]!;
		return mergeTextRanges(
			ranges
				.filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end))
				.map((range) => ({ start: clamp(range.start), end: clamp(range.end) })),
		);
	}

	private resetState(preserveHistory: boolean): void {
		this.cancelAutocomplete();
		this.editorLayout = undefined;
		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.pastedRanges = [];
		this.provenanceBaseline = undefined;
		this.provenanceEdit = undefined;
		this.bracketedPaste.clear();
		if (!preserveHistory) this.history = [];
		this.historyIndex = -1;
		this.killRing = new KillRing();
		this.undoStack.clear();
		this.lastAction = null;
		this.jumpMode = null;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
		this.scrollOffset = 0;
		this.notifyChange();
	}

	/** Drop every live or historical reference retained by this editor instance. */
	clear(): void {
		this.resetState(false);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.historyIndex = -1;
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		const normalizedLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return this.privateContent || this.exactText ? normalizedLines : normalizedLines.replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// Normalize line endings and tabs
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// Multi-line insertion
			this.state.lines = [
				// All lines before current line
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		this.notifyChange(insertedLines.length === 1 ? this.state.cursorLine : undefined);
	}

	// All the editor methods from before...
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.historyIndex = -1; // Exit history browsing mode

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		this.notifyChange(this.state.cursorLine);

		// Check if we should trigger or update autocomplete
		if (!this.autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for symbol-based completion like @ or # at token boundaries
			else if (char === "@" || char === "#") {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command or symbol completion context
			else if (/[a-zA-Z0-9.\-_]/.test(char)) {
				this.triggerAutocompleteForCurrentContext();
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private triggerAutocompleteForCurrentContext(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		if (this.isInSlashCommandContext(textBeforeCursor) || /(?:^|[\s])[@#][^\s]*$/.test(textBeforeCursor)) {
			this.tryTriggerAutocomplete();
		}
	}

	private refreshAutocompleteAfterDeletion(): void {
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			this.triggerAutocompleteForCurrentContext();
		}
	}

	/** Direct paste ingestion without wrapping into terminal escape sequences. */
	pasteText(text: string): void {
		this.handlePaste(text);
	}

	private handlePaste(pastedText: string): void {
		// Both terminal and direct paste end the pending character-jump command.
		this.jumpMode = null;
		if (this.onPaste?.(pastedText) === true || pastedText.length === 0) {
			return;
		}
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// Clean the pasted text: normalize line endings, expand tabs
		const cleanText = this.normalizeText(decodedText);

		// Filter out non-printable characters except newlines
		let filteredText =
			this.privateContent || this.exactText
				? cleanText.replace(/[\x00-\x08\x0b-\x1f]/g, "")
				: cleanText.replace(/[\x00-\x09\x0b-\x1f]/g, "");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (!this.privateContent && /^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		const pastedLines = filteredText.split("\n");

		// Inline or behind a marker, the paste occupies exactly its text in the expanded text, at the cursor. Any change
		// not yet reconciled is reconciled first, so the paste is the only edit its notification applies.
		this.reconcilePastedRanges();
		if (filteredText.length > 0) {
			const at = piecesLength(
				this.expandedPieces([
					...this.state.lines.slice(0, this.state.cursorLine),
					(this.state.lines[this.state.cursorLine] ?? "").slice(0, this.state.cursorCol),
				]),
			);
			this.provenanceEdit = { kind: "paste", at, length: filteredText.length };
		}

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		if (!this.privateContent && (pastedLines.length > 10 || totalChars > 1000)) {
			// Store the paste and insert a marker
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.state.cursorLine++;
		this.setCursorCol(0);

		this.notifyChange();
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const expanded = this.expandPasteMarkers(this.state.lines.join("\n"));
		const result = this.privateContent || this.exactText ? expanded : expanded.trim();
		// A slash command completed just before submit changed the text without notifying: reconcile it here.
		this.reconcilePastedRanges();
		const offset = result === expanded ? 0 : expanded.length - expanded.trimStart().length;
		const pasted = this.pastedRanges
			.map((range) => ({
				start: Math.max(0, range.start - offset),
				end: Math.min(result.length, range.end - offset),
			}))
			.filter((range) => range.start < range.end);
		this.resetState(true);
		if (this.onSubmit) this.onSubmit(result, pasted);
	}

	[DELETE_CHARACTER_BACKWARD](): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;
		let editedLine: number | undefined;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Delete grapheme before cursor (handles emojis, combining characters, etc.)
			let line = this.state.lines[this.state.cursorLine] || "";
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// Find the last grapheme in the text before cursor
			const graphemes = [...this.segment(beforeCursor, "grapheme")];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			const pasteMarker = PASTE_MARKER_SINGLE.exec(lastGrapheme?.segment ?? "");

			if (pasteMarker) {
				const targetId = Number(pasteMarker[1]);
				this.pastes.delete(targetId);
				this.pasteCounter--;

				const higherIds = [...this.pastes.keys()].filter((id) => id > targetId).sort((a, b) => a - b);
				for (const id of higherIds) {
					this.pastes.set(id - 1, this.pastes.get(id)!);
					this.pastes.delete(id);
				}

				this.state.lines = this.state.lines.map((currentLine) =>
					currentLine.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
						const id = Number(idGroup);
						return id <= targetId ? fullMatch : `[paste #${id - 1}${suffixGroup}]`;
					}),
				);
				line = this.state.lines[this.state.cursorLine] || "";
			}

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
			if (!pasteMarker) editedLine = this.state.cursorLine;
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();
			this.mergeCurrentLineIntoPrevious();
		}

		this.notifyChange(editedLine);

		this.refreshAutocompleteAfterDeletion();
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	private moveToVisualLine(layout: EditorLayout, currentVisualLine: number, targetVisualLine: number): void {
		const currentVL = this.getVisualLine(layout, currentVisualLine);
		const targetVL = this.getVisualLine(layout, targetVisualLine);
		if (!(currentVL && targetVL)) return;

		// When the cursor was snapped to a segment start, resolve the pre-snap
		// position against the VL it belongs to. This gives the correct visual
		// column even after a resize reshuffles VLs.
		let currentVisualCol: number;
		if (this.snappedFromCursorCol !== null) {
			const vlIndex = this.findVisualLineAt(layout, currentVL.logicalLine, this.snappedFromCursorCol);
			currentVisualCol =
				this.snappedFromCursorCol - (this.getVisualLine(layout, vlIndex)?.startCol ?? currentVL.startCol);
		} else {
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// For non-last segments, clamp to length-1 to stay within the segment
		const isLastSourceSegment = currentVL.last;
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		const isLastTargetSegment = targetVL.last;
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		// Set cursor position
		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// Snap cursor to atomic segment boundary (e.g. paste markers)
		// so the cursor never lands in the middle of a multi-grapheme unit.
		// Single-grapheme segments don't need snapping.
		const segments = [...this.segment(logicalLine, "grapheme")];
		for (const seg of segments) {
			if (seg.index > this.state.cursorCol) break;
			if (seg.segment.length <= 1) continue;
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				const isContinuation = seg.index < targetVL.startCol;
				const isMovingDown = targetVisualLine > currentVisualLine;

				if (isContinuation && isMovingDown) {
					// The segment started on a previous visual line, and we
					// already visited it on the way down. Skip all remaining
					// continuation VLs and land on the first VL past it.
					const segEnd = seg.index + seg.segment.length;
					let next = targetVisualLine + 1;
					const endOfLine = layout.offsets[targetVL.logicalLine + 1] ?? layout.rowCount;
					const chunks = layout.lines[targetVL.logicalLine]!;
					const offset = layout.offsets[targetVL.logicalLine]!;
					while (next < endOfLine && chunks[next - offset]!.startIndex < segEnd) next++;
					if (next < layout.rowCount) {
						this.moveToVisualLine(layout, currentVisualLine, next);
						return;
					}
				}

				// Snap to the start of the segment so it gets highlighted.
				// Store the pre-snap position so the next vertical move can
				// resolve it to the correct visual column.
				this.snappedFromCursorCol = this.state.cursorCol;
				this.state.cursorCol = seg.index;
				return;
			}
		}

		// No snap occurred – we moved out of the atomic segment.
		this.snappedFromCursorCol = null;
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private mergeCurrentLineIntoPrevious(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
		this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
		this.state.lines.splice(this.state.cursorLine, 1);
		this.state.cursorLine--;
		this.setCursorCol(previousLine.length);
	}

	private mergeNextLineIntoCurrent(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
		this.state.lines[this.state.cursorLine] = currentLine + nextLine;
		this.state.lines.splice(this.state.cursorLine + 1, 1);
	}

	private isAtCurrentLineEnd(currentLine: string): boolean {
		return this.state.cursorCol >= currentLine.length;
	}

	private hasNextLine(): boolean {
		return this.state.cursorLine < this.state.lines.length - 1;
	}

	private recordKilledNewline(prepend: boolean): void {
		if (this.privateContent) return;
		this.killRing.push("\n", { prepend, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
	}

	[DELETE_TO_LINE_START](): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			if (!this.privateContent) {
				this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";
			}

			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();
			this.recordKilledNewline(true);
			this.mergeCurrentLineIntoPrevious();
		}

		this.notifyChange();
	}

	[DELETE_TO_LINE_END](): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			const deletedText = currentLine.slice(this.state.cursorCol);
			if (!this.privateContent) {
				this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";
			}

			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();
			this.recordKilledNewline(false);
			this.mergeNextLineIntoCurrent();
		}

		this.notifyChange();
	}

	[DELETE_WORD_BACKWARD](): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();
				this.recordKilledNewline(true);
				this.mergeCurrentLineIntoPrevious();
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			if (!this.privateContent) {
				this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
				this.lastAction = "kill";
			}

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		this.notifyChange();
	}

	[DELETE_WORD_FORWARD](): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		if (this.isAtCurrentLineEnd(currentLine)) {
			if (this.hasNextLine()) {
				this.pushUndoSnapshot();
				this.recordKilledNewline(false);
				this.mergeNextLineIntoCurrent();
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			if (!this.privateContent) {
				this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
				this.lastAction = "kill";
			}

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		this.notifyChange();
	}

	[DELETE_CHARACTER_FORWARD](): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const editedLine = this.state.cursorCol < currentLine.length ? this.state.cursorLine : undefined;

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			const graphemes = [...this.segment(afterCursor, "grapheme")];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();
			this.mergeNextLineIntoCurrent();
		}

		this.notifyChange(editedLine);

		this.refreshAutocompleteAfterDeletion();
	}

	private getVisualLine(layout: EditorLayout, row: number) {
		if (row < 0 || row >= layout.rowCount) return undefined;
		const logicalLine = this.logicalLineAt(layout, row);
		const chunks = layout.lines[logicalLine]!;
		const index = row - layout.offsets[logicalLine]!;
		const chunk = chunks[index]!;
		return {
			logicalLine,
			startCol: chunk.startIndex,
			length: chunk.endIndex - chunk.startIndex,
			last: index === chunks.length - 1,
		};
	}

	private findVisualLineAt(layout: EditorLayout, line: number, col: number): number {
		const chunks = layout.lines[line];
		if (!chunks?.length) return layout.rowCount - 1;
		let low = 0;
		let high = chunks.length - 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (col < chunks[middle]!.endIndex) high = middle;
			else low = middle + 1;
		}
		return layout.offsets[line]! + low;
	}

	private findCurrentVisualLine(layout: EditorLayout): number {
		return this.findVisualLineAt(layout, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const layout = this.getEditorLayout(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(layout);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < layout.rowCount) {
				this.moveToVisualLine(layout, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					const graphemes = [...this.segment(afterCursor, "grapheme")];
					const firstGrapheme = graphemes[0];
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// Wrap to start of next logical line
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					const currentVL = this.getVisualLine(layout, currentVisualLine);
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					const graphemes = [...this.segment(beforeCursor, "grapheme")];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.state.cursorLine > 0) {
					// Wrap to end of previous logical line
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const layout = this.getEditorLayout(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(layout);
		const targetVisualLine = Math.max(0, Math.min(layout.rowCount - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(layout, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		this.setCursorCol(
			findWordBackward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		this.deleteYankedText();

		// Rotate the ring: move end to front
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	private insertYankedText(text: string): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		this.notifyChange();
	}

	private pushUndoSnapshot(): void {
		if (this.privateContent) return;
		this.undoStack.push({
			state: this.state,
			pastes: this.pastes,
			pasteCounter: this.pasteCounter,
			pastedRanges: this.pastedRanges,
		});
	}

	private undo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot.state);
		this.pastes = snapshot.pastes;
		this.pasteCounter = snapshot.pasteCounter;
		// The snapshot's ranges describe its text exactly; diffing back to it could only lose them.
		this.provenanceEdit = { kind: "restore", ranges: snapshot.pastedRanges };
		this.lastAction = null;
		this.preferredVisualCol = null;
		this.notifyChange();
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.isAtCurrentLineEnd(currentLine)) {
			if (this.hasNextLine()) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		this.setCursorCol(
			findWordForward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	// Slash menu only allowed on the first line of the editor
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		return new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) return;
		// One cancelled OS request may still be returning. Let the replacement run while bounding outstanding I/O.
		if (this.autocompleteInFlight >= 2) {
			this.queuedAutocomplete = { token: startToken, options };
			return;
		}

		this.autocompleteInFlight++;
		try {
			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			await this.runAutocompleteRequest(
				requestId,
				controller,
				this.getText(),
				this.state.cursorLine,
				this.state.cursorCol,
				options,
			);
		} finally {
			this.autocompleteInFlight--;
			const next = this.queuedAutocomplete;
			this.queuedAutocomplete = undefined;
			if (next) void this.startAutocompleteRequest(next.token, next.options);
		}
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isSymbolAutocompleteContext = /(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$/.test(textBeforeCursor);
		return isSymbolAutocompleteContext ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		let suggestions: AutocompleteSuggestions | null;
		try {
			suggestions = await this.autocompleteProvider.getSuggestions(
				this.state.lines.slice(),
				snapshotLine,
				snapshotCol,
				{ signal: controller.signal, force: options.force },
			);
		} catch {
			suggestions = null;
		}

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestPresentationRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			this.notifyChange();
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestPresentationRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		this.queuedAutocomplete = undefined;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
