import { eastAsianWidth } from "get-east-asian-width";

// segmenters (shared instance)
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemeSegmenter;
}

/**
 * Get the shared word segmenter instance.
 */
export function getWordSegmenter(): Intl.Segmenter {
	return wordSegmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

// East Asian ambiguous characters (·, …, ●, box drawing, ...) occupy one column on most
// terminals but two columns on CJK-context terminals (e.g. a Windows console with a CJK
// codepage/font). The mode must match the terminal's actual rendering: differential
// rendering assumes one physical row per logical line, so an under-counted line auto-wraps
// and every cursor move after it lands one row short, leaving stale frames on screen.
// Detected at runtime via a cursor-position probe (see TUI.queryAmbiguousWidth).
let ambiguousAsWide = false;

/** Set how East Asian ambiguous characters are counted. Invalidates cached widths. */
export function setAmbiguousWidthMode(wide: boolean): void {
	if (ambiguousAsWide === wide) return;
	ambiguousAsWide = wide;
	widthCache.clear();
}

export function getAmbiguousWidthMode(): boolean {
	return ambiguousAsWide;
}

function isPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

function findTextRunEnd(text: string, start: number): number {
	let end = start;
	while (end < text.length && !extractAnsiCode(text, end)) end++;
	return end;
}

function movePendingParts(target: string[], pending: string[]): void {
	for (const part of pending) target.push(part);
	pending.length = 0;
}

interface PrefixScanResult {
	text: string;
	width: number;
	totalWidth: number;
	overflowed: boolean;
}

function scanTerminalPrefix(text: string, keepWidth: number, stopAfterWidth: number): PrefixScanResult {
	const parts: string[] = [];
	let width = 0;
	let totalWidth = 0;
	let keepContiguousPrefix = true;
	let overflowed = false;

	if (!text.includes("\x1b") && !text.includes("\t")) {
		for (const { segment } of graphemeSegmenter.segment(text)) {
			const segmentWidth = graphemeWidth(segment);
			if (keepContiguousPrefix && width + segmentWidth <= keepWidth) {
				parts.push(segment);
				width += segmentWidth;
			} else {
				keepContiguousPrefix = false;
			}
			totalWidth += segmentWidth;
			if (totalWidth > stopAfterWidth) {
				overflowed = true;
				break;
			}
		}
		return { text: parts.join(""), width, totalWidth, overflowed };
	}

	const pendingAnsi: string[] = [];
	let index = 0;

	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			pendingAnsi.push(ansi.code);
			index += ansi.length;
			continue;
		}

		if (text[index] === "\t") {
			if (keepContiguousPrefix && width + 3 <= keepWidth) {
				movePendingParts(parts, pendingAnsi);
				parts.push("\t");
				width += 3;
			} else {
				keepContiguousPrefix = false;
				pendingAnsi.length = 0;
			}
			totalWidth += 3;
			index++;
			if (totalWidth > stopAfterWidth) {
				overflowed = true;
				break;
			}
			continue;
		}

		const end = findTextRunEnd(text, index);
		for (const { segment } of graphemeSegmenter.segment(text.slice(index, end))) {
			const segmentWidth = graphemeWidth(segment);
			if (keepContiguousPrefix && width + segmentWidth <= keepWidth) {
				movePendingParts(parts, pendingAnsi);
				parts.push(segment);
				width += segmentWidth;
			} else {
				keepContiguousPrefix = false;
				pendingAnsi.length = 0;
			}

			totalWidth += segmentWidth;
			if (totalWidth > stopAfterWidth) {
				overflowed = true;
				break;
			}
		}
		if (overflowed) break;
		index = end;
	}

	return { text: parts.join(""), width, totalWidth, overflowed };
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}

	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	const result = scanTerminalPrefix(text, maxWidth, maxWidth);
	return { text: result.text, width: result.width };
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const visibleWidth = prefixWidth + ellipsisWidth;
	let result: string;

	if (ellipsis.length > 0) {
		result = `${prefix}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${reset}`;
	}

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
function graphemeWidth(segment: string): number {
	if (segment === "\t") {
		return 3;
	}

	// Zero-width clusters
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	let width = eastAsianWidth(cp, { ambiguousAsWide });

	// Trailing halfwidth/fullwidth forms and AM vowels that segment with a base.
	if (segment.length > 1) {
		for (const char of segment.slice(1)) {
			const c = char.codePointAt(0)!;
			if (c >= 0xff00 && c <= 0xffef) {
				width += eastAsianWidth(c, { ambiguousAsWide });
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
		}
	}

	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// Fast path: pure ASCII printable
	if (isPrintableAscii(str)) {
		return str.length;
	}

	// Check cache
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	if (clean.includes("\x1b")) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		const strippedParts: string[] = [];
		let index = 0;
		while (index < clean.length) {
			const ansi = extractAnsiCode(clean, index);
			if (ansi) {
				index += ansi.length;
				continue;
			}
			const end = findTextRunEnd(clean, index);
			strippedParts.push(clean.slice(index, end));
			index = end;
		}
		clean = strippedParts.join("");
	}

	// Calculate width
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// Cache result
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers. Visible tabs are
 * expanded to the fixed width used by layout while control sequences remain exact.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (!normalized.includes("\t")) return normalized;

	const parts: string[] = [];
	let index = 0;
	while (index < normalized.length) {
		const ansi = extractAnsiCode(normalized, index);
		if (ansi) {
			parts.push(ansi.code);
			index += ansi.length;
			continue;
		}
		const end = findTextRunEnd(normalized, index);
		parts.push(normalized.slice(index, end).replace(/\t/g, "   "));
		index = end;
	}
	return parts.join("");
}

