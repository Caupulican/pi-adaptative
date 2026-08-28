import type { AgentTool } from "@caupulican/pi-agent-core";
import { expandParams, type PathAliasTable } from "./path-alias-table.ts";

/** Expand harness P# tokens in tool args without wrapping the same AgentTool twice. */
export function wrapToolWithPathAliasExpansion(
	tool: AgentTool,
	getTable: () => PathAliasTable,
	wrapped: WeakSet<AgentTool>,
): AgentTool {
	if (wrapped.has(tool)) return tool;
	const execute = tool.execute.bind(tool);
	const prepareArguments = tool.prepareArguments?.bind(tool);
	const next: AgentTool = {
		...tool,
		prepareArguments: prepareArguments ? (args) => prepareArguments(expandParams(getTable(), args)) : undefined,
		execute: (toolCallId, params, signal, onUpdate) =>
			execute(toolCallId, expandParams(getTable(), params) as typeof params, signal, onUpdate),
	};
	wrapped.add(tool);
	wrapped.add(next);
	return next;
}
