/**
 * Session command receipts: the commands a session's tool calls ran, with exit codes and the tail of their output.
 *
 * Read from the active branch by tool call id, so a proof sheet shows exactly what ran and what it printed, never a
 * model's paraphrase. Output is redacted and cut to a short tail; a call with no terminal result reads as `unknown`.
 */

import type { ToolCall } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/node.ts";
import { CHANNEL_REPLY_TOOL_NAME } from "../channels/channel-tool-names.ts";
import { producingCommand, pythonCallLanguage } from "../goals/session-goal-evidence.ts";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import { messageContentText } from "../util/message-content-text.ts";
import type { ProofCommand } from "./proof-sheet.ts";

const MAX_TAIL_CHARS = 400;

/** The redacted last lines of a command's output, bounded to a short tail. */
export function redactedOutputTail(text: string, maxChars = MAX_TAIL_CHARS): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const redacted = redactTokenShapes(redactKnownSecrets(trimmed));
	return redacted.length <= maxChars ? redacted : `...${redacted.slice(-maxChars)}`;
}

/** Which calls to read: the named tool call ids, or every command call made at or after `since` (an ISO timestamp). */
export type SessionCommandSelection = { readonly toolCallIds: ReadonlySet<string> } | { readonly since: string };

/** The commands the selected tool calls ran on the active branch, in branch order; calls that ran no command are skipped. */
export function readSessionCommandReceipts(
	sessionManager: Pick<SessionManager, "getBranch">,
	selection: SessionCommandSelection,
): ProofCommand[] {
	if ("toolCallIds" in selection && selection.toolCallIds.size === 0) return [];
	const selected = (id: string, timestamp: string): boolean =>
		"toolCallIds" in selection ? selection.toolCallIds.has(id) : timestamp >= selection.since;
	const calls = new Map<string, { command: string; language?: "python" | "python-file" }>();
	const results = new Map<string, { isError: boolean; exitCode?: number; outputTail?: string }>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || !selected(part.id, entry.timestamp)) continue;
				const command = producingCommand(part as ToolCall);
				const language = pythonCallLanguage(part as ToolCall);
				if (command !== undefined) calls.set(part.id, { command, ...(language ? { language } : {}) });
			}
		} else if (message.role === "toolResult" && calls.has(message.toolCallId)) {
			const details = message.details as { exitCode?: unknown } | undefined;
			const exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;
			const tail = redactedOutputTail(messageContentText(message.content));
			results.set(message.toolCallId, {
				isError: message.isError === true,
				...(exitCode !== undefined ? { exitCode } : {}),
				...(tail ? { outputTail: tail } : {}),
			});
		}
	}
	const receipts: ProofCommand[] = [];
	for (const [id, call] of calls) {
		const result = results.get(id);
		receipts.push({
			command: call.command,
			outcome: result === undefined ? "unknown" : result.isError ? "failed" : "passed",
			...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
			...(result?.outputTail ? { outputTail: result.outputTail } : {}),
			ref: id,
			...(call.language ? { language: call.language } : {}),
		});
	}
	return receipts;
}

/** A call that sends a message to people outside the session: a channel reply released with `send` (not `list` or `dismiss`). */
function isOutboundCall(call: ToolCall): boolean {
	return call.name === CHANNEL_REPLY_TOOL_NAME && call.arguments?.action === "send";
}

/** How many outbound tool calls succeeded on the active branch at or after `since` (an ISO timestamp). */
export function countSessionOutboundActions(sessionManager: Pick<SessionManager, "getBranch">, since: string): number {
	const outbound = new Set<string>();
	let count = 0;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				const call = part as ToolCall;
				if (call.type === "toolCall" && isOutboundCall(call) && entry.timestamp >= since) {
					outbound.add(call.id);
				}
			}
		} else if (message.role === "toolResult" && outbound.has(message.toolCallId) && message.isError !== true) {
			count++;
		}
	}
	return count;
}
