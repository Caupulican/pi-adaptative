import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@caupulican/pi-ai";

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
};

export function createModelRouterSessionBuffer(): ModelRouterSessionBuffer {
	return { messages: [] };
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
	appendMessage: (message: Message) => void,
	appendCustomMessageEntry: (
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	) => void,
): void {
	for (const entry of buffer.messages) {
		if (entry.kind === "message") {
			appendMessage(entry.message);
		} else {
			appendCustomMessageEntry(
				entry.message.customType,
				entry.message.content,
				entry.message.display,
				entry.message.details,
			);
		}
	}
}
