import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";

/** Session record carrying the talker's last reply into a side trip's brief. */
export const SIDE_TRIP_CONTEXT_CUSTOM_TYPE = "side_trip_context";

/**
 * The small brief a side trip reads instead of the transcript (conversation-continuity design, Q9: a
 * subagent gets a brief orders of magnitude smaller than the talker's context): the talker's last reply as
 * plain text, then the current exchange, which is the owner message that opened the side trip with the
 * records riding it (the current task steps among them) and everything the side trip adds after it.
 * Nothing before the exchange is sent, so the free model never reads, and the talker's cache never forks
 * into, the transcript.
 */
export function sideTripBrief(messages: readonly AgentMessage[], exchangeStart: number): AgentMessage[] {
	const exchange = messages.slice(exchangeStart);
	let lastReply: string | undefined;
	for (let index = Math.min(exchangeStart, messages.length) - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) {
			lastReply = text;
			break;
		}
	}
	if (!lastReply) return exchange;
	const note = createCustomMessage(
		SIDE_TRIP_CONTEXT_CUSTOM_TYPE,
		`The conversation's last reply, for context:\n\n${lastReply}`,
		false,
		undefined,
		new Date(messages[exchangeStart]?.timestamp ?? 0).toISOString(),
	);
	return [note, ...exchange];
}
