import type { AssistantMessage, ToolCall } from "@caupulican/pi-ai/types";
import { getToolExecutionKey } from "./tool-failure-memory.ts";

/** Consecutive identical non-empty units (lines or sentences) at or above this run count are degeneration. */
export const DEGENERATE_REPEATED_LINE_MIN = 4;

/** Mid-stream abort once a generation loop is already this long; cheaper than waiting for `done`. */
export const DEGENERATE_STREAM_ABORT_RUN = 8;

/** Shortest unit that may be an exact tiled status sentence (`Foo.Foo.` with no space). */
export const DEGENERATE_EXACT_REPEAT_MIN = 24;

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

function isProseTile(unit: string): boolean {
	return /[.!?]/.test(unit) || /\s/.test(unit);
}

/** Smallest power-of-two prose tile that repeats to `text` (`Foo.Foo.` / `Foo.`×4). */
export function exactTiledRepeat(text: string): { unit: string; times: number } | undefined {
	if (text.length < DEGENERATE_EXACT_REPEAT_MIN * 2) return undefined;
	let unit = text;
	let times = 1;
	while (unit.length >= DEGENERATE_EXACT_REPEAT_MIN * 2 && unit.length % 2 === 0) {
		const half = unit.length / 2;
		const next = unit.slice(0, half);
		if (!isProseTile(next) || next !== unit.slice(half)) break;
		unit = next;
		times *= 2;
	}
	return times > 1 ? { unit, times } : undefined;
}

/**
 * Collapse consecutive identical assistant lines, period-2 ABAB line runs, and the same
 * sentence repeated inside one paragraph. Session 01a0016f stored 551 copies of one
 * sentence as a single line; newline-only collapse cannot see that.
 * Session 01a00337 stored the same status sentence concatenated with no space (`Foo.Foo.`)
 * because Responses deltas replayed the full sentence; whitespace split cannot see that.
 */
export function collapseRepeatedLines(text: string): string {
	const tiled = exactTiledRepeat(text);
	const source = tiled ? tiled.unit : text;
	const lineCollapsed = collapseRepeatedUnits(source.split("\n"), "\n");
	return lineCollapsed
		.split("\n")
		.map((line) => {
			const lineTile = exactTiledRepeat(line);
			return collapseRepeatedUnits(splitSentences(lineTile ? lineTile.unit : line), " ");
		})
		.join("\n");
}

export function isDegenerateRepeatedText(text: string): boolean {
	return collapseRepeatedLines(text) !== text;
}

export function shouldAbortDegenerateStream(text: string): boolean {
	if (text.length < 400) return false;
	const tiled = exactTiledRepeat(text);
	if (tiled && tiled.times >= DEGENERATE_STREAM_ABORT_RUN) return true;
	const sentences = splitSentences(text);
	if (maxRepeatedUnitRun(sentences) >= DEGENERATE_STREAM_ABORT_RUN) return true;
	return maxRepeatedUnitRun(text.split("\n")) >= DEGENERATE_STREAM_ABORT_RUN;
}

const collapsedDegenerateMessages = new WeakSet<AssistantMessage>();

function toolCallExecutionKey(block: ToolCall): string {
	return getToolExecutionKey(block.name, block.arguments);
}

export function collapseDegenerateAssistantMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const seenText = new Set<string>();
	const seenToolCalls = new Set<string>();
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "toolCall") {
			const key = toolCallExecutionKey(block);
			if (seenToolCalls.has(key)) {
				changed = true;
				continue;
			}
			seenToolCalls.add(key);
			content.push(block);
			continue;
		}
		if (block.type !== "text") {
			content.push(block);
			continue;
		}
		const collapsed = collapseRepeatedLines(block.text);
		if (collapsed !== block.text) changed = true;
		if (collapsed.trim() !== "" && seenText.has(collapsed)) {
			changed = true;
			continue;
		}
		if (collapsed.trim() !== "") seenText.add(collapsed);
		content.push(collapsed === block.text ? block : { ...block, text: collapsed });
	}
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
