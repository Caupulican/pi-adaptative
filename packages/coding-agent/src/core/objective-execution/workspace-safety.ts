/**
 * shared_guarded proves delivery truth and does not contain a destructive process.
 * isolated_objective is the disposable-worktree mode. It is not wired in-process:
 * process-heavy dogfood runs in a separate clone, described in the closure audit.
 */
export type ObjectiveWorkspaceSafetyMode = "shared_guarded" | "isolated_objective";

export function resolveObjectiveWorkspaceSafetyMode(): ObjectiveWorkspaceSafetyMode {
	return "shared_guarded";
}
