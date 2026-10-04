import { sep } from "node:path";
import { getCwdRelativePath } from "../utils/paths.ts";
import { extractPathArguments } from "./autonomy/envelope-enforcement.ts";
import { expandParams, type PathAliasTable } from "./context/path-alias-table.ts";
import { toolUsesPathScope } from "./tool-capability-policy.ts";

/**
 * The working-tree files one tool call names, as cwd-relative `/` paths for path-scoped skill ranking.
 * Only tools the capability policy scopes by path count, and only paths an argument spells out (a tool's
 * implicit `.` default is not a file). Path aliases are expanded first, since the call carries the model's
 * spelling. A path outside the working directory cannot match a project-relative glob and is dropped.
 */
export function skillWorkPathsFromToolCall(
	toolName: string,
	args: unknown,
	aliasTable: PathAliasTable,
	cwd: string,
): string[] {
	if (!toolUsesPathScope(toolName)) return [];
	const expanded = aliasTable.entries.length === 0 ? args : expandParams(aliasTable, args, true);
	const paths: string[] = [];
	for (const raw of extractPathArguments(expanded)) {
		const relative = getCwdRelativePath(raw, cwd);
		if (relative === undefined || relative === ".") continue;
		paths.push(sep === "/" ? relative : relative.split(sep).join("/"));
	}
	return paths;
}
