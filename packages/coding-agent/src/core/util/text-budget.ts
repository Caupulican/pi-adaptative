/**
 * Fit a list of lines into a byte budget without letting the front of the list eat it.
 *
 * Taking lines in order until a cap hits silently deletes the tail, and a caller that is about to
 * ask a question about "all of these" then asks it about a prefix. Sharing the budget keeps every
 * line represented: each gets an equal share, lines under their share hand the remainder back for
 * the others to use, and only a line still over its share after redistribution is shortened.
 */
const ELLIPSIS = " …";

export function shareTextBudget(lines: readonly string[], budget: number): string[] {
	if (lines.length === 0 || budget <= 0) return [];
	const separators = Math.max(0, lines.length - 1);
	const forText = budget - separators;
	// Below one usable character per line the list itself does not fit; keep the longest prefix
	// that does rather than emitting a column of ellipses.
	if (forText < lines.length * (ELLIPSIS.length + 1)) {
		const kept: string[] = [];
		let used = 0;
		for (const line of lines) {
			const cost = line.length + (kept.length > 0 ? 1 : 0);
			if (used + cost > budget) break;
			kept.push(line);
			used += cost;
		}
		return kept;
	}

	let remaining = forText;
	let unsettled = lines.length;
	const share = new Array<number>(lines.length).fill(0);
	const settled = new Array<boolean>(lines.length).fill(false);
	// Redistribute until no line is under its share: each pass hands the slack of the short lines
	// to the ones still over, so the last rule of a long file keeps its allowance.
	for (;;) {
		const each = Math.floor(remaining / unsettled);
		let changed = false;
		for (let index = 0; index < lines.length; index++) {
			if (settled[index]) continue;
			const length = (lines[index] as string).length;
			if (length <= each) {
				share[index] = length;
				settled[index] = true;
				remaining -= length;
				unsettled -= 1;
				changed = true;
			}
		}
		if (!changed || unsettled === 0) {
			const each2 = unsettled > 0 ? Math.floor(remaining / unsettled) : 0;
			for (let index = 0; index < lines.length; index++) {
				if (!settled[index]) share[index] = each2;
			}
			break;
		}
	}

	return lines.map((line, index) => {
		const allowance = share[index] as number;
		if (line.length <= allowance) return line;
		return `${line.slice(0, Math.max(0, allowance - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
	});
}
