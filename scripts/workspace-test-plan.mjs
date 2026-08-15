export const WORKSPACES = Object.freeze([
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent",
]);

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
