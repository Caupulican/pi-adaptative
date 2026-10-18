/** Stands for the elided middle of a long line: no path character, and no boundary a path or alias starts at. */
const BOUNDED_LINE_ELISION = "…";
/** One unit of a bounded line: a non-space run with every quoted span inside it whole, a space, or an unpaired quote. */
const BOUNDED_LINE_UNIT_RE = /(?:[^\s'"`]|'[^']*'|"[^"]*"|`[^`]*`)+|\s|['"`]/g;

export interface BoundedTextOptions {
	/**
	 * The text is one path. It keeps no head: an unquoted path with spaces (`/home/u/My Documents/a.ts`) is several units,
	 * and a head of its first units (`/home/u/My `) would read, to the path-alias extractor, as a real path. The whole
	 * budget goes to the tail, which keeps whole components from a separator and the file name.
	 */
	readonly path?: boolean;
}

/**
 * Text a notice quotes to a model, as one line of at most `maxChars` characters: whitespace runs collapse to one space
 * and the ends are trimmed, then the line is bounded as {@link boundedText} bounds it.
 */
export function boundedLine(text: string, maxChars: number): string {
	return boundedText(text.replace(/\s+/g, " ").trim(), maxChars);
}

/**
 * Text a notice quotes to a model, at most `maxChars` characters; text within the bound is returned as it is. A longer
 * text keeps its head and its tail around one elided middle, glued to both:
 * - the head ends between whole units, or just after the opening quote of the quoted span the bound falls in, so it never
 *   ends inside a path: a cut path would read, to the path-alias extractor, as the real shorter path it spells; a text
 *   that is one path (`options.path`) keeps no head at all;
 * - the tail starts at the first path separator its budget reaches, so a path keeps whole components and the file name
 *   the text names; a unit with no separator left (a word, a file name longer than the budget) is cut where the budget
 *   allows, never inside a surrogate pair. Behind the elision no path or alias match can start.
 */
export function boundedText(text: string, maxChars: number, options?: BoundedTextOptions): string {
	if (text.length <= maxChars) return text;
	const kept = maxChars - BOUNDED_LINE_ELISION.length;
	const headBudget = options?.path ? 0 : Math.ceil(kept / 2);
	const units = [...text.matchAll(BOUNDED_LINE_UNIT_RE)].map((unit) => ({
		start: unit.index,
		end: unit.index + unit[0].length,
	}));
	let headEnd = 0;
	for (const unit of units) {
		if (unit.end > headBudget) {
			if (unit.start < headBudget && /['"`]/.test(text.charAt(unit.start))) headEnd = unit.start + 1;
			break;
		}
		headEnd = unit.end;
	}
	// The head's unused budget goes to the tail.
	let tailStart = text.length - (kept - headEnd);
	const tailUnit = units.find((unit) => unit.end > tailStart);
	if (tailUnit !== undefined && tailUnit.start < tailStart) {
		const separator = text.slice(tailStart, tailUnit.end).search(/[\\/]/);
		const code = text.charCodeAt(tailStart);
		if (separator >= 0) tailStart += separator;
		else if (code >= 0xdc00 && code <= 0xdfff) tailStart += 1;
	} else if (/\s/.test(text.charAt(tailStart))) tailStart += 1;
	return `${text.slice(0, headEnd)}${BOUNDED_LINE_ELISION}${text.slice(tailStart)}`;
}

/**
 * {@link boundedText} for a byte-budgeted surface: the bounded text is at most `maxBytes` UTF-8 bytes (a bound below the
 * elision's 3 bytes still returns the elision). The character
 * bound shrinks until the bounded text fits, so a text of multi-byte characters keeps fewer of them, never a cut code point.
 */
export function boundedUtf8Text(text: string, maxBytes: number, options?: BoundedTextOptions): string {
	let maxChars = Math.min(text.length, maxBytes);
	let bounded = boundedText(text, maxChars, options);
	let bytes = Buffer.byteLength(bounded, "utf8");
	while (bytes > maxBytes && maxChars > BOUNDED_LINE_ELISION.length) {
		// This bound's bytes per character estimate the next bound; each pass shrinks it by at least one.
		const estimate = Math.floor((maxChars * maxBytes) / bytes);
		maxChars = Math.max(BOUNDED_LINE_ELISION.length, Math.min(maxChars - 1, estimate));
		bounded = boundedText(text, maxChars, options);
		bytes = Buffer.byteLength(bounded, "utf8");
	}
	return bounded;
}
