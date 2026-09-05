import type { HarnessCapability } from "./capability-contract.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES } from "./goals/goal-tool-names.ts";
import { ROOT_MEMORY_TOOL_NAME, WORKER_MEMORY_READ_TOOL_NAME } from "./memory/worker-memory-tools.ts";
import type { CapabilityEnforcementKind, OrchestrationProfile } from "./orchestration/contracts.ts";

export interface ToolCapabilityPolicy {
	/** AND across clauses; OR across the capability alternatives inside one clause. */
	capabilityClauses: readonly (readonly HarnessCapability[])[];
	enforcements: readonly CapabilityEnforcementKind[];
}

export type ToolPathAccess = "none" | "read" | "write";

const READ_PATH_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set([
	"filesystem.read",
	"worktree.read",
	"skill.read",
	"source.read",
]);
const WRITE_PATH_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set([
	"filesystem.write",
	"worktree.mutate",
	"skill.write",
	"source.write",
]);

function policy(
	capabilityClauses: readonly (readonly HarnessCapability[])[],
	enforcements: CapabilityEnforcementKind | readonly CapabilityEnforcementKind[],
): ToolCapabilityPolicy {
	return Object.freeze({
		capabilityClauses: Object.freeze(capabilityClauses.map((clause) => Object.freeze([...clause]))),
		enforcements: Object.freeze(typeof enforcements === "string" ? [enforcements] : [...enforcements]),
	});
}

const READ_POLICY = policy([["filesystem.read", "worktree.read"]], "path-scope");
const WRITE_POLICY = policy([["filesystem.write", "worktree.mutate"]], "path-scope");
const PROCESS_POLICY = policy([["process.exec", "tests.execute"]], "process-launcher");
const NETWORK_POLICY = policy([["network.http", "service.mcp"]], "service-proxy");
const DELEGATE_POLICY = policy([["workflow.delegate"]], "control-plane");

const TOOL_CAPABILITY_POLICIES = new Map<string, ToolCapabilityPolicy>([
	...["read", "ls", "grep", "find"].map((toolName) => [toolName, READ_POLICY] as const),
	...["write", "edit", "edit-diff"].map((toolName) => [toolName, WRITE_POLICY] as const),
	...["bash", "python", "powershell", "shell", "run_toolkit_script", "run_process"].map(
		(toolName) => [toolName, PROCESS_POLICY] as const,
	),
	...["fetch", "web_search"].map((toolName) => [toolName, NETWORK_POLICY] as const),
	["webfetch", policy([["network.http"]], "service-proxy")],
	[
		"image_generate",
		policy([["network.http"], ["credentials.use"], ["filesystem.read"]], ["service-proxy", "path-scope"]),
	],
	["skill", policy([["skill.read"]], "path-scope")],
	["skill_audit", policy([["skill.read"]], "path-scope")],
	["skillify", policy([["skill.write"]], "path-scope")],
	["extensionify", policy([["source.write"]], "path-scope")],
	["runtime_update", policy([["source.write"], ["process.exec"]], "control-plane")],
	["goal", policy([["memory.mutate", "memory.query"]], "memory-broker")],
	[GOAL_LIFECYCLE_TOOL_NAMES[0], policy([["memory.mutate"]], "memory-broker")],
	[GOAL_LIFECYCLE_TOOL_NAMES[1], policy([["memory.query"]], "memory-broker")],
	[GOAL_LIFECYCLE_TOOL_NAMES[2], policy([["memory.mutate"]], "memory-broker")],
	[ROOT_MEMORY_TOOL_NAME, policy([["memory.mutate", "memory.query"]], "memory-broker")],
	[WORKER_MEMORY_READ_TOOL_NAME, policy([["memory.query"]], "memory-broker")],
	["secret_store", policy([["credentials.use"]], ["service-proxy", "path-scope"])],
	["delegate", DELEGATE_POLICY],
	["model_fitness", policy([["research.execute"]], "control-plane")],
	["task_steps", policy([["workflow.plan", "memory.mutate"]], "control-plane")],
	["pipeline", policy([["workflow.plan"], ["filesystem.write", "worktree.mutate"]], ["control-plane", "path-scope"])],
	["tool_task", policy([["process.exec", "workflow.delegate"]], "control-plane")],
	["worktree_sync", policy([["worktree.mutate", "filesystem.write"]], "path-scope")],
	["ask_question", policy([["workflow.plan", "memory.query"]], "control-plane")],
	["artifact_retrieve", policy([["filesystem.read"]], "path-scope")],
	["context_scout", policy([["filesystem.read"]], "path-scope")],
	["pi_collaboration", policy([["process.exec"], ["workflow.delegate"]], "process-launcher")],
	["improvement_loop", policy([["process.exec", "tests.execute"]], "process-launcher")],
]);

