import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Message } from "@caupulican/pi-ai";

export type ModelRouterBufferedSessionMessage =
	| {
			kind: "message";
			message: Message;
	  }
	| {
			kind: "custom";
			message: Extract<AgentMessage, { role: "custom" }>;
	  };

export type ModelRouterSessionBuffer = {
	messages: ModelRouterBufferedSessionMessage[];
	/** True after the complete routed turn has been durably committed. */
	committed: boolean;
	/** True after the prompt prefix was durably committed before provider transport. */
	prefixCommitted: boolean;
	/** Number of AgentMessages (including custom messages) in the committed prefix, retained for live-suffix repair. */
	prefixMessageCount: number;
};

export function createModelRouterSessionBuffer(): ModelRouterSessionBuffer {
	return { messages: [], committed: false, prefixCommitted: false, prefixMessageCount: 0 };
}

export function bufferModelRouterSessionMessage(buffer: ModelRouterSessionBuffer, message: Message): void {
	buffer.messages.push({ kind: "message", message });
}

export function bufferModelRouterSessionCustomMessage(
	buffer: ModelRouterSessionBuffer,
	message: Extract<AgentMessage, { role: "custom" }>,
): void {
	buffer.messages.push({ kind: "custom", message });
}

export function flushModelRouterSessionBuffer(
	buffer: ModelRouterSessionBuffer,
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
): Map<AgentMessage, string> {
	if (buffer.committed) return new Map();
	const entryIds = appendBufferedMessages(buffer.messages, appendBatch);
	buffer.messages = [];
	buffer.committed = true;
	buffer.prefixCommitted = true;
	return entryIds;
}

/** Commit only the prompt prefix before provider transport; later assistant/tool messages remain buffered. */
export function flushModelRouterSessionBufferPrefix(
	buffer: ModelRouterSessionBuffer,
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
): Map<AgentMessage, string> {
	if (buffer.prefixCommitted) return new Map();
	const entries = buffer.messages;
	const entryIds = appendBufferedMessages(entries, appendBatch);
	buffer.messages = [];
	buffer.prefixCommitted = true;
	buffer.prefixMessageCount = entries.length;
	return entryIds;
}

function appendBufferedMessages(
	entries: readonly ModelRouterBufferedSessionMessage[],
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
): Map<AgentMessage, string> {
	if (entries.length === 0) return new Map();
	const ids = appendBatch(entries);
	if (ids.length !== entries.length) {
		throw new Error("Session message batch returned an unexpected entry count.");
	}
	const entryIds = new Map<AgentMessage, string>();
	for (let index = 0; index < entries.length; index += 1) {
		const id = ids[index];
		if (typeof id !== "string") throw new Error("Session message batch returned an invalid entry id.");
		entryIds.set(entries[index]!.message, id);
	}
	return entryIds;
}
