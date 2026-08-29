/**
 * Expand path aliases back to real paths for anything a person reads.
 *
 * Aliases exist for ONE reason: to cut tokens on the wire. `p/grep.ts` costs a fraction of
 * `packages/coding-agent/src/core/tools/grep.ts`, and over a long session that compression is
 * large. It is a transport encoding, not a way to name files — the operator is looking at their own
 * machine and must always see the real path, exactly as they would without the optimization.
 *
 * The harness already expands aliases automatically wherever they would otherwise escape their
 * transport role: `expandParams` unwraps them in tool arguments before a tool ever runs. Display is
 * the other such boundary. A model that read `p/module02.ts` in its context will write `p/module02`
 * in its prose and its tool arguments, and both reach the transcript verbatim, so expansion has to
 * happen where those are rendered rather than where they are stored.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { expandParams, expandText, type PathAliasTable, rewriteAgentMessagesWith } from "./path-alias-table.ts";

/**
 * Shared walk behind {@link expandMessageForDisplay} and {@link expandMessageTextForDisplay}. One
 * shared structure walk (path-alias-table.ts) handles message shape; this only supplies what to do
 * with a text span, a thinking span, and — when the caller supplies one — a tool call's arguments.
 */
function expandMessageWith<TMessage extends AgentMessage>(
	table: PathAliasTable,
	message: TMessage,
	toolCallArguments?: (args: unknown) => unknown,
): TMessage {
	if (table.entries.length === 0) return message;
	const [expanded] = rewriteAgentMessagesWith([message], {
		text: (text) => expandText(table, text),
		thinkingText: (text) => expandText(table, text),
		toolCallArguments,
	});
	return (expanded as TMessage | undefined) ?? message;
}

/** Expand every alias a person would see in one message. Returns the message unchanged if none. */
export function expandMessageForDisplay<TMessage extends AgentMessage>(
	table: PathAliasTable,
	message: TMessage,
): TMessage {
	return expandMessageWith(table, message, (args) => {
		const next = expandParams(table, args);
		// The walk treats an unchanged reference as "nothing happened"; expandParams rebuilds
		// objects, so collapse a no-op back to the original to keep messages identity-stable.
		return JSON.stringify(next) === JSON.stringify(args) ? args : next;
	});
}

/**
 * Expand aliases in an assistant message's prose and thinking text only — never its tool-call
 * arguments. For the streaming display path, which recomputes this on every chunk: a still-
 * streaming tool call's arguments are a large, partial, mid-token payload, and walking them per
 * chunk is the exact O(chunks x payload) cost `attachStreamingToolActions` already avoids by
 * expanding arguments once, only once they are complete (see its doc comment in
 * interactive-mode.ts). Text and thinking spans are cheap to re-expand every chunk and must
 * self-heal as a split alias completes, so they are unconditional here; a toolCall part comes
 * back untouched, by identity, leaving argument-expansion timing exactly as it is today.
 */
export function expandMessageTextForDisplay<TMessage extends AgentMessage>(
	table: PathAliasTable,
	message: TMessage,
): TMessage {
	return expandMessageWith(table, message);
}

/** Expand aliases in streamed tool-call arguments, which arrive outside any message. */
export function expandArgumentsForDisplay(
	table: PathAliasTable,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (table.entries.length === 0) return args;
	return expandParams(table, args) as Record<string, unknown>;
}
