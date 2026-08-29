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

/** Expand every alias a person would see in one message. Returns the message unchanged if none. */
export function expandMessageForDisplay<TMessage extends AgentMessage>(
	table: PathAliasTable,
	message: TMessage,
): TMessage {
	if (table.entries.length === 0) return message;
	// One shared structure walk (path-alias-table.ts) handles message shape; this only supplies what
	// to do with a text span and with a tool call's arguments.
	const [expanded] = rewriteAgentMessagesWith([message], {
		text: (text) => expandText(table, text),
		toolCallArguments: (args) => {
			const next = expandParams(table, args);
			// The walk treats an unchanged reference as "nothing happened"; expandParams rebuilds
			// objects, so collapse a no-op back to the original to keep messages identity-stable.
			return JSON.stringify(next) === JSON.stringify(args) ? args : next;
		},
	});
	return (expanded as TMessage | undefined) ?? message;
}

/** Expand aliases in streamed tool-call arguments, which arrive outside any message. */
export function expandArgumentsForDisplay(
	table: PathAliasTable,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (table.entries.length === 0) return args;
	return expandParams(table, args) as Record<string, unknown>;
}
