/**
 * Chooses where a reload paints its tail slice first, so a long session shows the newest messages on
 * the first frame and older messages follow behind them without splitting a tool call from its result.
 */

import type { AgentMessage } from "../../kernel/types.ts";

/**
 * Where the immediately-painted tail slice starts, in one pass over the session.
 *
 * A boundary is tool-pair safe when no call made before it is answered after it: for every call id we
 * know the index of its last result, and one running maximum says whether any call seen so far is
 * still open past the candidate. Among safe boundaries it prefers the latest `user` start, so a slice
 * never begins inside an assistant turn or an action transcript, and falls back to the latest safe
 * boundary. An answered-nowhere call therefore costs nothing: only calls with a result can hold a
 * boundary open, so old orphaned calls cannot force the whole history into the tail.
 */
export function findCleanHistoryPartition(messages: readonly AgentMessage[], targetTailCount = 60): number {
	const limit = Math.max(0, messages.length - targetTailCount);
	const resultIndices = new Map<string, number[]>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		const known = resultIndices.get(message.toolCallId);
		if (known) known.push(index);
		else resultIndices.set(message.toolCallId, [index]);
	}
	const windowStart = Math.max(0, limit - 80);
	let furthestResult = -1;
	let latestSafe = 0;
	let preferred = -1;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				// Each call pairs with its FIRST result after it: a repeated id from an earlier turn must
				// not drag this call's boundary forward to a later turn's result.
				const resultAt = firstResultAfter(resultIndices.get(part.id), index);
				if (resultAt !== -1 && resultAt > furthestResult) furthestResult = resultAt;
			}
		}
		const candidate = index + 1;
		if (furthestResult >= candidate || candidate > limit) continue;
		latestSafe = candidate;
		if (candidate >= windowStart && messages[candidate]?.role === "user") preferred = candidate;
	}
	return preferred >= 0 ? preferred : latestSafe;
}

/** Index of the first result recorded after `callIndex`, or -1 when the call is still unanswered there. */
function firstResultAfter(indices: readonly number[] | undefined, callIndex: number): number {
	if (!indices) return -1;
	for (const index of indices) {
		if (index > callIndex) return index;
	}
	return -1;
}
