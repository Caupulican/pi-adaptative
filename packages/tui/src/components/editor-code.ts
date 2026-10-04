/**
 * Render-time colorization of fenced code blocks for the Editor.
 *
 * Nothing here touches the editor buffer. Colors are derived per render from the buffer lines and
 * live only in the strings the Editor emits. The syntax highlighter itself is injected through
 * EditorCodeTheme (the same `highlightCode(code, lang)` contract Markdown uses), so this package
 * stays independent of any concrete highlighter or theme.
 */

/** Styling hooks the host injects. Only `highlight` is required; the rest degrade to unstyled text. */
export interface EditorCodeTheme {
	/** Highlight a block of code. Must return exactly one ANSI-styled string per input line. */
	highlight: (code: string, lang?: string) => string[];
	/** Tone for body lines that fall outside the highlighted span (very large blocks). */
	plain?: (text: string) => string;
	/** Style for the ``` / ~~~ fence markers. */
	fence?: (text: string) => string;
	/** Style for the language label after the opening fence. */
	label?: (text: string) => string;
	/** Surface tone painted behind every row of a code block, fences included. */
	surface?: (text: string) => string;
	/** Surface tone for the code row that holds the cursor; falls back to `surface`. */
	activeSurface?: (text: string) => string;
}

export interface FenceRegion {
	/** Logical line index of the opening fence. */
	open: number;
	/** Logical line index of the closing fence, or undefined while the fence is unterminated. */
	close: number | undefined;
	/** Language from the info string, lowercased. */
	lang: string | undefined;
}

/** One styled stretch of a logical line, in UTF-16 offsets of the raw buffer line. */
export interface StyleRun {
	start: number;
	end: number;
	open: string;
	close: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Longest line prefix handed to the highlighter; the rest of a longer line stays plain. */
const MAX_LINE_CHARS = 240;
/** Most lines and characters highlighted in one call, so keystroke cost is independent of buffer size. */
const MAX_SPAN_LINES = 60;
const MAX_SPAN_CHARS = 6000;
/** Lines of lexer context kept above the visible window of a block too large to highlight whole. */
const WINDOW_CONTEXT_LINES = 24;
const MAX_CACHED_SPANS = 24;

/** Locate fenced code blocks in the buffer lines. An unterminated fence runs to the end of the buffer. */
export function findFenceRegions(lines: readonly string[]): FenceRegion[] {
	const regions: FenceRegion[] = [];
	let active: { region: FenceRegion; char: string; length: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length < 3 || (!line.includes("```") && !line.includes("~~~"))) continue;
		if (active) {
			const closing = FENCE_CLOSE.exec(line);
			if (closing && closing[1]![0] === active.char && closing[1]!.length >= active.length) {
				active.region.close = i;
				active = undefined;
			}
			continue;
		}
		const opening = FENCE_OPEN.exec(line);
		if (!opening) continue;
		const marker = opening[1]!;
		const info = opening[2]!;
		if (marker[0] === "`" && info.includes("`")) continue;
		const word =
			info
				.trim()
				.split(/\s+/)[0]
				?.replace(/^\{?\.?/, "")
				.replace(/\}$/, "") ?? "";
		const region: FenceRegion = { open: i, close: undefined, lang: word ? word.toLowerCase() : undefined };
		regions.push(region);
		active = { region, char: marker[0]!, length: marker.length };
	}
	return regions;
}

interface SgrState {
	fg: string;
	bg: string;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
}

function sgrOpen(state: SgrState): string {
	return (
		state.fg +
		state.bg +
		(state.bold ? "\x1b[1m" : "") +
		(state.italic ? "\x1b[3m" : "") +
		(state.underline ? "\x1b[4m" : "") +
		(state.strike ? "\x1b[9m" : "")
	);
}

function sgrClose(state: SgrState): string {
	return (
		(state.strike ? "\x1b[29m" : "") +
		(state.underline ? "\x1b[24m" : "") +
		(state.italic ? "\x1b[23m" : "") +
		(state.bold ? "\x1b[22m" : "") +
		(state.bg ? "\x1b[49m" : "") +
		(state.fg ? "\x1b[39m" : "")
	);
}

function applySgr(state: SgrState, params: string): void {
	const codes = params === "" ? ["0"] : params.split(";");
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		if (code === 0) {
			state.fg = "";
			state.bg = "";
			state.bold = state.italic = state.underline = state.strike = false;
		} else if (code === 1) state.bold = true;
		else if (code === 22) state.bold = false;
		else if (code === 3) state.italic = true;
		else if (code === 23) state.italic = false;
		else if (code === 4) state.underline = true;
		else if (code === 24) state.underline = false;
		else if (code === 9) state.strike = true;
		else if (code === 29) state.strike = false;
		else if (code === 39) state.fg = "";
		else if (code === 49) state.bg = "";
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = `\x1b[${code}m`;
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = `\x1b[${code}m`;
		else if (code === 38 || code === 48) {
			const length = codes[i + 1] === "2" ? 5 : 3;
			const spec = `\x1b[${codes.slice(i, i + length).join(";")}m`;
			if (code === 38) state.fg = spec;
			else state.bg = spec;
			i += length - 1;
		}
	}
}

/**
 * Turn an ANSI-styled copy of `raw` into style runs over `raw`'s own offsets. Returns undefined
 * when the styled text does not strip back to exactly `raw`, so a highlighter that rewrote the text
 * can never put colors on the wrong characters.
 */
