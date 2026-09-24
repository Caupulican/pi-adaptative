import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import type { AgentMessage, AgentTool } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";

/** Name of the tool a side trip searches the conversation its brief omits with (see `sideTripHistoryTool`). */
export const SIDE_TRIP_HISTORY_TOOL_NAME = "conversation_history";

function historyLine(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	const content = message.content;
	const text = (
		typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
	).trim();
	if (!text) return undefined;
	const who = message.role === "toolResult" ? `tool ${message.toolName}` : message.role;
	return `[${who}] ${text}`;
}

/**
 * The side trip's read-only view of the conversation before its brief. The deterministic classifier
 * judges a message small from its wording, but only the model reading the brief can tell that it needs
 * something said earlier; measured on the free side-trip model, it looks the conversation up when it can
 * (8 of 8) where it would not hand the message back (0 of 28), and small talk never looks. Earlier
 * messages are ranked by how many of the query's words they contain and returned in conversation order
 * within the shared tool-output bound; with no match, the most recent earlier messages are returned.
 */
export function sideTripHistoryTool(earlier: () => readonly AgentMessage[]): AgentTool {
	return {
		name: SIDE_TRIP_HISTORY_TOOL_NAME,
		label: "Conversation history",
		description:
			"Search the earlier conversation, which your brief does not show. Call it when the message refers to something said or done earlier.",
		parameters: Type.Object({ query: Type.String({ description: "What to look for" }) }),
		execute: async (_toolCallId, params) => {
			const query = String((params as { query?: unknown }).query ?? "").toLowerCase();
			const terms = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))];
			const lines = earlier().flatMap((message, index) => {
				const line = historyLine(message);
				if (!line) return [];
				const lower = line.toLowerCase();
				return [{ index, line, score: terms.filter((term) => lower.includes(term)).length }];
			});
			const matched = lines.filter((entry) => entry.score > 0);
			// Most relevant first, then the most recent: what fits the bound is what the question needs.
			const ranked = (matched.length > 0 ? matched : lines).sort((a, b) => b.score - a.score || b.index - a.index);
			const chosen: typeof ranked = [];
			let bytes = 0;
			for (const entry of ranked) {
				const size = Buffer.byteLength(entry.line) + 1;
				if (bytes + size > DEFAULT_MAX_BYTES) continue;
				chosen.push(entry);
				bytes += size;
			}
			chosen.sort((a, b) => a.index - b.index);
			const heading =
				lines.length === 0
					? "The conversation before your brief is empty."
					: matched.length > 0
						? `Earlier messages mentioning "${query}":`
						: `No earlier message mentions "${query}"; the most recent earlier messages:`;
			const text = [heading, ...chosen.map((entry) => entry.line)].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { matched: matched.length, shown: chosen.length },
			};
		},
	};
}

/** Session record carrying the talker's last reply into a side trip's brief. */
export const SIDE_TRIP_CONTEXT_CUSTOM_TYPE = "side_trip_context";

/**
 * The small brief a side trip reads instead of the transcript (conversation-continuity design, Q9: a
 * subagent gets a brief orders of magnitude smaller than the talker's context): a note saying the earlier
 * conversation is not shown, with the talker's last reply as plain text, then the current exchange, which is the owner message that opened the side trip with the
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
	// Nothing before the exchange: the brief is the whole conversation.
	if (exchangeStart <= 0) return exchange;
	// Earlier conversation exists but is not sent; the note says so, so the side trip hands a message
	// that needs it to the talker instead of answering as if the conversation had just begun.
	const shown = lastReply ? ` Its last reply was:\n\n${lastReply}\n\n` : " ";
	const note = createCustomMessage(
		SIDE_TRIP_CONTEXT_CUSTOM_TYPE,
		`You are answering one owner message from a brief: the conversation before it is not shown here.${shown}If this message needs anything earlier, search it with ${SIDE_TRIP_HISTORY_TOOL_NAME}.`,
		false,
		undefined,
		new Date(messages[exchangeStart]?.timestamp ?? 0).toISOString(),
	);
	return [note, ...exchange];
}
