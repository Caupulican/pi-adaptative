import type { AssistantMessage } from "@caupulican/pi-ai/types";
import type { AgentTool } from "./types.ts";

export const NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR = "native_tool_protocol_residue";

function findRenderedToolMarker(text: string, toolNames: ReadonlySet<string>): string | undefined {
	const lines = text.split(/\r?\n/);
	let fence: "```" | "~~~" | undefined;
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			const marker = trimmed.slice(0, 3) as "```" | "~~~";
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;
		const match = /^to=functions\.([A-Za-z][A-Za-z0-9_-]{0,63})\s+code$/.exec(trimmed);
		const toolName = match?.[1];
		if (!toolName || !toolNames.has(toolName)) continue;
		for (let payloadIndex = index + 1; payloadIndex < lines.length; payloadIndex++) {
			const payload = lines[payloadIndex].trim();
			if (!payload) continue;
			if (payload.startsWith("{") || payload.startsWith("[")) return toolName;
			break;
		}
	}
	return undefined;
}

/**
 * Refuse provider-internal native tool markup that escaped as assistant text. The detector is
 * intentionally narrow: a loaded tool name, a standalone unfenced marker, and an adjacent JSON
 * payload are all required. Nothing is parsed or executed from the rendered text.
 */
export function rejectNativeToolProtocolResidue(
	message: AssistantMessage,
	tools: readonly AgentTool[],
	textToolProtocolActive: boolean,
): AssistantMessage {
	if (
		textToolProtocolActive ||
		message.stopReason === "error" ||
		message.stopReason === "aborted" ||
		message.content.some((block) => block.type === "toolCall")
	) {
		return message;
	}
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (!text) return message;
	const toolName = findRenderedToolMarker(text, new Set(tools.map((tool) => tool.name)));
	if (!toolName) return message;
	return {
		...message,
		content: [
			{
				type: "text",
				text: `Provider rendered a ${toolName} tool call as plain text. No operation was executed.`,
			},
		],
		stopReason: "error",
		errorMessage: `${NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR}: functions.${toolName} was rendered as text`,
	};
}
