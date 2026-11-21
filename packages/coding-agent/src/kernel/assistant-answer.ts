/** Assistant answer text for terminal results, including legacy responses without phase metadata. */
import type { AssistantMessage, TextContent } from "@caupulican/pi-ai";

const MAX_TEXT_SIGNATURE_CHARS = 4096;

type AssistantTextPhase = "commentary" | "final_answer";

/** Read OpenAI Responses phase metadata without trusting arbitrary signature JSON shapes. */
function assistantTextPhase(content: Pick<TextContent, "textSignature">): AssistantTextPhase | undefined {
	const signature = content.textSignature;
	if (typeof signature !== "string" || !signature.startsWith("{") || signature.length > MAX_TEXT_SIGNATURE_CHARS)
		return undefined;
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

export function assistantAnswerTextParts(message: AssistantMessage | undefined): string[] {
	const content = message?.content;
	if (typeof content === "string") return [content];
	const parts: string[] = [];
	for (const block of content ?? []) {
		if (block.type === "text" && !isAssistantCommentary(block)) parts.push(block.text);
	}
	return parts;
}

export function assistantResultText(message: AssistantMessage): string {
	return assistantAnswerTextParts(message).join("");
}
