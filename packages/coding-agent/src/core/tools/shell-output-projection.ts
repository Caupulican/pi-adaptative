import { stripAnsi } from "../../utils/ansi.ts";
import type { OutputReductionDetails } from "./output-reduction.ts";
import { isProjectableTestCommand } from "./shell-test-command.ts";

const MIN_PROJECTABLE_LINES = 24;
const MIN_PROJECTABLE_BYTES = 4 * 1024;
const MAX_APPEND_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_HEAD_CHARS = 4 * 1024;
const MAX_LINE_TAIL_CHARS = 4 * 1024;
const MAX_SELECTED_LINE_CHARS = 2 * 1024;
const MAX_SELECTED_LINES = 120;
const MAX_SELECTED_BYTES = 12 * 1024;
const FAILURE_CONTEXT_BEFORE = 2;
const FAILURE_CONTEXT_AFTER = 6;
const FINAL_CONTEXT_LINES = 8;

export interface ShellOutputProjection {
	/** `test`: the failure/summary projection below; `reduction`: a family reducer (see output-reduction.ts). */
	kind: "test" | "reduction";
	content: string;
	inputLines: number;
	inputBytes: number;
	outputLines: number;
	outputBytes: number;
	omittedLines: number;
	collapsedPassingLines: number;
	/** Present for `reduction`: what the reducer reported, minus the raw path the caller adds. */
	reduction?: OutputReductionDetails;
}

export type ShellOutputProjectionDetails = Omit<ShellOutputProjection, "content" | "reduction">;

/** What the bash tool drives: bytes in as they stream, one projection (or nothing) at the end. */
export interface ShellOutputProjectorLike {
	append(data: Buffer): void;
	finish(exitCode: number | null): ShellOutputProjection | undefined;
}

interface SelectedLine {
	index: number;
	text: string;
	priority: number;
}

function clipSelectedLine(line: string): string {
	if (line.length <= MAX_SELECTED_LINE_CHARS) return line;
	const side = Math.floor((MAX_SELECTED_LINE_CHARS - 28) / 2);
	return `${line.slice(0, side)} … [line clipped] … ${line.slice(-side)}`;
}

function isSummaryLine(line: string): boolean {
	const text = line.trim();
	return (
		/^(?:ran\b|result\b|snapshots?\b|suites?\b|test files?\b|test suites?\b|tests?\b|tests passed\b|total tests?\b|duration\b|time\b)/iu.test(
			text,
		) ||
		/\b\d+\s+(?:failed|passed|pending|skipped)\b/iu.test(text) ||
		/\b(?:failed|passed|pending|skipped)\s*:\s*\d+\b/iu.test(text)
	);
}

function isPassingLine(line: string): boolean {
	return /^\s*(?:PASS\b|\[(?:PASS|PASSED|\+)\]|ok\s+\d+\b|test\s+.+\.\.\.\s+ok\b|[+✓✔√]\s)/iu.test(line);
}

function isProgressLine(line: string): boolean {
	return /^\s*[.·*]+(?:\s+\[?\d+%\]?)?\s*$/u.test(line);
}

function withoutZeroFailureSummaries(line: string): string {
	return line
		.replace(/\b(?:errors?|failed|failures?)\s*[:=]?\s*0\b/giu, "")
		.replace(/\b0\s+(?:errors?|failed|failures?)\b/giu, "");
}

function isFailureLine(line: string): boolean {
	const text = withoutZeroFailureSummaries(line.trim());
	return (
		/^(?:FAIL(?:ED)?\b|---\s+FAIL:|\[FAIL(?:ED)?\]|\[-\]|not ok\b|[×✗]\s|error\b|fatal\b|panic\b|thread\s+.+\s+panicked at\b)/iu.test(
			text,
		) ||
		/\b(?:AssertionError|assertion .+ failed|Caused by:\s*Error|Exception|Expected:.+Received:|panicked at|timed? out|Traceback \(most recent call last\))\b/iu.test(
			text,
		) ||
		/\b(?:errors?|failed|failures?)\s*[:=]\s*[1-9]\d*\b/iu.test(text) ||
		/\b[1-9]\d*\s+(?:errors?|failed|failures?)\b/iu.test(text)
	);
}