const NON_CANONICAL_POLICY_TOOL_NAMES: ReadonlySet<string> = new Set(["edit-diff", "powershell", "shell"]);

/** Model-facing runtime tools whose authority is owned by this policy catalogue. Platform aliases
 * and the internal managed-process adapter stay out of child CLI profiles. */
export const POLICY_OWNED_RUNTIME_TOOL_NAMES: readonly string[] = Object.freeze(
	[...TOOL_CAPABILITY_POLICIES.keys()].filter((toolName) => !NON_CANONICAL_POLICY_TOOL_NAMES.has(toolName)),
);

export function getToolCapabilityPolicy(toolName: string): ToolCapabilityPolicy | undefined {
	return TOOL_CAPABILITY_POLICIES.get(toolName.toLowerCase());
}

export function hasToolCapabilityPolicy(toolName: string): boolean {
	return getToolCapabilityPolicy(toolName) !== undefined;
}

export function toolUsesPathScope(toolName: string): boolean {
	return getToolCapabilityPolicy(toolName)?.enforcements.includes("path-scope") ?? false;
}

export function toolCapabilityRequirementClauses(
	toolName: string,
	args?: unknown,
): readonly (readonly HarnessCapability[])[] {
	const name = toolName.toLowerCase();
	if (name === ROOT_MEMORY_TOOL_NAME && args !== undefined) {
		const record =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
		const isUnambiguousQuery =
			record !== undefined &&
			typeof record.query === "string" &&
			Object.keys(record).every((key) => key === "query");
		return isUnambiguousQuery ? [["memory.query"]] : [["memory.mutate"]];
	}
	if (name === "goal" && args !== undefined) {
		const action =
			args && typeof args === "object" && !Array.isArray(args) && "action" in args
				? (args as { action: unknown }).action
				: undefined;
		return action === "get" ? [["memory.query"]] : [["memory.mutate"]];
	}
	if (name === "pipeline") {
		const action =
			args && typeof args === "object" && "action" in args ? (args as { action: unknown }).action : undefined;
		if (action === "list" || action === "status") {
			return [["workflow.plan", "filesystem.read"]];
		}
		return [["workflow.plan"], ["filesystem.write", "worktree.mutate"]];
	}
	const itemPolicy = getToolCapabilityPolicy(name);
	if (!itemPolicy) return [];
	return itemPolicy.capabilityClauses;
}

export function requiredEnvelopeCapabilities(toolName: string, args?: unknown): readonly HarnessCapability[] {
	const clauses = toolCapabilityRequirementClauses(toolName, args);
	return clauses.map((clause) => clause[0]).filter((c): c is HarnessCapability => c !== undefined);
}

export function formatToolCapabilityRequirement(toolName: string, args?: unknown): string {
	return toolCapabilityRequirementClauses(toolName, args)
		.map((clause) => (clause.length === 1 ? clause[0] : `(${clause.join(" or ")})`))
		.filter((clause): clause is string => clause !== undefined)
		.join(" and ");
}

