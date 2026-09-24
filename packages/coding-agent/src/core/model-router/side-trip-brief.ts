import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage, AgentTool } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";

/** Name of the tool a side trip calls to hand its message to the talker (see `SIDE_TRIP_HAND_BACK_TOOL`). */
export const SIDE_TRIP_HAND_BACK_TOOL_NAME = "hand_to_talker";

/**
 * The side trip's way back to the talker. The deterministic classifier judges a message small from its
 * wording alone, but only the model reading the brief can tell whether the brief answers it. Calling this
 * tool is a side-trip escalation (`ModelRouterController.maybeEscalateToolCall`): the side trip's turn is
 * discarded and the message reruns on the talker, whose cache holds the conversation.
 */
export const SIDE_TRIP_HAND_BACK_TOOL: AgentTool = {
	name: SIDE_TRIP_HAND_BACK_TOOL_NAME,
	label: "Hand to talker",
	description:
		"Hand this message to the conversation's main model. Call it, and nothing else, when answering needs earlier conversation that your brief does not show.",
	parameters: Type.Object({}),
	execute: async () => {
		throw new Error(`${SIDE_TRIP_HAND_BACK_TOOL_NAME} is handled by the model router before execution`);
	},
};

/** Session record carrying the talker's last reply into a side trip's brief. */
export const SIDE_TRIP_CONTEXT_CUSTOM_TYPE = "side_trip_context";

/**
 * The small brief a side trip reads instead of the transcript (conversation-continuity design, Q9: a
 * subagent gets a brief orders of magnitude smaller than the talker's context): a note saying the earlier
 * conversation is not shown, with the talker's last reply as plain text, then the current exchange, which is the owner message that opened the side trip with the
 * records riding it (the current task steps among them) and everything the side trip adds after it.
 * Nothing before the exchange is sent, so the free model never reads, and the talker's cache never forks
 * into, the transcript.
 */
export function sideTripBrief(messages: readonly AgentMessage[], exchangeStart: number): AgentMessage[] {
	const exchange = messages.slice(exchangeStart);
	let lastReply: string | undefined;
	for (let index = Math.min(exchangeStart, messages.length) - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) {
			lastReply = text;
			break;
		}
	}
	// Nothing before the exchange: the brief is the whole conversation.
	if (exchangeStart <= 0) return exchange;
	// Earlier conversation exists but is not sent; the note says so, so the side trip hands a message
	// that needs it to the talker instead of answering as if the conversation had just begun.
	const shown = lastReply ? ` Its last reply was:\n\n${lastReply}\n\n` : " ";
	const note = createCustomMessage(
		SIDE_TRIP_CONTEXT_CUSTOM_TYPE,
		`You are answering one owner message from a brief: the conversation before it is not shown here.${shown}If this message needs anything earlier, call ${SIDE_TRIP_HAND_BACK_TOOL_NAME} instead of answering.`,
		false,
		undefined,
		new Date(messages[exchangeStart]?.timestamp ?? 0).toISOString(),
	);
	return [note, ...exchange];
}
