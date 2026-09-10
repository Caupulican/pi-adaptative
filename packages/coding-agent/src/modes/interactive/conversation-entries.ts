import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { isConversationMessage } from "./components/question-conversation.ts";

/**
 * The entries a "History hidden" placeholder can stand for. A fresh session already holds control
 * records (a model change, a reflection cue, goal context); counting those promised history that
 * did not exist, on every start. Only user and assistant turns (and the answered questions between
 * them) are history.
 */
export function countConversationEntries(entries: readonly SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && isConversationMessage(entry.message)) count++;
	}
	return count;
}
