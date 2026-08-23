import type { AssistantMessage, TextContent } from "@caupulican/pi-ai";

const MAX_TEXT_SIGNATURE_CHARS = 4096;

export type AssistantTextPhase = "commentary" | "final_answer";

/** Read OpenAI Responses phase metadata without trusting arbitrary signature JSON shapes. */
export function assistantTextPhase(content: Pick<TextContent, "textSignature">): AssistantTextPhase | undefined {
	const signature = content.textSignature;
	if (!signature?.startsWith("{") || signature.length > MAX_TEXT_SIGNATURE_CHARS) return undefined;
	try {
		const parsed: unknown = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(parsed, "phase");
		if (!descriptor || !("value" in descriptor)) return undefined;
		return descriptor.value === "commentary" || descriptor.value === "final_answer" ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

export function isAssistantCommentary(content: Pick<TextContent, "textSignature">): boolean {
	return assistantTextPhase(content) === "commentary";
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
