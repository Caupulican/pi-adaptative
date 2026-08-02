/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return normalizeFuzzyCharacters(text).replace(/[^\S\n]+(?=\n|$)/gu, "");
}

function normalizeFuzzyCharacters(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/** The original content replacements should be applied to. */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
	/** Inclusive 1-based line bounds from the read that supplied oldText. */
	range?: EditRange;
}

export interface EditRange {
	startLine: number;
	endLine: number;
}

interface PlannedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
	expectedText: string;
}

export interface EditMatchPlan {
	/** Length of the LF-normalized source against which this plan was validated. */
	baseLength: number;
	editCount: number;
	/** Compact, source-ordered replacement spans; the source body is not retained. */
	edits: readonly PlannedEdit[];
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Fuzzy matching searches normalized text, but returned spans still refer to
 * the original content so replacement does not normalize unrelated text.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: content,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countExactOccurrences(content: string, oldText: string): number {
	if (oldText.length === 0) return 0;
	let count = 0;
	let searchFrom = 0;
	while (searchFrom <= content.length - oldText.length) {
		const index = content.indexOf(oldText, searchFrom);
		if (index === -1) break;
		count++;
		searchFrom = index + 1;
	}
	return count;
}

function getLineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function lineColumnAt(lineStarts: number[], index: number): { lineIndex: number; column: number } {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (lineStarts[mid] <= index) low = mid + 1;
		else high = mid - 1;
	}
	const lineIndex = Math.max(0, high);
	return { lineIndex, column: index - lineStarts[lineIndex] };
}

function lineTextAt(content: string, lineStarts: number[], lineIndex: number): string {
	const start = lineStarts[lineIndex];
	const nextStart = lineStarts[lineIndex + 1] ?? content.length;
	const end = nextStart > start && content[nextStart - 1] === "\n" ? nextStart - 1 : nextStart;
	return content.slice(start, end);
}

function normalizedColumnToOriginalColumn(line: string, normalizedColumn: number): number {
	if (normalizedColumn <= 0) return 0;
	const boundaries = [0];
	for (let index = 0; index < line.length; ) {
		const codePoint = line.codePointAt(index);
		index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
		boundaries.push(index);
	}

	let low = 1;
	let high = boundaries.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (normalizeForFuzzyMatch(line.slice(0, boundaries[mid])).length >= normalizedColumn) high = mid;
		else low = mid + 1;
	}
	return boundaries[low] ?? line.length;
}

function mapFuzzySpanToOriginal(
	originalContent: string,
	originalLineStarts: number[],
	fuzzyLineStarts: number[],
	normalizedIndex: number,
	normalizedLength: number,
): { index: number; length: number } {
	const start = lineColumnAt(fuzzyLineStarts, normalizedIndex);
	const end = lineColumnAt(fuzzyLineStarts, normalizedIndex + normalizedLength);
	const startLine = lineTextAt(originalContent, originalLineStarts, start.lineIndex);
	const endLine = lineTextAt(originalContent, originalLineStarts, end.lineIndex);
	const originalStart =
		originalLineStarts[start.lineIndex] + normalizedColumnToOriginalColumn(startLine, start.column);
	const originalEnd = originalLineStarts[end.lineIndex] + normalizedColumnToOriginalColumn(endLine, end.column);
	return { index: originalStart, length: originalEnd - originalStart };
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, range?: EditRange): Error {
	const rangeSuffix = range ? ` within lines ${range.startLine}-${range.endLine}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}${rangeSuffix}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}${rangeSuffix}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

interface MatchWindow {
	start: number;
	end: number;
}

function validateRange(
	range: EditRange | undefined,
	lineStarts: number[] | undefined,
	contentLength: number,
	path: string,
	editIndex: number,
	totalEdits: number,
): MatchWindow {
	if (!range) return { start: 0, end: contentLength };
	const label = totalEdits === 1 ? "range" : `edits[${editIndex}].range`;
	if (
		!Number.isSafeInteger(range.startLine) ||
		!Number.isSafeInteger(range.endLine) ||
		range.startLine < 1 ||
		range.endLine < range.startLine
	) {
		throw new Error(`${label} in ${path} must contain inclusive positive line numbers with startLine <= endLine.`);
	}
	if (!lineStarts || range.endLine > lineStarts.length) {
		throw new Error(`${label} in ${path} exceeds the file's ${lineStarts?.length ?? 0} lines.`);
	}
	return {
		start: lineStarts[range.startLine - 1],
		end: lineStarts[range.endLine] ?? contentLength,
	};
}

function findWithin(content: string, oldText: string, window: MatchWindow): number {
	if (oldText.length === 0 || oldText.length > window.end - window.start) return -1;
	const index = content.indexOf(oldText, window.start);
	return index !== -1 && index + oldText.length <= window.end ? index : -1;
}

