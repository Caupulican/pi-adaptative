/**
 * The words a bot's chat shows for its conversation: what the operator typed, cut from the host's task wrapper, control
 * header and memory block, and what the bot answered, read out of its claim envelope.
 */
import type { WorkerControlRecord } from "../../kernel/worker-control-stamp.ts";
import { isRecordObject } from "../util/value-guards.ts";

/** Where a bot's memory block joins its task: the operator's words come first, so chat views cut the text here. */
export const BOT_MEMORY_BLOCK_SEPARATOR = "\n\n---\n\n";
/** The first line of the memory block the store writes into a bot's task (`PersistentBotTeamStore`). */
export const BOT_MEMORY_BLOCK_HEADER = "### UNIFIED MEMORY & TEAM BLACKBOARD";

/** The text a bot's chat shows for a message: without the memory block the host appended to it. */
export function withoutBotMemoryBlock(text: string): string {
	// comms-legacy-decoder: the bot chat view cuts the host's memory block from the stored prompt text; the operator text is not stored as a field yet.
	const at = text.indexOf(`${BOT_MEMORY_BLOCK_SEPARATOR}${BOT_MEMORY_BLOCK_HEADER}`);
	return at < 0 ? text : text.slice(0, at);
}

/**
 * What the operator typed in one user message of a bot's conversation. A message that names its own typed record (every
 * message written since entries carry one) is sliced at the range the record gives for the operator's words, so no
 * frame or header is parsed; the host's memory block, joined to a task by a host constant, is cut from a task's words.
 * A message without a record is read by {@link operatorTextOf}.
 */
export function botChatOperatorText(
	message: { content: string | readonly { type: string; text?: string }[] },
	control: WorkerControlRecord | undefined,
): string {
	if (control?.body && typeof message.content === "string") {
		const words = message.content.slice(control.body.from, control.body.to);
		return (control.k === "task" ? withoutBotMemoryBlock(words) : words).trim();
	}
	return operatorTextOf(
		typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n"),
	);
}

/** What the operator typed, from a user message without a typed record: without the host's task wrapper, control header and memory block. */
export function operatorTextOf(text: string): string {
	let shown = withoutBotMemoryBlock(text);
	// comms-legacy-decoder: a message written before messages carried a typed record shows the operator's words only inside the control header or TASK frame.
	const control = /^\[Worker control [^\]\n]*\]\n/u.exec(shown);
	if (control) shown = shown.slice(control[0].length);
	const task = /^TASK\n([\s\S]*?)(?:\nEND TASK(?:\n[\s\S]*)?)?$/u.exec(shown);
	return (task ? (task[1] ?? shown) : shown).trim();
}

/** A bot answers a follow-up in the worker claim envelope; the chat shows what it said, which is the envelope's summary. */
export function botReplyText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return text;
	try {
		const claim: unknown = JSON.parse(trimmed);
		if (isRecordObject(claim) && typeof claim.summary === "string" && typeof claim.status === "string")
			return claim.summary;
	} catch {
		// Not an envelope: the text is the reply.
	}
	return text;
}
