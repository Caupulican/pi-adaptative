import type { AssistantMessage } from "@caupulican/pi-ai/types";
import type { AgentTool } from "./types.ts";

export const NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR = "native_tool_protocol_residue";
export const TOOL_FREE_RESPONSE_TOOL_CALL_ERROR = "tool_free_response_tool_call";

/**
 * Marks which lines fall inside a genuinely closed ```/~~~ fence (open and matching close both
 * present). A fence that never closes does not suppress anything: it is not treated as covering
 * the rest of the message, so real residue after malformed/truncated fencing is still scanned.
 */
function computeFencedLines(lines: readonly string[]): boolean[] {
	const fenced = new Array<boolean>(lines.length).fill(false);
	let openMarker: "```" | "~~~" | undefined;
	let openIndex = -1;
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (!(trimmed.startsWith("```") || trimmed.startsWith("~~~"))) continue;
		const marker = trimmed.slice(0, 3) as "```" | "~~~";
		if (!openMarker) {
			openMarker = marker;
			openIndex = index;
		} else if (openMarker === marker) {
			for (let i = openIndex; i <= index; i++) fenced[i] = true;
			openMarker = undefined;
			openIndex = -1;
		}
	}
	return fenced;
}

function isJsonPayload(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function findRenderedToolMarker(text: string, toolNames?: ReadonlySet<string>): string | undefined {
	const lines = text.split(/\r?\n/);
	const fenced = computeFencedLines(lines);
	for (let index = 0; index < lines.length; index++) {
		if (fenced[index]) continue;
		const trimmed = lines[index].trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) continue;
		const match = /^to=functions\.([A-Za-z][A-Za-z0-9_-]{0,63})\s+code$/.exec(trimmed);
		const toolName = match?.[1];
		if (!toolName || (toolNames && !toolNames.has(toolName))) continue;

		let payloadIndex = index + 1;
		while (payloadIndex < lines.length && lines[payloadIndex].trim() === "") payloadIndex++;
		const payload = lines[payloadIndex]?.trim();
		if (!payload || !(payload.startsWith("{") || payload.startsWith("["))) continue;
		if (!isJsonPayload(payload)) continue;

		// Genuine residue is the terminal content of the turn: a provider that rendered a real tool
		// call as plain text stops right there. Prose that merely quotes the marker syntax (this repo's
		// own docs/tests discuss it) keeps explaining afterward, so trailing content after the payload
		// is what tells a documentation example apart from an actual escaped tool call.
		let trailingIndex = payloadIndex + 1;
		while (trailingIndex < lines.length && lines[trailingIndex].trim() === "") trailingIndex++;
		if (trailingIndex < lines.length) continue;

		return toolName;
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

/**
 * A provider request with no tools must never leave a tool call in the transcript. Providers can
 * still return a native call or render their internal call syntax despite the empty tool surface,
 * so validate both shapes regardless of whether that tool was loaded in the surrounding run. The
 * provider response is retained as an explicit protocol error with no synthetic prose and no
 * executable call block.
 */
export function rejectToolCallsFromToolFreeResponse(message: AssistantMessage): AssistantMessage {
	if (message.stopReason === "error" || message.stopReason === "aborted") return message;
	const nativeToolCall = message.content.find((block) => block.type === "toolCall");
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const renderedToolName = text ? findRenderedToolMarker(text) : undefined;
	const toolName = nativeToolCall?.name ?? renderedToolName;
	if (!toolName) return message;
	return {
		...message,
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: `${TOOL_FREE_RESPONSE_TOOL_CALL_ERROR}: provider returned ${toolName} while tools were disabled`,
	};
}