function rangesOverlap(previous: PlannedEdit, current: PlannedEdit): boolean {
	return previous.matchIndex + previous.matchLength > current.matchIndex;
}

/**
 * Match and validate one or more replacements against LF-normalized content.
 *
 * The returned plan retains only the validated spans and their replacement
 * text. Exact matching uses native substring search, bounded by optional line
 * ranges, while uniqueness is still proven across the whole source.
 */
export function planEditsToNormalizedContent(normalizedContent: string, edits: Edit[], path: string): EditMatchPlan {
	let originalLineStarts: number[] | undefined;
	let fuzzyContent: string | undefined;
	let fuzzyLineStarts: number[] | undefined;
	const needsLineStarts = edits.some((edit) => edit.range !== undefined);
	if (needsLineStarts) originalLineStarts = getLineStarts(normalizedContent);

	const matchedEdits: PlannedEdit[] = [];
	for (let i = 0; i < edits.length; i++) {
		const sourceEdit = edits[i];
		const oldText = normalizeToLF(sourceEdit.oldText);
		const newText = normalizeToLF(sourceEdit.newText);
		if (oldText.length === 0) throw getEmptyOldTextError(path, i, edits.length);

		const exactWindow = validateRange(
			sourceEdit.range,
			originalLineStarts,
			normalizedContent.length,
			path,
			i,
			edits.length,
		);
		let matchIndex = findWithin(normalizedContent, oldText, exactWindow);
		let matchLength = oldText.length;
		let occurrences: number;

		if (matchIndex !== -1) {
			occurrences = countExactOccurrences(normalizedContent, oldText);
		} else {
			fuzzyContent ??= normalizeForFuzzyMatch(normalizedContent);
			fuzzyLineStarts ??= getLineStarts(fuzzyContent);
			originalLineStarts ??= getLineStarts(normalizedContent);
			const fuzzyOldText = normalizeForFuzzyMatch(oldText);
			const fuzzyWindow = validateRange(
				sourceEdit.range,
				fuzzyLineStarts,
				fuzzyContent.length,
				path,
				i,
				edits.length,
			);
			const fuzzyIndex = findWithin(fuzzyContent, fuzzyOldText, fuzzyWindow);
			if (fuzzyIndex === -1) throw getNotFoundError(path, i, edits.length, sourceEdit.range);
			occurrences = countExactOccurrences(fuzzyContent, fuzzyOldText);
			const replacementSpan = mapFuzzySpanToOriginal(
				normalizedContent,
				originalLineStarts,
				fuzzyLineStarts,
				fuzzyIndex,
				fuzzyOldText.length,
			);
			matchIndex = replacementSpan.index;
			matchLength = replacementSpan.length;
		}

		if (occurrences > 1) {
			throw getDuplicateError(path, i, edits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex,
			matchLength,
			newText,
			expectedText: normalizedContent.slice(matchIndex, matchIndex + matchLength),
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (rangesOverlap(previous, current)) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	return { baseLength: normalizedContent.length, editCount: edits.length, edits: matchedEdits };
}

/** Apply a validated match plan to the same LF-normalized source in one linear join. */
export function applyEditMatchPlan(normalizedContent: string, plan: EditMatchPlan, path: string): AppliedEditsResult {
	if (normalizedContent.length !== plan.baseLength) {
		throw new Error(`The validated edit plan for ${path} is stale because the source length changed.`);
	}

	const parts: string[] = [];
	let sourceIndex = 0;
	for (const edit of plan.edits) {
		if (!normalizedContent.startsWith(edit.expectedText, edit.matchIndex)) {
			throw new Error(`The validated edit plan for ${path} is stale at edits[${edit.editIndex}].`);
		}
		parts.push(normalizedContent.slice(sourceIndex, edit.matchIndex), edit.newText);
		sourceIndex = edit.matchIndex + edit.matchLength;
	}
	parts.push(normalizedContent.slice(sourceIndex));
	const newContent = parts.join("");

	if (normalizedContent === newContent) throw getNoChangeError(path, plan.editCount);
	return { baseContent: normalizedContent, newContent };
}

export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	return applyEditMatchPlan(normalizedContent, planEditsToNormalizedContent(normalizedContent, edits, path), path);
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

export interface EditPlannedDiffResult extends EditDiffResult {
	plan: EditMatchPlan;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsPlannedDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditPlannedDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const plan = planEditsToNormalizedContent(normalizedContent, edits, path);
		const { baseContent, newContent } = applyEditMatchPlan(normalizedContent, plan, path);

		// Generate the diff
		return { ...generateDiffString(baseContent, newContent), plan };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const result = await computeEditsPlannedDiff(path, edits, cwd);
	if ("error" in result) return result;
	return { diff: result.diff, firstChangedLine: result.firstChangedLine };
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
