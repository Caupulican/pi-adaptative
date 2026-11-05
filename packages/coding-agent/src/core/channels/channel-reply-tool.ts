import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { operationTextResult as result } from "../tools/operation-result.ts";
import { digest } from "./channel-journal.ts";
import { CHANNEL_REPLY_TOOL_NAME } from "./channel-tool-names.ts";
import type { SessionChannels } from "./session-channels.ts";

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("send"), Type.Literal("dismiss")], {
			description: "list: the reply drafts waiting for the owner. send / dismiss: release or discard one draft.",
		}),
		draft: Type.Optional(Type.String({ maxLength: 64, description: "send / dismiss: the draft id from list." })),
	},
	{ additionalProperties: false },
);

/**
 * The owner's release of channel replies. A turn a channel message started answers into a draft unless the owner set
 * `replyMode: "auto"`; this tool lists the drafts and sends one to the conversation it answers, or discards it. A run
 * carrying a third party's words cannot call it (`ownerOnlyToolCallReason`).
 */
export function createChannelReplyToolDefinition(channels: SessionChannels): ToolDefinition {
	return defineTool({
		name: CHANNEL_REPLY_TOOL_NAME,
		label: "Channel reply",
		description:
			"List, send or dismiss reply drafts for messages that arrived on a registered channel (a chat or mail transport). Call it only when the owner asks to send, change their mind about, or review a waiting channel reply. To send different words, dismiss the draft and tell the owner; this tool sends drafts exactly as kept.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (params.action === "list") {
				const drafts = channels.listDrafts();
				if (drafts.length === 0) return result("No reply drafts wait.");
				return result(
					drafts
						// A draft answers a third party's words, so it is read as data, never as instructions.
						.map(
							(draft) =>
								`${draft.id} on ${draft.channel} (${draft.reason}, ${draft.createdAt}):\n${wrapUntrustedText(draft.text, `channel-draft:${draft.channel}`, { nonce: digest(draft.text).slice(0, 32) })}`,
						)
						.join("\n\n"),
				);
			}
			const id = params.draft?.trim();
			if (!id) return result(`Nothing changed: ${params.action} needs the draft id from list.`, true);
			try {
				return result(await channels.settleDraft(id, params.action));
			} catch (error) {
				return result(`Nothing changed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	}) as ToolDefinition;
}
