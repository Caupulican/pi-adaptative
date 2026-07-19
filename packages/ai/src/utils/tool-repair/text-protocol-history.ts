import { joinTextContent } from "../../providers/transform-messages.ts";
import type { ToolCall, ToolResultMessage } from "../../types.ts";
import { formatVariantEnvelope, type TextToolProtocolVariant } from "./text-protocol.ts";

/**
 * Renders a prior text-protocol tool call as the assistant-visible history text, in the exact
 * dialect `variant` teaches (reusing {@link formatVariantEnvelope} so a phone model sees its own
 * call echoed back exactly as the primer taught it to speak - the round-trip invariant this
 * module is gated on: `parseTextToolCalls(renderTextProtocolAssistantCall(call, variant), tools)`
 * must recover the SAME name+arguments).
 */
export function renderTextProtocolAssistantCall(toolCall: ToolCall, variant: TextToolProtocolVariant): string {
	return formatVariantEnvelope(variant, toolCall.name, JSON.stringify(toolCall.arguments ?? {}));
}

/**
 * Renders a tool result as plain text a text-protocol (phone) model reads as a user turn. The
 * protocol has no `tool_call_id`; the caller places this immediately after the echoed call it
 * answers (§2.3: conversation ORDER + tool name is the only linkage a phone model has).
 */
export function renderTextProtocolToolResult(toolResult: ToolResultMessage): string {
	const text = joinTextContent(toolResult.content);
	return `Tool result (${toolResult.toolName}):\n${text.length > 0 ? text : "(see attached image)"}`;
}
