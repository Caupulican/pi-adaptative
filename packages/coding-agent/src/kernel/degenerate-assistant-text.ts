import type { AssistantMessage } from "@caupulican/pi-ai/types";

/** Consecutive identical non-empty units (lines or sentences) at or above this run count are degeneration. */
export const DEGENERATE_REPEATED_LINE_MIN = 4;

/** Mid-stream abort once a generation loop is already this long; cheaper than waiting for `done`. */
export const DEGENERATE_STREAM_ABORT_RUN = 8;

/** Shortest unit that may be an exact tiled status sentence (`Foo.Foo.` with no space). */
export const DEGENERATE_EXACT_REPEAT_MIN = 24;
const DEGENERATE_STREAM_MIN_CHARS = 400;
const SENTENCE_BREAKS = /(?<=[.!?])\s+/g;
const LINE_BREAKS = /\n/g;

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

function hasRepeatedUnitRun(text: string, separator: RegExp): boolean {
	separator.lastIndex = 0;
	let start = 0;
	let previousStart = 0;
	let previousLength = -1;
	let run = 0;
	while (true) {
		const match = separator.exec(text);
		const end = match?.index ?? text.length;
		const length = end - start;
		run =
			length === previousLength && text.startsWith(text.slice(previousStart, previousStart + length), start)
				? run + 1
				: 1;
		if (run === DEGENERATE_STREAM_ABORT_RUN && text.slice(start, end).trim() !== "") return true;
		if (!match) return false;
		previousStart = start;
		previousLength = length;
		start = separator.lastIndex;
	}
}

function splitSentences(text: string): string[] {
	return text.split(SENTENCE_BREAKS);
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
	if (text.length < DEGENERATE_STREAM_MIN_CHARS) return false;
	if (text.length % DEGENERATE_STREAM_ABORT_RUN === 0) {
		const tiled = exactTiledRepeat(text);
		if (tiled && tiled.times >= DEGENERATE_STREAM_ABORT_RUN) return true;
	}
	return hasRepeatedUnitRun(text, SENTENCE_BREAKS) || hasRepeatedUnitRun(text, LINE_BREAKS);
}

/** Keeps only the preceding prose fragments. Progress events can carry unchanged or replaced content. */
export class StreamingDegenerationDetector {
	private previous: string[] = [];
	private scratch: string[] = [];
	private result = false;

	check(message: AssistantMessage): boolean {
		const current = this.scratch;
		current.length = 0;
		let length = 0;
		let unchanged = true;
		for (const block of message.content) {
			if (block.type === "toolCall") return false;
			const text =
				block.type === "text"
					? block.text
					: block.type === "thinking" && !block.redacted
						? block.thinking
						: undefined;
			if (text === undefined) continue;
			if (unchanged) unchanged = this.previous[current.length] === text;
			if (current.length > 0) length++;
			length += text.length;
			current.push(text);
		}
		if (unchanged && current.length === this.previous.length) return this.result;
		this.scratch = this.previous;
		this.scratch.length = 0;
		this.previous = current;
		this.result =
			length >= DEGENERATE_STREAM_MIN_CHARS &&
			shouldAbortDegenerateStream(current.length === 1 ? current[0]! : current.join("\n"));
		return this.result;
	}
}

const collapsedDegenerateMessages = new WeakSet<AssistantMessage>();

export function collapseDegenerateAssistantMessage(
	message: AssistantMessage,
	previousAssistant?: AssistantMessage,
	options?: { allowToolFreeComparison?: boolean },
): AssistantMessage {
	const seenText = new Set<string>();
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type !== "text" && block.type !== "thinking") {
			content.push(block);
			continue;
		}
		const isThinking = block.type === "thinking";
		const source = isThinking ? block.thinking : block.text;
		const canRewriteThinking = !isThinking || canRewriteThinkingBlock(message, block);
		if (!canRewriteThinking) {
			content.push(block);
			continue;
		}
		const collapsed = collapseRepeatedLines(source);
		if (!isThinking && collapsed.trim() !== "" && seenText.has(collapsed)) continue;
		if (!isThinking && collapsed.trim() !== "") seenText.add(collapsed);
		content.push(
			collapsed === source ? block : isThinking ? { ...block, thinking: collapsed } : { ...block, text: collapsed },
		);
	}
	const messageHasToolCall = message.content.some((block) => block.type === "toolCall");
	const previousHasToolCall = previousAssistant?.content.some((block) => block.type === "toolCall") ?? false;
	const compareToolFreeClosingTurn = options?.allowToolFreeComparison && !messageHasToolCall;
	if (previousAssistant && (messageHasToolCall || compareToolFreeClosingTurn) && previousHasToolCall) {
		const previousThinking = previousAssistant.content.filter(
			(block): block is Extract<AssistantMessage["content"][number], { type: "thinking" }> =>
				block.type === "thinking" && canRewriteThinkingBlock(previousAssistant, block),
		);
		const repeatedThinking = new Set(
			previousThinking.map((block) => `${block.thinkingSignature ?? ""}\u0000${block.thinking}`),
		);
		const crossTurnContent = content.filter((block) => {
			if (block.type !== "thinking" || !canRewriteThinkingBlock(message, block)) return true;
			const key = `${block.thinkingSignature ?? ""}\u0000${block.thinking}`;
			if (!repeatedThinking.has(key)) return true;
			return false;
		});
		if (crossTurnContent.length !== content.length) return markCollapsedMessage(message, crossTurnContent);
	}
	return markCollapsedMessage(message, content);
}

function canRewriteThinkingBlock(
	message: AssistantMessage,
	block: Extract<AssistantMessage["content"][number], { type: "thinking" }>,
): boolean {
	return (
		!block.redacted &&
		(!block.thinkingSignature ||
			message.api === "openai-completions" ||
			message.api === "openai-responses" ||
			message.api === "azure-openai-responses" ||
			message.api === "openai-codex-responses")
	);
}

function markCollapsedMessage(message: AssistantMessage, content: AssistantMessage["content"]): AssistantMessage {
	const changed =
		content.length !== message.content.length || content.some((block, index) => block !== message.content[index]);
	if (!changed) return message;
	const next = { ...message, content };
	collapsedDegenerateMessages.add(next);
	return next;
}

/** True when this message is (or was collapsed from) a generation loop. */
export function isCollapsedDegenerateAssistantMessage(message: AssistantMessage): boolean {
	return collapsedDegenerateMessages.has(message);
}
