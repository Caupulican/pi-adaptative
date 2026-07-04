/**
 * Pure math for capping the TUI transcript that is re-rendered on reload/resume.
 *
 * These functions estimate wrapped line counts for agent messages and select the
 * tail of a message list that fits within the reload budget, trimming an oversized
 * head message when needed. They read only their arguments and hold no UI or session
 * state, so they live outside interactive-mode and are unit-testable in isolation.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Message } from "@caupulican/pi-ai";

export const TUI_HISTORY_RELOAD_MAX_LINES = 1000;
export const TUI_HISTORY_RELOAD_WRAP_WIDTH = 100;

export function getContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const maybeText = (part as { text?: unknown }).text;
				return typeof maybeText === "string" ? maybeText : "";
			})
			.join("");
	}
	return "";
}

export function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((c: { type: string }) => c.type === "text");
	return textBlocks.map((c) => (c as { text: string }).text).join("");
}

export function getTuiHistoryMessageText(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return [message.command, message.output ?? ""].filter(Boolean).join("\n");
		case "user":
			return getUserMessageText(message);
		case "assistant":
			return getContentText(message.content);
		case "toolResult":
			return getContentText(message.content);
		case "custom":
			return getContentText(message.content);
		case "compactionSummary":
		case "branchSummary":
			return message.summary;
		default: {
			const _exhaustive: never = message;
			return JSON.stringify(_exhaustive);
		}
	}
}

export function estimateTuiHistoryLines(message: AgentMessage): number {
	const text = getTuiHistoryMessageText(message);
	const hardLines = text.length > 0 ? text.split(/\r\n|\r|\n/).length : 1;
	const wrappedLines = Math.ceil(text.length / TUI_HISTORY_RELOAD_WRAP_WIDTH);
	// Add one line for role/tool chrome or spacing. Tool-call-only assistant messages
	// have little text but still render a component.
	return Math.max(1, hardLines, wrappedLines) + 1;
}

export function trimTextToTuiHistoryTail(text: string, maxEstimatedLines: number): string {
	const maxLines = Math.max(1, maxEstimatedLines);
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > maxLines) {
		const omitted = lines.length - maxLines;
		return `[Earlier ${omitted} line${omitted === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]\n${lines.slice(-maxLines).join("\n")}`;
	}
	const maxChars = Math.max(TUI_HISTORY_RELOAD_WRAP_WIDTH, maxLines * TUI_HISTORY_RELOAD_WRAP_WIDTH);
	if (text.length > maxChars) {
		const omitted = text.length - maxChars;
		return `[Earlier ${omitted} character${omitted === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]\n${text.slice(-maxChars)}`;
	}
	return text;
}

export function trimMessageToTuiHistoryTail(message: AgentMessage, maxEstimatedLines: number): AgentMessage {
	const text = getTuiHistoryMessageText(message);
	const trimmedText = trimTextToTuiHistoryTail(text, maxEstimatedLines);
	if (trimmedText === text) return message;
	const clone = JSON.parse(JSON.stringify(message)) as AgentMessage;
	const mutable = clone as unknown as { role?: string; content?: unknown; output?: unknown };
	if (mutable.role === "bashExecution" && typeof mutable.output === "string") {
		mutable.output = trimmedText;
	} else if (mutable.role === "compactionSummary" || mutable.role === "branchSummary") {
		(mutable as { summary?: string }).summary = trimmedText;
	} else if (typeof mutable.content === "string") {
		mutable.content = trimmedText;
	} else {
		mutable.content = [{ type: "text", text: trimmedText }];
	}
	return clone;
}

export function messagesForTuiHistoryReload(messages: AgentMessage[]): {
	messages: AgentMessage[];
	omittedMessages: number;
	estimatedLines: number;
} {
	let estimatedLines = 0;
	let start = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const nextLines = estimateTuiHistoryLines(messages[i]);
		if (start < messages.length && estimatedLines + nextLines > TUI_HISTORY_RELOAD_MAX_LINES) break;
		estimatedLines += nextLines;
		start = i;
		if (estimatedLines >= TUI_HISTORY_RELOAD_MAX_LINES) break;
	}
	const selected = messages.slice(start);
	if (selected.length > 0 && estimatedLines > TUI_HISTORY_RELOAD_MAX_LINES) {
		const tailLines = selected.slice(1).reduce((sum, message) => sum + estimateTuiHistoryLines(message), 0);
		const firstAllowance = TUI_HISTORY_RELOAD_MAX_LINES - tailLines;
		if (firstAllowance <= 4) {
			selected.shift();
			start += 1;
			estimatedLines = tailLines;
		} else {
			// Reserve room for truncation marker, role chrome, and wrap variance.
			selected[0] = trimMessageToTuiHistoryTail(selected[0], firstAllowance - 4);
			estimatedLines = tailLines + estimateTuiHistoryLines(selected[0]);
		}
	}
	return {
		messages: selected,
		omittedMessages: start,
		estimatedLines,
	};
}