function isWarningLine(line: string): boolean {
	return /^\s*(?:WARN(?:ING)?\b|\[WARN(?:ING)?\])/iu.test(line);
}

/**
 * Incremental, bounded projector for recognized test-runner output. It retains
 * failure identity, nearby diagnostics, summaries, and final context while
 * counting passing/progress chatter instead of retaining it. The caller owns
 * exact raw-output persistence and must fall back to raw output if that handoff
 * cannot be created.
 */
export class ShellOutputProjector {
	private readonly decoder = new TextDecoder();
	private readonly selected = new Map<number, SelectedLine>();
	private readonly recent: SelectedLine[] = [];
	private currentHead = "";
	private currentTail = "";
	private currentChars = 0;
	private hasOpenLine = false;
	private totalBytes = 0;
	private totalLines = 0;
	private collapsedPassingLines = 0;
	private failureSignals = 0;
	private followFailureLines = 0;
	private finished = false;
	private cachedProjection: ShellOutputProjection | null | undefined;

	append(data: Buffer): void {
		if (this.finished) throw new Error("Cannot append to a finished shell output projector");
		this.totalBytes += data.length;
		for (let offset = 0; offset < data.length; offset += MAX_APPEND_CHUNK_BYTES) {
			this.appendDecodedText(
				this.decoder.decode(data.subarray(offset, offset + MAX_APPEND_CHUNK_BYTES), { stream: true }),
			);
		}
	}

	finish(exitCode: number | null): ShellOutputProjection | undefined {
		if (this.cachedProjection !== undefined) return this.cachedProjection ?? undefined;
		if (!this.finished) {
			this.finished = true;
			this.appendDecodedText(this.decoder.decode());
			if (this.hasOpenLine) this.completeLine();
		}

		if (this.totalLines < MIN_PROJECTABLE_LINES && this.totalBytes < MIN_PROJECTABLE_BYTES) {
			this.cachedProjection = null;
			return undefined;
		}
		if (exitCode !== 0 && this.failureSignals === 0) {
			this.cachedProjection = null;
			return undefined;
		}

		for (const line of this.recent.slice(-FINAL_CONTEXT_LINES)) this.select(line.index, line.text, 2);
		const projected = this.renderSelected();
		if (!projected || projected.outputBytes >= this.totalBytes * 0.8) {
			this.cachedProjection = null;
			return undefined;
		}

		this.cachedProjection = {
			kind: "test",
			content: projected.content,
			inputLines: this.totalLines,
			inputBytes: this.totalBytes,
			outputLines: projected.outputLines,
			outputBytes: projected.outputBytes,
			omittedLines: Math.max(0, this.totalLines - projected.selectedLines),
			collapsedPassingLines: this.collapsedPassingLines,
		};
		return this.cachedProjection;
	}

