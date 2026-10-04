/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

interface TruncationMeasurement {
	lines: string[];
	maxLines: number;
	maxBytes: number;
	totalLines: number;
	totalBytes: number;
}

interface TruncationOutcome {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	outputLines: number;
	lastLinePartial?: boolean;
	firstLineExceedsLimit?: boolean;
}

function measureTruncation(content: string, options: TruncationOptions): TruncationMeasurement {
	const lines = splitLinesForCounting(content);
	return {
		lines,
		maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		totalLines: lines.length,
		totalBytes: Buffer.byteLength(content, "utf-8"),
	};
}

function buildTruncationResult(measurement: TruncationMeasurement, outcome: TruncationOutcome): TruncationResult {
	return {
		...outcome,
		totalLines: measurement.totalLines,
		totalBytes: measurement.totalBytes,
		outputBytes: Buffer.byteLength(outcome.content, "utf-8"),
		lastLinePartial: outcome.lastLinePartial ?? false,
		firstLineExceedsLimit: outcome.firstLineExceedsLimit ?? false,
		maxLines: measurement.maxLines,
		maxBytes: measurement.maxBytes,
	};
}

function unchangedTruncationResult(content: string, measurement: TruncationMeasurement): TruncationResult | undefined {
	if (measurement.totalLines > measurement.maxLines || measurement.totalBytes > measurement.maxBytes) return undefined;
	return buildTruncationResult(measurement, {
		content,
		truncated: false,
		truncatedBy: null,
		outputLines: measurement.totalLines,
	});
}

function completedTruncationResult(
	measurement: TruncationMeasurement,
	outputLines: string[],
	truncatedBy: "lines" | "bytes",
	lastLinePartial = false,
): TruncationResult {
	return buildTruncationResult(measurement, {
		content: outputLines.join("\n"),
		truncated: true,
		truncatedBy,
		outputLines: outputLines.length,
		lastLinePartial,
	});
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const measurement = measureTruncation(content, options);
	const { lines, maxBytes, maxLines } = measurement;

	const unchanged = unchangedTruncationResult(content, measurement);
	if (unchanged) return unchanged;

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return buildTruncationResult(measurement, {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			firstLineExceedsLimit: true,
		});
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	return completedTruncationResult(measurement, outputLinesArr, truncatedBy);
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const measurement = measureTruncation(content, options);
	const { lines, maxBytes, maxLines } = measurement;

	const unchanged = unchangedTruncationResult(content, measurement);
	if (unchanged) return unchanged;

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	return completedTruncationResult(measurement, outputLinesArr, truncatedBy, lastLinePartial);
}

/** Marker line used by {@link truncateMiddle} when the omitted span is known. */
export function formatMiddleOmissionMarker(omittedLines: number, omittedBytes: number): string {
	return `...[middle omitted: ${omittedLines} lines, ${formatSize(omittedBytes)}]`;
}

interface HeadTailBudgets {
	headLineBudget: number;
	tailLineBudget: number;
	headByteBudget: number;
	tailByteBudget: number;
}

function allocateHeadTailBudgets(
	maxLines: number,
	maxBytes: number,
	totalLines: number,
	totalBytes: number,
): HeadTailBudgets {
	const probeMarker = formatMiddleOmissionMarker(totalLines, totalBytes);
	const markerBudget = Buffer.byteLength(probeMarker, "utf-8") + 1;
	const usableBytes = Math.max(1, maxBytes - markerBudget);
	const headLineBudget = Math.max(1, Math.floor((maxLines - 1) * 0.75));
	const tailLineBudget = Math.max(1, maxLines - 1 - headLineBudget);
	return {
		headLineBudget,
		tailLineBudget,
		headByteBudget: Math.max(1, Math.floor(usableBytes * 0.75)),
		tailByteBudget: Math.max(1, usableBytes - Math.max(1, Math.floor(usableBytes * 0.75))),
	};
}

function takePrefixLines(lines: readonly string[], lineBudget: number, byteBudget: number): string[] {
	const output: string[] = [];
	let bytes = 0;
	for (let index = 0; index < lines.length && output.length < lineBudget; index++) {
		const lineBytes = Buffer.byteLength(lines[index], "utf-8") + (output.length > 0 ? 1 : 0);
		if (bytes + lineBytes > byteBudget) break;
		output.push(lines[index]);
		bytes += lineBytes;
	}
	return output;
}

function takeSuffixLines(lines: readonly string[], lineBudget: number, byteBudget: number, minIndex: number): string[] {
	const output: string[] = [];
	let bytes = 0;
	for (let index = lines.length - 1; index >= minIndex && output.length < lineBudget; index--) {
		const lineBytes = Buffer.byteLength(lines[index], "utf-8") + (output.length > 0 ? 1 : 0);
		if (bytes + lineBytes > byteBudget) break;
		output.unshift(lines[index]);
		bytes += lineBytes;
	}
	return output;
}