export function extractStyleRuns(styled: string, raw: string): StyleRun[] | undefined {
	const runs: StyleRun[] = [];
	const state: SgrState = { fg: "", bg: "", bold: false, italic: false, underline: false, strike: false };
	let plainLength = 0;
	let runStart = 0;
	let textStart = 0;
	const flush = (textEnd: number): boolean => {
		if (textEnd <= textStart) return true;
		const text = styled.slice(textStart, textEnd);
		if (!raw.startsWith(text, plainLength)) return false;
		plainLength += text.length;
		const open = sgrOpen(state);
		if (open) {
			const previous = runs[runs.length - 1];
			if (previous && previous.end === runStart && previous.open === open) previous.end = plainLength;
			else runs.push({ start: runStart, end: plainLength, open, close: sgrClose(state) });
		}
		runStart = plainLength;
		return true;
	};
	let i = 0;
	while (i < styled.length) {
		if (styled.charCodeAt(i) !== 0x1b) {
			i++;
			continue;
		}
		if (styled[i + 1] !== "[") return undefined;
		let end = i + 2;
		while (end < styled.length && /[0-9;]/.test(styled[end]!)) end++;
		if (styled[end] !== "m") return undefined;
		if (!flush(i)) return undefined;
		applySgr(state, styled.slice(i + 2, end));
		i = end + 1;
		textStart = i;
	}
	if (!flush(styled.length)) return undefined;
	return plainLength === raw.length ? runs : undefined;
}

/** Style stretches of `raw` with formatter functions, returning runs over `raw`'s offsets. */
export function styledRuns(
	raw: string,
	parts: ReadonlyArray<{ start: number; end: number; format: ((text: string) => string) | undefined }>,
): StyleRun[] | undefined {
	const runs: StyleRun[] = [];
	for (const part of parts) {
		if (!part.format || part.end <= part.start) continue;
		const text = raw.slice(part.start, part.end);
		const partRuns = extractStyleRuns(part.format(text), text);
		if (!partRuns) return undefined;
		for (const run of partRuns) {
			runs.push({ start: run.start + part.start, end: run.end + part.start, open: run.open, close: run.close });
		}
	}
	return runs;
}

/** Runs for a fence row: the marker in the fence style, the info string in the label style. */
export function fenceRowRuns(line: string, isOpening: boolean, theme: EditorCodeTheme): StyleRun[] | undefined {
	const markerStart = line.length - line.trimStart().length;
	let markerEnd = markerStart;
	while (markerEnd < line.length && (line[markerEnd] === "`" || line[markerEnd] === "~")) markerEnd++;
	return styledRuns(line, [
		{ start: markerStart, end: markerEnd, format: theme.fence },
		{ start: markerEnd, end: isOpening ? line.length : markerEnd, format: theme.label },
	]);
}

/** Paint raw[from, to) with the runs that overlap it. Offsets are UTF-16 indexes into `raw`. */
export function paintRange(raw: string, runs: readonly StyleRun[], from: number, to: number): string {
	let out = "";
	let position = from;
	for (const run of runs) {
		if (run.end <= from) continue;
		if (run.start >= to) break;
		const start = Math.max(run.start, from);
		const end = Math.min(run.end, to);
		if (start > position) out += raw.slice(position, start);
		out += run.open + raw.slice(start, end) + run.close;
		position = end;
	}
	if (position < to) out += raw.slice(position, to);
	return out;
}

/**
 * Choose which body lines of a block to highlight. A block that fits the span budget is highlighted
 * whole, so lexer state is exact. A larger block gets a window around the visible lines plus a
 * little context above, so the work per keystroke stays bounded however large the buffer grows.
 */
export function chooseHighlightSpan(
	lines: readonly string[],
	bodyStart: number,
	bodyEnd: number,
	visibleFirst: number,
	visibleLast: number,
): { from: number; to: number } {
	const cost = (index: number): number => Math.min(lines[index]!.length, MAX_LINE_CHARS) + 1;
	if (bodyEnd - bodyStart <= MAX_SPAN_LINES) {
		let chars = 0;
		for (let i = bodyStart; i < bodyEnd; i++) chars += cost(i);
		if (chars <= MAX_SPAN_CHARS) return { from: bodyStart, to: bodyEnd };
	}
	const first = Math.max(visibleFirst, bodyStart);
	let from = first;
	let to = Math.min(visibleLast, bodyEnd - 1) + 1;
	to = Math.min(to, first + MAX_SPAN_LINES);
	let chars = 0;
	for (let i = from; i < to; i++) chars += cost(i);
	while (chars > MAX_SPAN_CHARS && to - from > 1) {
		to--;
		chars -= cost(to);
	}
	while (from > bodyStart && from > first - WINDOW_CONTEXT_LINES && to - from < MAX_SPAN_LINES) {
		if (chars + cost(from - 1) > MAX_SPAN_CHARS) break;
		chars += cost(from - 1);
		from--;
	}
	return { from, to };
}

/** Per-span cache of highlighted lines, keyed by language and exact text, evicted least-recently-used. */
export class CodeHighlightCache {
	private readonly entries = new Map<string, Array<StyleRun[] | undefined>>();

	highlight(
		lines: readonly string[],
		lang: string | undefined,
		theme: EditorCodeTheme,
	): Array<StyleRun[] | undefined> {
		const clipped = lines.map((line) => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line));
		const code = clipped.join("\n");
		const key = `${lang ?? ""}\u0000${code}`;
		const cached = this.entries.get(key);
		if (cached) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached;
		}
		const styled = theme.highlight(code, lang);
		const result = clipped.map((line, index) =>
			styled.length === clipped.length ? extractStyleRuns(styled[index]!, line) : undefined,
		);
		this.entries.set(key, result);
		if (this.entries.size > MAX_CACHED_SPANS) this.entries.delete(this.entries.keys().next().value!);
		return result;
	}

	clear(): void {
		this.entries.clear();
	}
}
