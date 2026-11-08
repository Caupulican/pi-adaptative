import type { AssistantMessage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../kernel/index.ts";

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

/** True for a round whose only call is an independent lookup. */
function isSingleLookup(message: AssistantMessage): boolean {
	const calls = message.content.filter((block) => block.type === "toolCall");
	const [only] = calls;
	return calls.length === 1 && only !== undefined && INDEPENDENT_LOOKUPS.has(only.name);
}

/**
 * The hint to append to the result of `assistantMessage`'s single lookup call, or undefined. From code alone, it names
 * the cost of consecutive single-lookup rounds: each re-sends the whole context for work one round could have carried.
 * The decision is a count over the transcript, never a judgment. The streak is read from the messages themselves, so
 * it ends at the first earlier round that batched or did something else, at a text-only reply, and at any user turn: a
 * lookup in a later turn never inherits the rounds of an earlier one.
 */
export function serialCallHint(
	messages: readonly AgentMessage[],
	assistantMessage: AssistantMessage,
): string | undefined {
	if (!isSingleLookup(assistantMessage)) return undefined;
	let streak = 1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message === assistantMessage || message.role === "toolResult") continue;
		if (message.role !== "assistant" || !isSingleLookup(message)) break;
		streak++;
	}
	if (streak < STREAK_TO_HINT || (streak - STREAK_TO_HINT) % HINT_EVERY !== 0) return undefined;
	return `${SERIAL_CALL_HINT_PREFIX}${streak} rounds were single independent lookups. Put independent reads and searches in one message; each extra round re-sends the whole context.`;
}
