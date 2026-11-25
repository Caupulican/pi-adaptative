import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { createEmptyUsage } from "../usage.ts";
import { EventStream, STREAM_ENDED_WITHOUT_TERMINAL } from "./generic-event-stream.ts";
import { settleToolArguments } from "./json-parse.ts";

export { EventStream, STREAM_ENDED_WITHOUT_TERMINAL };

const lastPartials = new WeakMap<AssistantMessageEventStream, AssistantMessage>();

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done" || event.type === "error") {
			const message = event.type === "done" ? event.message : event.error;
			for (const block of message.content) if (block.type === "toolCall") settleToolArguments(block);
			lastPartials.set(this, message);
		} else {
			if (event.type === "toolcall_end") settleToolArguments(event.toolCall);
			lastPartials.set(this, event.partial);
		}
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined || this.isSettled()) {
			super.end(result);
			return;
		}
		const source = lastPartials.get(this);
		for (const block of source?.content ?? []) if (block.type === "toolCall") settleToolArguments(block);
		super.end({
			role: "assistant",
			content: source?.content ?? [],
			api: source?.api ?? "unknown",
			provider: source?.provider ?? "unknown",
			model: source?.model ?? "unknown",
			usage: source?.usage ?? createEmptyUsage(),
			stopReason: "error",
			errorMessage: STREAM_ENDED_WITHOUT_TERMINAL,
			timestamp: source?.timestamp ?? Date.now(),
			...(source?.responseId ? { responseId: source.responseId } : {}),
		});
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}

/**
 * Whether this stream event is the provider's FIRST produced content, i.e. the event that ends
 * time-to-first-token and starts generation.
 *
 * One definition, three consumers: the agent loop stamps `AssistantMessage.firstTokenAt` with it
 * (D1 observability), the model perf profile splits request time on it, and the interactive live
 * row marks the turn with it. A row that disagreed with the telemetry would be worse than no row,
 * so they all ask here. A zero-length delta is a protocol artifact, not a token.
 */
export function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	return (
		(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
		event.delta.length > 0
	);
}

/** The assistant message an event carries: final on `done`, the error message on `error`, else the partial. */
export function assistantMessageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}
