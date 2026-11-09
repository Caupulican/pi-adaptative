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

/**
 * Why a citation is dropped. `missing_file`: nothing resolves at the cited path. `unreadable`: the scout cannot read the
 * cited path as text (a directory or other non-regular file, a path outside the scout's envelope whether or not anything
 * is there, over the byte bound, or a read error).
 */
export type CitationDropReason = "missing_file" | "unreadable" | "out_of_range" | "snippet_not_found" | "ambiguous";

export type CitationCheck =
	| { readonly status: "verified" }
	| { readonly status: "moved"; readonly start: number; readonly end: number }
	| { readonly status: "dropped"; readonly reason: CitationDropReason };

/** What the caller found at the cited path: its text, or that nothing is there, or that the scout cannot read it. */
export type CitedFile =
	| { readonly status: "text"; readonly text: string }
	| { readonly status: "missing" }
	| { readonly status: "unreadable" };

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
export function verifyCitation(citation: Citation, file: CitedFile): CitationCheck {
	if (file.status === "missing") return { status: "dropped", reason: "missing_file" };
	if (file.status === "unreadable") return { status: "dropped", reason: "unreadable" };
	const { start, end } = citation;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		return { status: "dropped", reason: "out_of_range" };
	}
	const lines = file.text.split(/\r?\n/);
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