/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;

	const next = str[pos + 1];

	// CSI sequence: ESC [ ... final-byte (0x40-0x7E). Non-SGR CSI sequences are zero-width too.
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length) {
			const code = str.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			j++;
		}
		return null;
	}

	// OSC and APC strings both terminate with BEL or ST (ESC \).
	if (next === "]" || next === "_") return extractTerminatedAnsiString(str, pos);

	return null;
}

function extractTerminatedAnsiString(str: string, pos: number): { code: string; length: number } | null {
	let end = pos + 2;
	while (end < str.length) {
		if (str[end] === "\x07") return { code: str.substring(pos, end + 1), length: end + 1 - pos };
		if (str[end] === "\x1b" && str[end + 1] === "\\") {
			return { code: str.substring(pos, end + 2), length: end + 2 - pos };
		}
		end++;
	}
	return null;
}

type Osc8Terminator = "\x07" | "\x1b\\";

interface ActiveHyperlink {
	params: string;
	url: string;
	terminator: Osc8Terminator;
}

function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	if (!ansiCode.startsWith("\x1b]8;")) {
		return undefined;
	}

	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	const separatorIndex = body.indexOf(";");
	if (separatorIndex === -1) {
		return undefined;
	}

	const params = body.slice(0, separatorIndex);
	const url = body.slice(separatorIndex + 1);
	if (!url) {
		return null;
	}
	return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: Osc8Terminator): string {
	return `\x1b]8;;${terminator}`;
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"
	private activeHyperlink: ActiveHyperlink | null = null;

	process(ansiCode: string): void {
		// OSC 8 hyperlink: \x1b]8;;<url>\x1b\\ (open) or \x1b]8;;\x1b\\ (close).
		// Preserve the original terminator because some terminals only make BEL-terminated
		// links clickable. OAuth login URLs use BEL, so reopening wrapped lines with ST
		// made only the first physical line clickable in those terminals.
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		if (hyperlink !== undefined) {
			this.activeHyperlink = hyperlink;
			return;
		}

		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Extract the parameters between \x1b[ and m
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			// Full reset
			this.reset();
			return;
		}

		// Parse parameters (can be semicolon-separated)
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// Handle 256-color and RGB codes which consume multiple parameters
			if (code === 38 || code === 48) {
				// 38;5;N (256 color fg) or 38;2;R;G;B (RGB fg)
				// 48;5;N (256 color bg) or 48;2;R;G;B (RGB bg)
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 color: 38;5;N or 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB color: 38;2;R;G;B or 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// Standard SGR codes
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break; // Some terminals
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break; // Default fg
				case 49:
					this.bgColor = null;
					break; // Default bg
				default:
					// Standard foreground colors 30-37, 90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// Standard background colors 40-47, 100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
		// SGR reset does not affect OSC 8 hyperlink state
	}

	/** Clear all state for reuse. */
	clear(): void {
		this.reset();
		this.activeHyperlink = null;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		if (this.activeHyperlink) {
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		return result;
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null ||
			this.activeHyperlink !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Underline must be closed to prevent bleeding into padding.
	 * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
	 * Returns empty string if no attributes need closing.
	 */
	getLineEndReset(): string {
		let result = "";
		if (this.underline) {
			result += "\x1b[24m"; // Underline off only
		}
		if (this.activeHyperlink) {
			result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
		}
		return result;
	}
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = 0;
	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			tracker.process(ansiResult.code);
			i += ansiResult.length;
		} else {
			i++;
		}
	}
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let currentParts: string[] = [];
	const pendingAnsi: string[] = []; // ANSI codes waiting to be attached to next visible content
	let inWhitespace = false;
	let i = 0;

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			// Hold ANSI codes separately - they'll be attached to the next visible char
			pendingAnsi.push(ansiResult.code);
			i += ansiResult.length;
			continue;
		}

		const char = text[i];
		const charIsSpace = char === " ";

		if (charIsSpace !== inWhitespace && currentParts.length > 0) {
			// Switching between whitespace and non-whitespace, push current token
			tokens.push(currentParts.join(""));
			currentParts = [];
		}

		// Attach any pending ANSI codes to this visible character
		movePendingParts(currentParts, pendingAnsi);

		inWhitespace = charIsSpace;
		let runEnd = i + 1;
		while (runEnd < text.length && text[runEnd] !== "\x1b" && (text[runEnd] === " ") === charIsSpace) {
			runEnd++;
		}
		currentParts.push(text.slice(i, runEnd));
		i = runEnd;
	}

	// Handle any remaining pending ANSI codes (attach to last token)
	movePendingParts(currentParts, pendingAnsi);
	if (currentParts.length > 0) tokens.push(currentParts.join(""));

	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// Handle newlines by processing each line separately
	// Track ANSI state across lines so styles carry over after literal newlines
	const inputLines = text.split(/\r\n|\r|\n/);
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// Prepend active ANSI codes from previous lines (except for first line)
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		const wrappedLines = wrapSingleLine(prefix + inputLine, width);
		for (const wrappedLine of wrappedLines) {
			result.push(wrappedLine);
		}
		// Update tracker with codes from this line for next iteration
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