export function envelopeHasToolCapability(
	capabilities: readonly HarnessCapability[],
	toolName: string,
	args?: unknown,
): boolean {
	return resolveToolCallCapabilities(capabilities, toolName, args) !== undefined;
}

/** Resolve the exact alternative selected from every conjunctive clause for one invocation. */
export function resolveToolCallCapabilities(
	capabilities: readonly HarnessCapability[],
	toolName: string,
	args?: unknown,
): readonly HarnessCapability[] | undefined {
	const clauses = toolCapabilityRequirementClauses(toolName, args);
	if (clauses.length === 0) return undefined;
	const resolved: HarnessCapability[] = [];
	for (const clause of clauses) {
		const match = clause.find((capability) => capabilities.includes(capability));
		if (!match) return undefined;
		resolved.push(match);
	}
	return resolved;
}

export function resolveCapabilityPathAccess(
	capabilities: readonly HarnessCapability[],
): Exclude<ToolPathAccess, "none"> | undefined {
	if (capabilities.some((capability) => WRITE_PATH_CAPABILITIES.has(capability))) return "write";
	if (capabilities.some((capability) => READ_PATH_CAPABILITIES.has(capability))) return "read";
	return undefined;
}

/** Resolve whether one authorized invocation exposes caller-controlled paths to a scoped boundary. */
export function resolveToolCallPathAccess(
	capabilities: readonly HarnessCapability[],
	toolName: string,
	args?: unknown,
): ToolPathAccess {
	const policy = getToolCapabilityPolicy(toolName);
	if (!policy?.enforcements.includes("path-scope")) return "none";
	const selected = resolveToolCallCapabilities(capabilities, toolName, args);
	if (!selected) return "none";
	const name = toolName.toLowerCase();
	// These tools accept identifiers or natural-language queries, not filesystem paths. Their
	// fixed stores are owned by the tool, while context_scout gates each concrete child read.
	if (name === "artifact_retrieve" || name === "context_scout") return "none";
	if (name === "pipeline" && selected.includes("workflow.plan") && selected.length === 1) return "none";
	if (name === "secret_store") {
		const action =
			args && typeof args === "object" && !Array.isArray(args) && "action" in args
				? (args as { action: unknown }).action
				: undefined;
		return action === "migrate" || action === "discover" ? "read" : "none";
	}
	return resolveCapabilityPathAccess(selected) ?? "none";
}

export function resolveProfileToolCapabilities(
	profile: Pick<OrchestrationProfile, "capabilityCeiling">,
	toolName: string,
): readonly HarnessCapability[] | undefined {
	const clauses = toolCapabilityRequirementClauses(toolName);
	if (clauses.length === 0) return undefined;
	const resolved: HarnessCapability[] = [];
	for (const clause of clauses) {
		const match = clause.find((capability) => profile.capabilityCeiling.includes(capability));
		if (!match) return undefined;
		resolved.push(match);
	}
	return resolved;
}

export function describeToolCapabilityAuthority(toolName: string): string {
	switch (getToolCapabilityPolicy(toolName)?.capabilityClauses[0]?.[0]) {
		case "filesystem.read":
		case "worktree.read":
			return "read";
		case "filesystem.write":
		case "worktree.mutate":
			return "write";
		case "process.exec":
		case "tests.execute":
			return "process";
		case "network.http":
		case "service.mcp":
			return "network";
		case "memory.query":
		case "memory.mutate":
			return "memory";
		case "workflow.delegate":
			return "delegation";
		case "skill.read":
		case "skill.write":
			return "skill";
		case "source.read":
		case "source.write":
			return "source";
		case "research.execute":
			return "research";
		case "settings.read":
		case "settings.write":
			return "settings";
		case "publish.execute":
			return "publish";
		case "credentials.use":
			return "authentication";
		default:
			return "capability";
	}
}
