import type { ToolResultMessage } from "@caupulican/pi-ai";
import { isImmutableHistoryMessage } from "../../kernel/message-revision.ts";
import { CURATION_RELEVANCE_CONTENT_MAX_CHARS } from "./brain-curator.ts";
import { sliceContextVisibilityExcerpt } from "./context-query-visibility.ts";

export function getToolResultArtifactId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

function toolResultTextParts(message: ToolResultMessage): string[] {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts;
}

export function getToolResultText(message: ToolResultMessage): string {
	return toolResultTextParts(message).join("\n");
}

interface ToolResultPolicyText {
	readonly originalChars: number;
	readonly excerpt: string;
}

const policyTextByMessage = new WeakMap<ToolResultMessage, ToolResultPolicyText>();

/** Measure the joined text and retain only the bounded evidence that curation actually reads. */
export function getToolResultPolicyText(message: ToolResultMessage): ToolResultPolicyText {
	const cached = policyTextByMessage.get(message);
	if (cached) return cached;
	const parts = toolResultTextParts(message);
	let originalChars = Math.max(0, parts.length - 1);
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		// Match Array.join conversion even for malformed extension content.
		const text = typeof part === "string" ? part : [part].join("");
		parts[index] = text;
		originalChars += text.length;
	}
	const excerpt = sliceContextVisibilityExcerpt(originalChars, CURATION_RELEVANCE_CONTENT_MAX_CHARS, (start, end) => {
		const chunks: string[] = [];
		let offset = 0;
		for (const part of parts) {
			if (offset >= end) break;
			const partEnd = offset + part.length;
			if (partEnd > start) chunks.push(part.slice(Math.max(0, start - offset), end - offset));
			if (partEnd >= start && partEnd < end && partEnd < originalChars) chunks.push("\n");
			offset = partEnd + 1;
		}
		return chunks.join("");
	});
	const measured = { originalChars, excerpt };
	if (isImmutableHistoryMessage(message)) policyTextByMessage.set(message, Object.freeze(measured));
	return measured;
}

export function isPromptPolicyEnforced(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	return (details as { promptPolicy?: { enforced?: unknown } }).promptPolicy?.enforced === true;
}
