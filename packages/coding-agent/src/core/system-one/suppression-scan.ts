/**
 * Lint and type-check suppressions a change adds. A suppression hides what a check found, so the completion
 * account must answer for each one; the scan reads added lines only, never the words of the file it edits.
 */

/**
 * Comment-form directives that silence a linter or type checker. Anchoring each one on its comment marker keeps
 * source that only names a directive (a pattern, a doc sentence) out of the scan.
 */
const SUPPRESSION_DIRECTIVE =
	/(?:\/\/|\/\*|#|--)\s*(@ts-(?:ignore|expect-error|nocheck)|eslint-disable|biome-ignore|type:\s*ignore|noqa|pylint:\s*disable|nolint)\b|^\s*(#!?\[allow\()/;
const SCRIPT_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Prose files describe a directive; they never apply one. */
const PROSE_PATH = /\.(?:md|mdx|txt|rst|adoc)$/i;
/** A cast, not the words "as any" in a sentence: nothing but punctuation may follow. */
const CAST_TO_ANY = /\bas\s+any\b(?!\s*[A-Za-z0-9_])/;

export interface AddedSuppression {
	readonly path: string;
	/** The directive or cast alone: what System One reads. The author's own line is not evidence for itself. */
	readonly directive: string;
	/** The added line, for the refusal the model reads. */
	readonly text: string;
}

/** The lint and type-check suppressions a patch adds, read from its added lines only. */
export function addedSuppressions(patch: string): AddedSuppression[] {
	const found: AddedSuppression[] = [];
	let path = "";
	for (const line of patch.split("\n")) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			path = header[2] ?? header[1] ?? "";
			continue;
		}
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		if (PROSE_PATH.test(path)) continue;
		const text = line.slice(1);
		const match = SUPPRESSION_DIRECTIVE.exec(text);
		const cast = match === null && SCRIPT_PATH.test(path) ? CAST_TO_ANY.exec(text) : null;
		const directive = match ? (match[1] ?? match[2]) : cast?.[0];
		if (directive !== undefined) found.push({ path, directive, text: text.trim().slice(0, 160) });
	}
	return found;
}
