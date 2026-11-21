import { sep } from "node:path";
import { getCwdRelativePath } from "../utils/paths.ts";
import { extractPathArguments } from "./autonomy/envelope-enforcement.ts";
import { expandParams, type PathAliasTable } from "./context/path-alias-table.ts";
import { toolUsesPathScope } from "./tool-capability-policy.ts";

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
