import type { AssistantMessageEvent } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session-contracts.ts";

// JSON escaping can expand one input byte to six (`\u0000`), so this keeps the complete record below 50 KiB.
const MAX_STREAM_DELTA_BYTES = 7 * 1024;

function boundedDelta(delta: string): { delta: string; deltaBytes?: number; deltaTruncated?: true } {
	const deltaBytes = Buffer.byteLength(delta, "utf8");
	if (deltaBytes <= MAX_STREAM_DELTA_BYTES) return { delta };
	const bytes = Buffer.from(delta, "utf8");
	let end = MAX_STREAM_DELTA_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { delta: bytes.subarray(0, end).toString("utf8"), deltaBytes, deltaTruncated: true };
}

function projectAssistantEvent(event: AssistantMessageEvent): object {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return { type: event.type, contentIndex: event.contentIndex, ...boundedDelta(event.delta) };
		case "text_start":
		case "text_end":
		case "thinking_start":
		case "thinking_end":
		case "toolcall_end":
			return { type: event.type, contentIndex: event.contentIndex };
		case "toolcall_start": {
			const block = event.partial.content[event.contentIndex];
			if (block?.type !== "toolCall") {
				throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
			}
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				id: block.id,
				toolName: block.name,
			};
		}
		case "done":
		case "error":
			return { type: event.type, reason: event.reason };
		case "start":
			return { type: event.type };
	}
}

/** Project one session event onto the bounded JSON streaming wire contract. */
export function projectSessionEventForJson(event: AgentSessionEvent): object {
	if (event.type !== "message_update" || event.message.role !== "assistant") return event;
	return {
		type: event.type,
		message: { ...event.message, content: [] },
		assistantMessageEvent: projectAssistantEvent(event.assistantMessageEvent),
		accumulatedContentOmitted: true,
	};
}
