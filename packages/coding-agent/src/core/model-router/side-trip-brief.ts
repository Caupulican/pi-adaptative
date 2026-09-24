import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import type { AgentMessage, AgentTool } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";

/** Name of the tool a side trip searches the conversation its brief omits with (see `sideTripHistoryTool`). */
export const SIDE_TRIP_HISTORY_TOOL_NAME = "conversation_history";

function historyLine(message: AgentMessage): { label: string; body: string } | undefined {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	const content = message.content;
	const text = (
		typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
	).trim();
	if (!text) return undefined;
	const who = message.role === "toolResult" ? `tool ${message.toolName}` : message.role;
	return { label: `[${who}] `, body: text };
}

const MAX_EXCERPT_BYTES = Math.floor(DEFAULT_MAX_BYTES / 4);
const MIN_EXCERPT_BYTES = 256;
const MAX_HEADING_QUERY_CHARS = 200;
const ELLIPSIS = "…";

function firstTermOffset(text: string, terms: readonly string[]): number | undefined {
	const lower = text.toLowerCase();
	let first: number | undefined;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at >= 0 && (first === undefined || at < first)) first = at;
	}
	if (first === undefined || lower.length === text.length) return first;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (text.slice(0, mid).toLowerCase().length < first) low = mid + 1;
		else high = mid;
	}
	return low;
}

function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf-8");
}

function boundedLabel(label: string, maxBytes: number): string {
	if (Buffer.byteLength(label) <= maxBytes) return label;
	const close = `${ELLIPSIS}] `;
	return `${utf8Prefix(label.slice(0, -2), maxBytes - Buffer.byteLength(close))}${close}`;
}

function excerptLine(fullLabel: string, text: string, terms: readonly string[], maxBytes: number): string {
	const label = boundedLabel(fullLabel, Math.floor(maxBytes / 4));
	const body = Buffer.from(text);
	const budget = maxBytes - Buffer.byteLength(label) - 2 * Buffer.byteLength(ELLIPSIS);
	const hit = firstTermOffset(text, terms);
	let start =
		hit === undefined
			? body.length - budget
			: Math.max(0, Buffer.byteLength(text.slice(0, hit)) - Math.floor(budget / 4));
	start = Math.max(0, Math.min(start, body.length - budget));
	let end = Math.min(body.length, start + budget);
	while (start < body.length && (body[start]! & 0xc0) === 0x80) start++;
	while (end < body.length && end > start && (body[end]! & 0xc0) === 0x80) end--;
	const window = body.subarray(start, end).toString("utf-8");
	return `${label}${start > 0 ? ELLIPSIS : ""}${window}${end < body.length ? ELLIPSIS : ""}`;
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
		readOnly: true,
		description:
			"Search the earlier conversation, which your brief does not show. Call it when the message refers to something said or done earlier.",
		parameters: Type.Object({ query: Type.String({ description: "What to look for" }) }),
		execute: async (_toolCallId, params) => {
			const query = String((params as { query?: unknown }).query ?? "").toLowerCase();
			const terms = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))];
			const lines = earlier().flatMap((message, index) => {
				const parts = historyLine(message);
				if (!parts) return [];
				const line = `${parts.label}${parts.body}`;
				const lower = line.toLowerCase();
				return [{ index, ...parts, line, score: terms.filter((term) => lower.includes(term)).length }];
			});
			const matched = lines.filter((entry) => entry.score > 0);
			// Most relevant first, then the most recent: what fits the bound is what the question needs.
			const ranked = (matched.length > 0 ? matched : lines).sort((a, b) => b.score - a.score || b.index - a.index);
			const shownQuery =
				query.length > MAX_HEADING_QUERY_CHARS ? `${query.slice(0, MAX_HEADING_QUERY_CHARS)}${ELLIPSIS}` : query;
			const heading =
				lines.length === 0
					? "The conversation before your brief is empty."
					: matched.length > 0
						? `Earlier messages mentioning "${shownQuery}":`
						: `No earlier message mentions "${shownQuery}"; the most recent earlier messages:`;
			const chosen: { index: number; line: string }[] = [];
			let excerpted = 0;
			let bytes = Buffer.byteLength(heading);
			for (const entry of ranked) {
				const size = Buffer.byteLength(entry.line) + 1;
				if (bytes + size <= DEFAULT_MAX_BYTES) {
					chosen.push(entry);
					bytes += size;
					continue;
				}
				const room = Math.min(DEFAULT_MAX_BYTES - bytes - 1, MAX_EXCERPT_BYTES);
				if (room < MIN_EXCERPT_BYTES) continue;
				const line = excerptLine(entry.label, entry.body, entry.score > 0 ? terms : [], room);
				chosen.push({ index: entry.index, line });
				excerpted += 1;
				bytes += Buffer.byteLength(line) + 1;
			}
			chosen.sort((a, b) => a.index - b.index);
			const text = [heading, ...chosen.map((entry) => entry.line)].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { matched: matched.length, shown: chosen.length, excerpted },
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
