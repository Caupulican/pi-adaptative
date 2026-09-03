/**
 * Generic output cleaning that applies to every command and every tool that emits text: it removes
 * what a terminal would never have shown as information and collapses repetition, without knowing
 * anything about the program. Every step is deterministic and keeps the output readable as a shorter
 * version of the real one:
 *
 * - ANSI escape sequences (colors, cursor moves) are stripped.
 * - Carriage-return progress frames are resolved with terminal overwrite semantics: each `\r`
 *   segment overwrites the line from column 0, so only what the terminal would have shown remains.
 * - Trailing whitespace goes; runs of blank lines collapse to one.
 * - Consecutive identical lines collapse to one copy plus `[line repeated N times]`.
 *
 * Nothing is dropped that the model could need to act: every distinct line survives verbatim, so an
 * `edit` anchored on a printed line still matches.
 */
import { stripAnsi } from "../../utils/ansi.ts";
import type { OutputReductionLevel } from "./output-reduction.ts";

export interface GenericReduction {
	text: string;
	/** Lines removed: collapsed duplicates, blank-run surplus. */
	omittedLines: number;
	/** True when any byte changed (ANSI, frames, whitespace included), even if no line was dropped. */
	changed: boolean;
}

/** Repeat threshold before consecutive identical lines collapse, by level. */
const REPEAT_THRESHOLD: Record<OutputReductionLevel, number> = { standard: 3, compact: 2 };

/** Apply `\r` overwrite semantics within one physical line (no `\n` inside). */
export function resolveCarriageReturns(line: string): string {
	if (!line.includes("\r")) return line;
	let shown = "";
	for (const segment of line.split("\r")) {
		if (segment.length >= shown.length) shown = segment;
		else shown = segment + shown.slice(segment.length);
	}
	return shown;
}

export function reduceGenericOutput(text: string, level: OutputReductionLevel = "standard"): GenericReduction {
	if (text.length === 0) return { text, omittedLines: 0, changed: false };
	const hadTrailingNewline = text.endsWith("\n");
	const source = stripAnsi(text.replace(/\r\n/g, "\n"));
	const rawLines = source.split("\n");
	if (hadTrailingNewline) rawLines.pop();
	const threshold = REPEAT_THRESHOLD[level];
	const out: string[] = [];
	let omitted = 0;
	let previous: string | undefined;
	let repeats = 0;
	const flushRepeats = () => {
		if (repeats >= threshold) {
			out.push(`[line repeated ${repeats} times]`);
			omitted += repeats - 1;
		} else {
			for (let index = 1; index < repeats; index++) out.push(previous as string);
		}
		repeats = 0;
	};
	for (const rawLine of rawLines) {
		const line = resolveCarriageReturns(rawLine).trimEnd();
		if (line.length === 0) {
			if (previous !== undefined && previous.length > 0) flushRepeats();
			if (previous === "") {
				omitted++;
				continue;
			}
			out.push(line);
			previous = line;
			repeats = 0;
			continue;
		}
		if (line === previous) {
			repeats++;
			continue;
		}
		if (previous !== undefined && previous.length > 0) flushRepeats();
		out.push(line);
		previous = line;
		repeats = 1;
	}
	if (previous !== undefined && previous.length > 0) flushRepeats();
	let reduced = out.join("\n");
	if (hadTrailingNewline && reduced.length > 0) reduced += "\n";
	return { text: reduced, omittedLines: omitted, changed: reduced !== text };
}
