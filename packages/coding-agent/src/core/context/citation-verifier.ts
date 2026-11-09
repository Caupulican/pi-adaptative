/**
 * Checks that a cited snippet is really at the cited lines, finds where it moved, or drops it.
 * Dependency-free: the caller supplies the cited file's text and decides how each result is reported.
 */

export interface Citation {
	readonly path: string;
	readonly start: number;
	readonly end: number;
	readonly snippet?: string;
}

export type CitationCheck =
	| { readonly status: "verified" }
	| { readonly status: "moved"; readonly start: number; readonly end: number }
	| {
			readonly status: "dropped";
			readonly reason: "missing_file" | "out_of_range" | "snippet_not_found" | "ambiguous";
	  };

/** Trims, collapses whitespace and strips one leading `-`, `+` or `>` marker, so layout does not decide a match. */
function normalizeLine(line: string): string {
	return line
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[-+>]\s*/, "")
		.trim();
}

/**
 * Without a snippet only the bounds are checked. With a snippet, the snippet must sit on the cited first line;
 * otherwise the single fitting match gives the moved range, which keeps the cited span length. A match counts
 * only when the cited span fits inside the file at that line.
 */
export function verifyCitation(citation: Citation, text: string | undefined): CitationCheck {
	if (text === undefined) return { status: "dropped", reason: "missing_file" };
	const { start, end } = citation;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		return { status: "dropped", reason: "out_of_range" };
	}
	const lines = text.split(/\r?\n/);
	const lineCount = lines.length;
	const snippet = citation.snippet === undefined ? "" : normalizeLine(citation.snippet);
	if (snippet === "") {
		return end <= lineCount ? { status: "verified" } : { status: "dropped", reason: "out_of_range" };
	}

	const span = end - start;
	const matches: number[] = [];
	for (const [index, line] of lines.entries()) {
		if (normalizeLine(line).includes(snippet)) matches.push(index + 1);
	}
	if (matches.length === 0) return { status: "dropped", reason: "snippet_not_found" };
	if (matches.includes(start) && end <= lineCount) return { status: "verified" };

	const fitting = matches.filter((line) => line + span <= lineCount);
	if (fitting.length === 0) return { status: "dropped", reason: "out_of_range" };
	if (fitting.length > 1) return { status: "dropped", reason: "ambiguous" };
	const moved = fitting[0];
	return { status: "moved", start: moved, end: moved + span };
}
