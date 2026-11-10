/**
 * How a print-mode run ended, decided from the last message that is not a host record.
 * Both output modes (text and json) use this one decision.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../kernel/types.ts";

export type PrintOutcome = { outcome: "completed" } | { outcome: "failed"; stopReason: string; error: string };

export const OUTPUT_LIMIT_ERROR = "The reply was cut off at the output limit.";

/** The reply: the last message that is not a host record (an owner-items or evidence record can land after it). */
export function selectReplyMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
	return messages.findLast((message) => message.role !== "custom");
}

export function decidePrintOutcome(lastMessage: AgentMessage | undefined): PrintOutcome {
	if (lastMessage?.role === "bashExecution") {
		if (lastMessage.cancelled || (lastMessage.exitCode !== undefined && lastMessage.exitCode !== 0)) {
			const state = lastMessage.cancelled ? "cancelled" : `exit code ${lastMessage.exitCode}`;
			return { outcome: "failed", stopReason: "error", error: `Command failed: ${state}` };
		}
		return { outcome: "completed" };
	}
	if (lastMessage?.role !== "assistant") return { outcome: "completed" };
	const assistant = lastMessage as AssistantMessage;
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		return {
			outcome: "failed",
			stopReason: assistant.stopReason,
			error: assistant.errorMessage || `Request ${assistant.stopReason}`,
		};
	}
	if (assistant.stopReason === "length") {
		const hasText = assistant.content.some((content) => content.type === "text" && content.text.trim() !== "");
		return {
			outcome: "failed",
			stopReason: "length",
			error: hasText ? OUTPUT_LIMIT_ERROR : `${OUTPUT_LIMIT_ERROR} Nothing was answered.`,
		};
	}
	return { outcome: "completed" };
}