function breakPlainAsciiWord(word: string, width: number): string[] {
	const lines: string[] = [];
	for (let start = 0; start < word.length; start += width) {
		lines.push(word.slice(start, start + width));
	}
	return lines;
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	if (width > 0 && line.length > width * 4 && !line.includes(" ") && isPrintableAscii(line)) {
		return breakPlainAsciiWord(line, width);
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	const currentParts: string[] = [];
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = token.trim() === "";

		// Token itself is too long - break it character by character
		if (tokenVisibleLength > width && !isWhitespace) {
			if (currentParts.length > 0) {
				// Add specific reset for underline only (preserves background)
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) currentParts.push(lineEndReset);
				wrapped.push(currentParts.join(""));
				currentParts.length = 0;
				currentVisibleLength = 0;
			}

			// Break long token - breakLongWord handles its own resets
			const broken = breakLongWord(token, width, tracker);
			for (let i = 0; i < broken.length - 1; i++) {
				wrapped.push(broken[i]!);
			}
			const finalBrokenLine = broken[broken.length - 1] ?? "";
			currentParts.push(finalBrokenLine);
			currentVisibleLength = visibleWidth(finalBrokenLine);
			continue;
		}

		// Check if adding this token would exceed width
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// Trim trailing whitespace, then add underline reset (not full reset, to preserve background)
			let lineToWrap = currentParts.join("").trimEnd();
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				lineToWrap += lineEndReset;
			}
			wrapped.push(lineToWrap);
			currentParts.length = 0;
			if (isWhitespace) {
				// Don't start new line with whitespace
				const activeCodes = tracker.getActiveCodes();
				if (activeCodes) currentParts.push(activeCodes);
				currentVisibleLength = 0;
			} else {
				const activeCodes = tracker.getActiveCodes();
				if (activeCodes) currentParts.push(activeCodes);
				currentParts.push(token);
				currentVisibleLength = tokenVisibleLength;
			}
		} else {
			// Add to current line
			currentParts.push(token);
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	const currentLine = currentParts.join("");
	if (currentLine) {
		// No reset at end of final line - let caller handle it
		wrapped.push(currentLine);
	}

	// Trailing whitespace can cause lines to exceed the requested width
	return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}