	private appendDecodedText(text: string): void {
		let segmentStart = 0;
		for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", segmentStart)) {
			this.appendToCurrentLine(text.slice(segmentStart, index));
			this.completeLine();
			segmentStart = index + 1;
		}
		if (segmentStart < text.length) this.appendToCurrentLine(text.slice(segmentStart));
	}

	private appendToCurrentLine(segment: string): void {
		if (segment.length === 0) return;
		this.hasOpenLine = true;
		this.currentChars += segment.length;
		const headRemaining = Math.max(0, MAX_LINE_HEAD_CHARS - this.currentHead.length);
		if (headRemaining > 0) this.currentHead += segment.slice(0, headRemaining);
		const remainder = segment.slice(headRemaining);
		if (remainder.length > 0) {
			this.currentTail = `${this.currentTail}${remainder}`.slice(-MAX_LINE_TAIL_CHARS);
		}
	}

	private completeLine(): void {
		const rawLine =
			this.currentChars <= this.currentHead.length
				? this.currentHead
				: `${this.currentHead} … [line clipped] … ${this.currentTail}`;
		const withoutAnsi = rawLine.includes("\u001b") ? stripAnsi(rawLine) : rawLine;
		const line = withoutAnsi.includes("\r") ? withoutAnsi.replace(/\r/gu, "") : withoutAnsi;
		const index = this.totalLines++;
		const before = this.recent.slice(-FAILURE_CONTEXT_BEFORE);
		const selectedLine: SelectedLine = { index, text: line, priority: 1 };
		const passingOrProgress = isPassingLine(line) || isProgressLine(line);

		if (passingOrProgress) {
			this.collapsedPassingLines++;
			if (this.followFailureLines > 0) {
				this.select(index, line, 4);
				this.followFailureLines--;
			}
		} else if (isFailureLine(line)) {
			this.failureSignals++;
			for (const context of before) this.select(context.index, context.text, 4);
			this.select(index, line, 5);
			this.followFailureLines = FAILURE_CONTEXT_AFTER;
		} else if (isWarningLine(line)) {
			this.select(index, line, 4);
		} else {
			if (isSummaryLine(line)) this.select(index, line, 3);
			if (this.followFailureLines > 0) {
				this.select(index, line, 4);
				this.followFailureLines--;
			}
		}

		if (index < 2 && !passingOrProgress) this.select(index, line, 1);
		if (!passingOrProgress) {
			this.recent.push(selectedLine);
			if (this.recent.length > FINAL_CONTEXT_LINES) this.recent.shift();
		}
		this.currentHead = "";
		this.currentTail = "";
		this.currentChars = 0;
		this.hasOpenLine = false;
	}

	private select(index: number, line: string, priority: number): void {
		const existing = this.selected.get(index);
		if (existing) {
			if (priority > existing.priority) existing.priority = priority;
			return;
		}
		const selected: SelectedLine = { index, text: clipSelectedLine(line), priority };
		if (this.selected.size < MAX_SELECTED_LINES) {
			this.selected.set(index, selected);
			return;
		}

		let eviction: SelectedLine | undefined;
		for (const candidate of this.selected.values()) {
			if (!eviction || candidate.priority < eviction.priority) eviction = candidate;
		}
		if (eviction && eviction.priority < priority) {
			this.selected.delete(eviction.index);
			this.selected.set(index, selected);
		}
	}

	private renderSelected():
		| { content: string; outputLines: number; outputBytes: number; selectedLines: number }
		| undefined {
		const prioritized = [...this.selected.values()].sort(
			(left, right) => right.priority - left.priority || left.index - right.index,
		);
		const chosen: SelectedLine[] = [];
		let selectedBytes = 0;
		for (const line of prioritized) {
			const bytes = Buffer.byteLength(line.text, "utf-8") + 1;
			if (chosen.length > 0 && selectedBytes + bytes > MAX_SELECTED_BYTES) continue;
			chosen.push(line);
			selectedBytes += bytes;
		}
		if (chosen.length === 0) {
			const content = `[... ${this.totalLines} lines omitted ...]`;
			return {
				content,
				outputLines: 1,
				outputBytes: Buffer.byteLength(content, "utf-8"),
				selectedLines: 0,
			};
		}

		chosen.sort((left, right) => left.index - right.index);
		const output: string[] = [];
		let previousIndex = -1;
		for (const line of chosen) {
			const omitted = line.index - previousIndex - 1;
			if (omitted > 0) output.push(`[... ${omitted} lines omitted ...]`);
			output.push(line.text);
			previousIndex = line.index;
		}
		const trailing = this.totalLines - previousIndex - 1;
		if (trailing > 0) output.push(`[... ${trailing} lines omitted ...]`);

		const content = output.join("\n");
		return {
			content,
			outputLines: output.length,
			outputBytes: Buffer.byteLength(content, "utf-8"),
			selectedLines: chosen.length,
		};
	}
}

export function createShellOutputProjector(command: string): ShellOutputProjector | undefined {
	return isProjectableTestCommand(command) ? new ShellOutputProjector() : undefined;
}
