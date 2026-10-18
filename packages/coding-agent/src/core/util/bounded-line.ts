/** Stands for the elided middle of a long line: no path character, and no boundary a path or alias starts at. */
const BOUNDED_LINE_ELISION = "…";
/** One unit of a bounded line: a non-space run with every quoted span inside it whole, a space, or an unpaired quote. */
const BOUNDED_LINE_UNIT_RE = /(?:[^\s'"`]|'[^']*'|"[^"]*"|`[^`]*`)+|\s|['"`]/g;

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
 *   ends inside a path: a cut path would read, to the path-alias extractor, as the real shorter path it spells;
 * - the tail starts at the first path separator its budget reaches, so a path keeps whole components and the file name
 *   the text names; a unit with no separator left (a word, a file name longer than the budget) is cut where the budget
 *   allows, never inside a surrogate pair. Behind the elision no path or alias match can start.
 */
export function boundedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const kept = maxChars - BOUNDED_LINE_ELISION.length;
	const headBudget = Math.ceil(kept / 2);
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
