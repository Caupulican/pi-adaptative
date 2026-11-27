/** Literal evidence the host published for one tool-free completion report. */
import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import { messageSourceOf } from "./message-revision.ts";
import type { AgentMessage } from "./types.ts";

type LiteralReceipt = Pick<ToolResultMessage, "toolCallId" | "toolName" | "timestamp" | "isError" | "content">;
const published = new WeakMap<AgentMessage, LiteralReceipt>();

/** Capture the evidence before event listeners or request projections see the row. */
export function retainCommittedToolReceipt(row: ToolResultMessage): void {
	published.set(row, {
		toolCallId: row.toolCallId,
		toolName: row.toolName,
		timestamp: row.timestamp,
		isError: row.isError,
		content: row.content.map((part) => ({ ...part })),
	});
}

/** The read borrows only the current row. No earlier variant can restore redacted or missing text. */
export function isLiteralCommittedToolReceipt(row: AgentMessage): boolean {
	return row.role === "toolResult" && published.has(messageSourceOf(row));
}

function findExactReceipt(expected: LiteralReceipt, messages: readonly AgentMessage[]): ToolResultMessage | undefined {
	const row = messages.findLast(
		(message) => message.role === "toolResult" && message.toolCallId === expected.toolCallId,
	);
	if (
		row?.role !== "toolResult" ||
		row.toolName !== expected.toolName ||
		row.isError !== expected.isError ||
		row.timestamp !== expected.timestamp ||
		row.content.length !== expected.content.length
	)
		return undefined;
	const matches = row.content.every((part, index) => {
		const original = expected.content[index];
		return part.type === "text"
			? original?.type === "text" && original.text === part.text
			: original?.type === "image" && original.mimeType === part.mimeType && original.data === part.data;
	});
	return matches ? row : undefined;
}

/** Compaction may retain an equivalent copy. Bind only a call with the identical published evidence. */
export function admitCommittedReceiptSource(receipt: ToolResultMessage, messages: readonly AgentMessage[]): void {
	const expected = published.get(receipt);
	if (!expected) throw new Error("The report has no published tool receipt.");
	const row = findExactReceipt(expected, messages);
	if (!row) throw new Error("The source history no longer contains the committed tool receipt.");
	published.set(messageSourceOf(row), expected);
}

export function preservesCommittedToolReceipt(receipt: ToolResultMessage, messages: readonly AgentMessage[]): boolean {
	const expected = published.get(receipt);
	return expected !== undefined && findExactReceipt(expected, messages) !== undefined;
}
