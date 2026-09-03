import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { collectUnknownAliasTokensInPathParams, expandParams, type PathAliasTable } from "./path-alias-table.ts";

const MAX_REPORTED_UNKNOWN_TOKENS = 3;

/**
 * Reject alias ids the harness never minted, before the tool runs.
 *
 * An unminted `p/...` token survives expansion untouched and reaches the tool as a literal
 * relative path, where it fails with `ENOENT ... /p/<name>` — an error that describes a `p/`
 * directory the project does not have instead of naming the mistake, costing the model a turn to
 * misdiagnose. A token that DOES name something on disk is a real file under a literal `p/` tree
 * and must pass through untouched (the same case `isIdTaken` protects at mint time).
 */
function assertNoUnmintedAliases(table: PathAliasTable, params: unknown, cwd: string): void {
	const unknown = collectUnknownAliasTokensInPathParams(table, params).filter(
		(token) => !existsSync(resolve(cwd, token)),
	);
	if (unknown.length === 0) return;
	const [first, ...rest] = unknown;
	const also = rest.length > 0 ? ` Also unminted: ${rest.slice(0, MAX_REPORTED_UNKNOWN_TOKENS - 1).join(", ")}.` : "";
	throw new Error(
		`Unminted path alias ${JSON.stringify(first)}: not in the PATH ALIASES legend and no such file exists. ` +
			`Never invent p/ tokens — use the literal path or an id from the legend.${also}`,
	);
}

/** Expand harness P# tokens in tool args without wrapping the same AgentTool twice. */
export function wrapToolWithPathAliasExpansion(
	tool: AgentTool,
	getTable: () => PathAliasTable,
	wrapped: WeakSet<AgentTool>,
	getCwd: () => string,
): AgentTool {
	if (wrapped.has(tool)) return tool;
	const execute = tool.execute.bind(tool);
	const prepareArguments = tool.prepareArguments?.bind(tool);
	const next: AgentTool = {
		...tool,
		prepareArguments: prepareArguments ? (args) => prepareArguments(expandParams(getTable(), args)) : undefined,
		execute: (toolCallId, params, signal, onUpdate) => {
			const table = getTable();
			assertNoUnmintedAliases(table, params, getCwd());
			return execute(toolCallId, expandParams(table, params) as typeof params, signal, onUpdate);
		},
	};
	wrapped.add(tool);
	wrapped.add(next);
	return next;
}
