import { interfaceText } from "../../../core/language/interface-text.ts";
import { isAssistantDisplayText } from "../../../core/message-phase.ts";
import { isRecordObject } from "../../../core/util/value-guards.ts";
import type { AgentMessage } from "../../../kernel/index.ts";
import { sanitizeBinaryOutput } from "../../../kernel/utils/shell-output.ts";
import { stripAnsi } from "../../../utils/ansi.ts";

/** A human question/answer is conversation even though its wire representation is a tool result. */
export function isConversationMessage(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "assistant" ||
		(message.role === "toolResult" && message.toolName === "ask_question")
	);
}

export function questionConversationText(
	args: unknown,
	content?: readonly { type: string; text?: string }[],
	failed = false,
): string {
	const questions = isRecordObject(args) && Array.isArray(args.questions) ? args.questions : [];
	const question = questions
		.slice(0, 4)
		.filter(isRecordObject)
		.map((item) => (typeof item.question === "string" ? item.question.slice(0, 1000) : ""))
		.filter(Boolean)
		.join("\n\n");
	const answer = content
		?.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	const text = interfaceText().dialogs.question;
	return sanitizeBinaryOutput(
		stripAnsi(
			`${question ? `${text.assistant}\n${question}\n\n` : ""}${answer === undefined ? text.waiting : `${failed ? text.status : text.you}\n${answer}`}`,
		),
	);
}

/** Explicit copy path, never a render hot path. Rejects oversize copies instead of silently truncating. */
export function fullConversationText(messages: Iterable<AgentMessage>): string {
	const text = interfaceText().dialogs.question;
	const parts: string[] = [];
	const questions = new Map<string, unknown>();
	let bytes = 0;
	for (const message of messages) {
		if (!isConversationMessage(message)) continue;
		let part: string;
		if (message.role === "toolResult") {
			part = questionConversationText(questions.get(message.toolCallId), message.content, message.isError);
			questions.delete(message.toolCallId);
		} else if (message.role === "assistant" || message.role === "user") {
			if (message.role === "assistant")
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === "ask_question") questions.set(block.id, block.arguments);
				}
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(
								(block) =>
									block.type === "text" && (message.role === "user" || isAssistantDisplayText(block, true)),
							)
							.map((block) => (block.type === "text" ? block.text : ""))
							.join("\n\n");
			if (!content.trim()) continue;
			part = `${message.role === "user" ? text.you : text.assistant}\n${content}`;
		} else continue;
		bytes += Buffer.byteLength(part) + 2;
		if (bytes > 10 * 1024 * 1024) throw new Error(text.clipboardLimit);
		parts.push(part);
	}
	return parts.join("\n\n");
}
