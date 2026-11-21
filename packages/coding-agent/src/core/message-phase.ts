import type { AssistantMessage, TextContent } from "@caupulican/pi-ai";

import { isAssistantCommentary } from "../kernel/assistant-answer.ts";

/** User-facing prose, optionally including commentary; control payloads never become conversation. */
export function isAssistantDisplayText(content: TextContent, showCommentary = false): boolean {
	return !isAssistantCommentary(content) || (showCommentary && !isStructuredPayload(content.text.trim()));
}

/** Project prose commentary onto the bounded activity lane; structured control payloads stay inspector-only. */
export function latestAssistantCommentaryLabel(message: AssistantMessage): string | undefined {
	for (let index = message.content.length - 1; index >= 0; index--) {
		const block = message.content[index];
		if (block?.type !== "text" || !isAssistantCommentary(block)) continue;
		const normalized = block.text.replace(/\s+/g, " ").trim();
		if (!normalized || isStructuredPayload(normalized)) continue;
		return normalized;
	}
	return undefined;
}

function isStructuredPayload(value: string): boolean {
	if (!(value.startsWith("{") && value.endsWith("}")) && !(value.startsWith("[") && value.endsWith("]"))) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null;
	} catch {
		return false;
	}
}