export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	if (width > 0 && isPrintableAscii(word)) {
		const activeCodes = tracker.getActiveCodes();
		const lineEndReset = tracker.getLineEndReset();
		const lines: string[] = [];
		for (let start = 0; start < word.length; start += width) {
			const isFinal = start + width >= word.length;
			lines.push(`${activeCodes}${word.slice(start, start + width)}${isFinal ? "" : lineEndReset}`);
		}
		return lines.length > 0 ? lines : [activeCodes];
	}

	const lines: string[] = [];
	const initialCodes = tracker.getActiveCodes();
	let currentParts = initialCodes ? [initialCodes] : [];
	let currentWidth = 0;

	// First, separate ANSI codes from visible content
	// We need to handle ANSI codes specially since they're not graphemes
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < word.length) {
		const ansiResult = extractAnsiCode(word, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			const end = findTextRunEnd(word, i);
			// Segment this non-ANSI portion into graphemes
			const textPortion = word.slice(i, end);
			for (const seg of graphemeSegmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// Now process segments
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentParts.push(seg.value);
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// Skip empty graphemes to avoid issues with string-width calculation
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			// Add specific reset for underline only (preserves background)
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) currentParts.push(lineEndReset);
			lines.push(currentParts.join(""));
			const activeCodes = tracker.getActiveCodes();
			currentParts = activeCodes ? [activeCodes] : [];
			currentWidth = 0;
		}

		currentParts.push(grapheme);
		currentWidth += graphemeWidth;
	}

	const currentLine = currentParts.join("");
	if (currentLine) {
		// No reset at end of final segment - caller handles continuation
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	const withPadding = line + padding;
	return bgFn(withPadding);
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "...")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	if (maxWidth <= 0) {
		return "";
	}

	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = visibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	if (isPrintableAscii(text)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	const scanned = scanTerminalPrefix(text, targetWidth, maxWidth);
	if (!scanned.overflowed) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - scanned.totalWidth)) : text;
	}

	return finalizeTruncatedResult(scanned.text, scanned.width, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	const resultParts: string[] = [];
	const pendingAnsi: string[] = [];
	let resultWidth = 0,
		currentCol = 0,
		i = 0;

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			if (currentCol >= startCol && currentCol < endCol) resultParts.push(ansi.code);
			else if (currentCol < startCol) pendingAnsi.push(ansi.code);
			i += ansi.length;
			continue;
		}

		const textEnd = findTextRunEnd(line, i);

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				movePendingParts(resultParts, pendingAnsi);
				resultParts.push(segment);
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: resultParts.join(""), width: resultWidth };
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	const beforeParts: string[] = [];
	const afterParts: string[] = [];
	const pendingAnsiBefore: string[] = [];
	let beforeWidth = 0,
		afterWidth = 0;
	let currentCol = 0,
		i = 0;
	let afterStarted = false;
	const afterEnd = afterStart + afterLen;

	// Track styling state so "after" inherits styling from before the overlay
	pooledStyleTracker.clear();

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			// Track all SGR codes to know styling state at afterStart
			pooledStyleTracker.process(ansi.code);
			// Include ANSI codes in their respective segments
			if (currentCol < beforeEnd) {
				pendingAnsiBefore.push(ansi.code);
			} else if (currentCol >= afterStart && currentCol < afterEnd && afterStarted) {
				// Only include after we've started "after" (styling already prepended)
				afterParts.push(ansi.code);
			}
			i += ansi.length;
			continue;
		}

		const textEnd = findTextRunEnd(line, i);

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);

			if (currentCol < beforeEnd) {
				movePendingParts(beforeParts, pendingAnsiBefore);
				beforeParts.push(segment);
				beforeWidth += w;
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				const fits = !strictAfter || currentCol + w <= afterEnd;
				if (fits) {
					// On first "after" grapheme, prepend inherited styling from before overlay
					if (!afterStarted) {
						afterParts.push(pooledStyleTracker.getActiveCodes());
						afterStarted = true;
					}
					afterParts.push(segment);
					afterWidth += w;
				}
			}

			currentCol += w;
			// Early exit: done with "before" only, or done with both segments
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		i = textEnd;
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	return { before: beforeParts.join(""), beforeWidth, after: afterParts.join(""), afterWidth };
}
