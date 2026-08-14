import type { AssistantMessage } from "@caupulican/pi-ai/types";

/** Consecutive identical non-empty units (lines or sentences) at or above this run count are degeneration. */
export const DEGENERATE_REPEATED_LINE_MIN = 4;

/** Mid-stream abort once a generation loop is already this long; cheaper than waiting for `done`. */
export const DEGENERATE_STREAM_ABORT_RUN = 8;

function collapseRepeatedUnits(units: readonly string[], joinWith: string): string {
	if (units.length < DEGENERATE_REPEATED_LINE_MIN) return units.join(joinWith);
	const out: string[] = [];
	let index = 0;
	while (index < units.length) {
		const unit = units[index];
		let run = 1;
		while (index + run < units.length && units[index + run] === unit) run++;
		if (unit.trim() !== "" && run >= DEGENERATE_REPEATED_LINE_MIN) {
			out.push(unit);
			index += run;
			continue;
		}
		if (index + 1 < units.length) {
			const next = units[index + 1];
			if (unit.trim() !== "" && next.trim() !== "" && unit !== next) {
				let pairs = 1;
				while (
					index + (pairs + 1) * 2 <= units.length &&
					units[index + pairs * 2] === unit &&
					units[index + pairs * 2 + 1] === next
				) {
					pairs++;
				}
				if (pairs >= DEGENERATE_REPEATED_LINE_MIN) {
					out.push(unit, next);
					index += pairs * 2;
					continue;
				}
			}
		}
		out.push(unit);
		index++;
	}
	return out.join(joinWith);
}

function maxRepeatedUnitRun(units: readonly string[]): number {
	let maxRun = 1;
	let run = 1;
	for (let index = 1; index < units.length; index++) {
		if (units[index] === units[index - 1] && units[index].trim() !== "") {
			run++;
			if (run > maxRun) maxRun = run;
		} else {
			run = 1;
		}
	}
	return units.length === 0 ? 0 : maxRun;
}

function splitSentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+/);
}

/**
 * Collapse consecutive identical assistant lines, period-2 ABAB line runs, and the same
 * sentence repeated inside one paragraph. Session 01a0016f stored 551 copies of one
 * sentence as a single line; newline-only collapse cannot see that.
 */
export function collapseRepeatedLines(text: string): string {
	const lineCollapsed = collapseRepeatedUnits(text.split("\n"), "\n");
	return lineCollapsed
		.split("\n")
		.map((line) => collapseRepeatedUnits(splitSentences(line), " "))
		.join("\n");
}

export function isDegenerateRepeatedText(text: string): boolean {
	return collapseRepeatedLines(text) !== text;
}

export function shouldAbortDegenerateStream(text: string): boolean {
	if (text.length < 400) return false;
	const sentences = splitSentences(text);
	if (maxRepeatedUnitRun(sentences) >= DEGENERATE_STREAM_ABORT_RUN) return true;
	return maxRepeatedUnitRun(text.split("\n")) >= DEGENERATE_STREAM_ABORT_RUN;
}

const collapsedDegenerateMessages = new WeakSet<AssistantMessage>();

export function collapseDegenerateAssistantMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const collapsed = collapseRepeatedLines(block.text);
		if (collapsed === block.text) return block;
		changed = true;
		return { ...block, text: collapsed };
	});
	if (!changed) return message;
	const next = { ...message, content };
	collapsedDegenerateMessages.add(next);
	return next;
}

/** True when this message is (or was collapsed from) a generation loop. */
export function isCollapsedDegenerateAssistantMessage(message: AssistantMessage): boolean {
	return collapsedDegenerateMessages.has(message);
}

export function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
