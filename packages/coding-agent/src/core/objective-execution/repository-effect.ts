/**
 * Observation class for one tool call, taken from the capability catalogue and
 * host-owned tool metadata. Model arguments cannot choose this class.
 */
import { toolCapabilityRequirementClauses } from "../tool-capability-policy.ts";

export type RepositoryEffect = "typed_owned_write" | "observe" | "none";
export type HostRepositoryEffect = "none" | "observe" | "typed_paths";

const MUTATING_CAPABILITIES = new Set([
	"filesystem.write",
	"worktree.mutate",
	"source.write",
	"skill.write",
	"process.exec",
	"tests.execute",
]);

export function repositoryEffectForCall(input: {
	readonly toolName: string;
	readonly args: unknown;
	readonly deliveryActive: boolean;
	readonly hostEffect?: HostRepositoryEffect;
}): RepositoryEffect {
	if (input.hostEffect === "none") return "none";
	if (input.hostEffect === "typed_paths") return "typed_owned_write";
	if (input.hostEffect === "observe") return "observe";
	const name = input.toolName.toLowerCase();
	if (name === "tool_task" || name === "repo_read") return "none";
	if (name === "edit" || name === "write" || name === "edit-diff") return "typed_owned_write";
	const clauses = toolCapabilityRequirementClauses(name, input.args);
	if (clauses.length === 0) return input.deliveryActive ? "observe" : "none";
	const capabilities = clauses.flat();
	if (capabilities.some((capability) => MUTATING_CAPABILITIES.has(capability))) return "observe";
	return "none";
}
