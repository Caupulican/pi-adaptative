import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * An added or removed row: its foreground token, and its surface tone when the theme defines one.
 * On palettes where added-green sits on a green-tinted panel, the foreground alone reads as grey;
 * the wash is what makes the change land.
 */
function paintDiffLine(kind: "added" | "removed", text: string, highlightedSuffix = ""): string {
	const painted = theme.fg(kind === "added" ? "toolDiffAdded" : "toolDiffRemoved", text) + highlightedSuffix;
	const surface = kind === "added" ? "toolDiffAddedBg" : "toolDiffRemovedBg";
	return theme.hasBg(surface) ? theme.bg(surface, painted) : painted;
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Retains whitespace so the change offsets match the source and its syntax colors exactly.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	painted = { removedLine: oldContent, addedLine: newContent },
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWordsWithSpace(oldContent, newContent);
	const emphasize = (rendered: string, kind: "removed" | "added") => {
		const ranges: { start: number; end: number }[] = [];
		let offset = 0;
		let firstChanged = true;
		for (const part of wordDiff) {
			if (part[kind === "removed" ? "added" : "removed"]) continue;
			if (part[kind]) {
				const start = offset + (firstChanged ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0);
				firstChanged = false;
				if (start < offset + part.value.length) ranges.push({ start, end: offset + part.value.length });
			}
			offset += part.value.length;
		}
		offset = 0;
		let rangeIndex = 0;
		// Only the highlighter's SGR attributes pass through here; source was sanitized upstream.
		return rendered.replace(/\x1b\[[\d;]*m|[^\x1b]+/g, (run) => {
			if (run.startsWith("\x1b")) return run;
			let output = "";
			let index = 0;
			while (index < run.length) {
				while (ranges[rangeIndex]?.end <= offset) rangeIndex++;
				const range = ranges[rangeIndex];
				const changed = range && offset >= range.start;
				const length = Math.min(
					run.length - index,
					range ? (changed ? range.end : range.start) - offset : run.length,
				);
				const text = run.slice(index, index + length);
				output += changed ? theme.inverse(text) : text;
				index += length;
				offset += length;
			}
			return output;
		});
	};
	return { removedLine: emphasize(painted.removedLine, "removed"), addedLine: emphasize(painted.addedLine, "added") };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
	/** Paint multiline source separately from diff markers and changed-word emphasis. */
	highlightContent?: (content: string) => string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	if (options.highlightContent) {
		const paint = options.highlightContent;
		const rows = diffText.split("\n").map((line) => ({ line, parsed: parseDiffLine(line) }));
		// Removed and added versions have independent lexer state; context participates in both.
		const versions = ["+", "-"].map((excluded) =>
			paint(
				rows
					.filter(({ parsed }) => parsed?.prefix !== excluded)
					.map(({ parsed }) => replaceTabs(parsed?.content ?? ""))
					.join("\n"),
			).split("\n"),
		);
		let removedIndex = 0;
		let addedIndex = 0;
		const paintedRows = rows.map(({ parsed }) => {
			const removed = parsed?.prefix !== "+" ? versions[0][removedIndex++] : "";
			const added = parsed?.prefix !== "-" ? versions[1][addedIndex++] : "";
			return parsed?.prefix === "-" ? removed : added;
		});
		for (let index = 0; index < rows.length - 1; index++) {
			const removed = rows[index].parsed;
			const added = rows[index + 1].parsed;
			if (
				removed?.prefix !== "-" ||
				added?.prefix !== "+" ||
				rows[index - 1]?.parsed?.prefix === "-" ||
				rows[index + 2]?.parsed?.prefix === "+"
			)
				continue;
			const emphasized = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content), {
				removedLine: paintedRows[index],
				addedLine: paintedRows[index + 1],
			});
			paintedRows[index] = emphasized.removedLine;
			paintedRows[index + 1] = emphasized.addedLine;
		}
		return rows
			.map(({ line, parsed }, index) => {
				if (!parsed) return theme.fg("text", line);
				const content = paintedRows[index];
				if (parsed.prefix === "+" || parsed.prefix === "-") {
					return paintDiffLine(
						parsed.prefix === "+" ? "added" : "removed",
						parsed.prefix,
						theme.fg("text", parsed.lineNum) + theme.fg("text", " ") + content,
					);
				}
				return theme.fg("text", ` ${parsed.lineNum} `) + content;
			})
			.join("\n");
	}
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(paintDiffLine("removed", `-${removed.lineNum} ${removedLine}`));
				result.push(paintDiffLine("added", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(paintDiffLine("removed", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(paintDiffLine("added", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(paintDiffLine("added", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
