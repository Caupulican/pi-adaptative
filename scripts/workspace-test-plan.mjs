import { existsSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACES = Object.freeze([
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent",
]);

export function isVitestFilter(arg) {
	return arg.startsWith("test/") || arg.startsWith("src/") || arg.includes(".test.");
}

export function splitTestCliArgs(args) {
	const workspaces = [];
	const filters = [];
	for (const arg of args) {
		if (isVitestFilter(arg)) filters.push(arg);
		else workspaces.push(arg);
	}
	return { workspaces, filters };
}

export function resolveWorkspaceTestPlan(requestedWorkspaces) {
	if (requestedWorkspaces.length === 0) return [...WORKSPACES];

	const selected = new Set();
	for (const workspace of requestedWorkspaces) {
		if (!WORKSPACES.includes(workspace)) throw new Error(`Unknown test workspace: ${workspace}`);
		if (selected.has(workspace)) throw new Error(`Duplicate test workspace: ${workspace}`);
		selected.add(workspace);
	}

	return WORKSPACES.filter((workspace) => selected.has(workspace));
}

export function planWorkspaceTests(args, exists = existsSync) {
	const { workspaces, filters } = splitTestCliArgs(args);
	if (workspaces.length === 0 && filters.length > 0) {
		const owners = WORKSPACES.filter((workspace) =>
			filters.some((filter) => exists(join(workspace, filter))),
		);
		if (owners.length === 0) throw new Error(`Unknown test filter: ${filters.join(", ")}`);
		return { workspaces: owners, filters };
	}
	return { workspaces: resolveWorkspaceTestPlan(workspaces), filters };
}
