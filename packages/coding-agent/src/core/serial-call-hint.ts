import type { AssistantMessage } from "@caupulican/pi-ai";

/** Lookups that never depend on each other's results, so several can share one round. */
const INDEPENDENT_LOOKUPS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"repo_read",
	"code_outline",
	"zoom",
	"date",
]);

/** What every batching note starts with, so a reader of a stored result can tell the note from the tool's own output. */
export const SERIAL_CALL_HINT_PREFIX = "Note: the last ";

/** A hint after this many consecutive single-lookup rounds, then once more every `HINT_EVERY` rounds while the streak lasts. */
const STREAK_TO_HINT = 2;
const HINT_EVERY = 4;

/**
 * Counts consecutive rounds whose only call was an independent lookup and, from code alone, names the cost in the result
 * of the later ones: each such round re-sends the whole context for work that one round could have carried. The decision
 * is a count over the model's own message, never a judgment, and a streak ends at the first round that batches or
 * does something else.
 */
export class SerialCallHint {
	private message: AssistantMessage | undefined;
	private single = false;
	private streak = 0;

	/** The hint to append to this call's result, or undefined. Call once per finished tool call. */
	note(message: AssistantMessage, toolName: string): string | undefined {
		if (message !== this.message) {
			this.message = message;
			const calls = message.content.filter((block) => block.type === "toolCall");
			this.single = calls.length === 1 && INDEPENDENT_LOOKUPS.has(toolName);
			this.streak = this.single ? this.streak + 1 : 0;
		}
		if (!this.single || this.streak < STREAK_TO_HINT || (this.streak - STREAK_TO_HINT) % HINT_EVERY !== 0)
			return undefined;
		return `${SERIAL_CALL_HINT_PREFIX}${this.streak} rounds were single independent lookups. Put independent reads and searches in one message; each extra round re-sends the whole context.`;
	}
}
