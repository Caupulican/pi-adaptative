import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";

export function textContentPrefix(content: readonly unknown[], maxChars = Number.POSITIVE_INFINITY): string {
	const chunks: string[] = [];
	let length = 0;
	let found = false;
	for (const part of content) {
		if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "text") continue;
		const blockText = (part as { text?: unknown }).text;
		if (typeof blockText !== "string") continue;
		if (found) {
			if (length >= maxChars) return chunks.join("");
			chunks.push("\n");
			length++;
		} else {
			found = true;
		}
		const remaining = maxChars - length;
		if (remaining <= 0) return chunks.join("");
		if (blockText.length >= remaining) {
			chunks.push(blockText.slice(0, remaining));
			return chunks.join("");
		}
		chunks.push(blockText);
		length += blockText.length;
	}
	return chunks.join("");
}

/** Project the latest provider-visible user prompt without rebuilding earlier context. */
export function latestUserPromptText(messages: readonly AgentMessage[], maxChars = Number.POSITIVE_INFINITY): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") {
			return message.content.length > maxChars ? message.content.slice(0, maxChars) : message.content;
		}
		const text = textContentPrefix(message.content, maxChars);
		if (text.length > 0) return text;
	}
	return "";
}

/** Project the latest non-empty assistant response without copying or reversing session history. */
export function latestAssistantText(messages: readonly AgentMessage[]): string | undefined {
	let message: AssistantMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index];
		if (candidate?.role !== "assistant") continue;
		if (candidate.stopReason === "aborted" && candidate.content.length === 0) continue;
		message = candidate;
		break;
	}
	if (!message) return undefined;

	const chunks: string[] = [];
	for (const content of message.content) {
		if (content.type === "text") chunks.push(content.text);
	}
	return chunks.join("").trim() || undefined;
}
