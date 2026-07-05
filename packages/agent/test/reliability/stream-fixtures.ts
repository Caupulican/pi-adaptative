import type { AssistantMessage, AssistantMessageEvent, StopReason } from "@caupulican/pi-ai";

/**
 * Minimal AssistantMessage skeleton, shaped the same way providers seed `output`
 * before streaming (see e.g. packages/ai/src/providers/anthropic.ts's `streamAnthropic`).
 */
function baseAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A minimal "text_start" event, shaped like a real provider's first streamed event. */
export function makeTextStartEvent(): AssistantMessageEvent {
	return { type: "text_start", contentIndex: 0, partial: baseAssistantMessage() };
}

/** A minimal "start" event: connected, but no content blocks yet (prefill/queue phase). */
export function makeStartEvent(): AssistantMessageEvent {
	return { type: "start", partial: baseAssistantMessage() };
}

/** A thinking delta: the latest content block is a thinking block (quiet phase). */
export function makeThinkingDeltaEvent(): AssistantMessageEvent {
	const partial = baseAssistantMessage();
	partial.content = [{ type: "thinking", thinking: "…" }];
	return { type: "thinking_delta", contentIndex: 0, delta: "…", partial };
}

/** A text delta: the latest content block is text (active phase — content is flowing). */
export function makeTextDeltaEvent(): AssistantMessageEvent {
	const partial = baseAssistantMessage();
	partial.content = [{ type: "text", text: "…" }];
	return { type: "text_delta", contentIndex: 0, delta: "…", partial };
}

/**
 * A minimal final AssistantMessage for a given stop reason, shaped like the message
 * providers construct on completion/abort/error (see anthropic.ts's catch block).
 */
export function makeErrorAssistantMessage(stopReason: StopReason, errorMessage?: string): AssistantMessage {
	return { ...baseAssistantMessage(), stopReason, errorMessage };
}