function firstLineExceedsResult(measurement: TruncationMeasurement): TruncationResult {
	return buildTruncationResult(measurement, {
		content: "",
		truncated: true,
		truncatedBy: "bytes",
		outputLines: 0,
		firstLineExceedsLimit: true,
	});
}

function composeHeadTailResult(
	measurement: TruncationMeasurement,
	head: string[],
	tail: string[],
	omittedLines: number,
	omittedBytes: number,
): TruncationResult | undefined {
	if (omittedLines <= 0 || head.length === 0 || tail.length === 0) return undefined;
	const truncatedBy = measurement.totalBytes > measurement.maxBytes ? "bytes" : "lines";
	return completedTruncationResult(
		measurement,
		[...head, formatMiddleOmissionMarker(omittedLines, omittedBytes), ...tail],
		truncatedBy,
	);
}

/**
 * Truncate the middle (keep a head and a tail). Suitable for packed tool output where the
 * start (invocation, first hits) and the end (errors, last hits, summaries) both matter.
 *
 * Never returns partial lines. If the first line exceeds the full byte limit, matches
 * {@link truncateHead}: empty content with firstLineExceedsLimit.
 */
export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const measurement = measureTruncation(content, options);
	const unchanged = unchangedTruncationResult(content, measurement);
	if (unchanged) return unchanged;

	const { lines, maxBytes, maxLines } = measurement;
	if (lines.length > 0 && Buffer.byteLength(lines[0], "utf-8") > maxBytes) {
		return firstLineExceedsResult(measurement);
	}

	const budgets = allocateHeadTailBudgets(maxLines, maxBytes, measurement.totalLines, measurement.totalBytes);
	const head = takePrefixLines(lines, budgets.headLineBudget, budgets.headByteBudget);
	const tail = takeSuffixLines(lines, budgets.tailLineBudget, budgets.tailByteBudget, head.length);
	const omittedStart = head.length;
	const omittedEnd = lines.length - tail.length;
	if (omittedStart >= omittedEnd) {
		return truncateHead(content, options);
	}

	const omittedLines = omittedEnd - omittedStart;
	const omittedBytes = Buffer.byteLength(lines.slice(omittedStart, omittedEnd).join("\n"), "utf-8");
	return composeHeadTailResult(measurement, head, tail, omittedLines, omittedBytes) ?? truncateHead(content, options);
}

/**
 * Head+tail preview when only the first and last retained windows are known (streaming
 * accumulators that have already dropped the middle). If the two windows cover the whole
 * payload, reconstructs and delegates to {@link truncateMiddle}.
 */
export function truncateKnownHeadTail(
	headLines: readonly string[],
	tailLines: readonly string[],
	totals: { totalLines: number; totalBytes: number },
	options: TruncationOptions = {},
): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const measurement: TruncationMeasurement = {
		lines: [],
		maxLines,
		maxBytes,
		totalLines: totals.totalLines,
		totalBytes: totals.totalBytes,
	};

	if (totals.totalLines <= maxLines && totals.totalBytes <= maxBytes) {
		const content = (headLines.length >= totals.totalLines ? headLines : tailLines).join("\n");
		return buildTruncationResult(measurement, {
			content,
			truncated: false,
			truncatedBy: null,
			outputLines: totals.totalLines,
		});
	}

	if (headLines.length > 0 && Buffer.byteLength(headLines[0], "utf-8") > maxBytes) {
		return firstLineExceedsResult(measurement);
	}

	if (headLines.length + tailLines.length >= totals.totalLines && totals.totalLines > 0) {
		const overlap = Math.max(0, headLines.length + tailLines.length - totals.totalLines);
		const unique = [...headLines, ...tailLines.slice(overlap)];
		return truncateMiddle(unique.join("\n"), options);
	}

	const budgets = allocateHeadTailBudgets(maxLines, maxBytes, totals.totalLines, totals.totalBytes);
	const head = takePrefixLines(headLines, budgets.headLineBudget, budgets.headByteBudget);
	const tail = takeSuffixLines(tailLines, budgets.tailLineBudget, budgets.tailByteBudget, 0);
	const omittedLines = Math.max(0, totals.totalLines - head.length - tail.length);
	const omittedBytes = Math.max(
		0,
		totals.totalBytes - Buffer.byteLength(head.join("\n"), "utf-8") - Buffer.byteLength(tail.join("\n"), "utf-8"),
	);
	return (
		composeHeadTailResult(measurement, head, tail, omittedLines, omittedBytes) ??
		truncateHead([...headLines, ...tailLines].join("\n"), options)
	);
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
