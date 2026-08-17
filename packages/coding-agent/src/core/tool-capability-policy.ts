import type { HarnessCapability } from "./capability-contract.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES } from "./goals/goal-tool-names.ts";
import type { CapabilityEnforcementKind, OrchestrationProfile } from "./orchestration/contracts.ts";

export interface ToolCapabilityPolicy {
	capabilityCandidates: readonly HarnessCapability[];
	enforcement: CapabilityEnforcementKind;
}

function policy(
	capabilityCandidates: readonly HarnessCapability[],
	enforcement: CapabilityEnforcementKind,
): ToolCapabilityPolicy {
	return Object.freeze({
		capabilityCandidates: Object.freeze([...capabilityCandidates]),
		enforcement,
	});
}

const READ_POLICY = policy(["filesystem.read", "worktree.read"], "path-scope");
const WRITE_POLICY = policy(["filesystem.write", "worktree.mutate"], "path-scope");
const PROCESS_POLICY = policy(["process.exec", "tests.execute"], "process-launcher");
const NETWORK_POLICY = policy(["network.http", "service.mcp"], "service-proxy");
const DELEGATE_POLICY = policy(["workflow.delegate"], "control-plane");

const TOOL_CAPABILITY_POLICIES = new Map<string, ToolCapabilityPolicy>([
	...["read", "ls", "grep", "find"].map((toolName) => [toolName, READ_POLICY] as const),
	...["write", "edit", "edit-diff"].map((toolName) => [toolName, WRITE_POLICY] as const),
	...["bash", "python", "powershell", "shell", "run_toolkit_script", "run_process"].map(
		(toolName) => [toolName, PROCESS_POLICY] as const,
	),
	...["fetch", "web_search"].map((toolName) => [toolName, NETWORK_POLICY] as const),
	["skill", policy(["skill.read"], "path-scope")],
	["skill_audit", policy(["skill.read"], "path-scope")],
	["skillify", policy(["skill.write"], "path-scope")],
	["extensionify", policy(["source.write"], "path-scope")],
	...["goal", ...GOAL_LIFECYCLE_TOOL_NAMES].map(
		(toolName) => [toolName, policy(["memory.mutate"], "memory-broker")] as const,
	),
	["memory", policy(["memory.mutate", "memory.query"], "memory-broker")],
	["secret_store", policy(["credentials.use"], "service-proxy")],
	["delegate", DELEGATE_POLICY],
	["model_fitness", policy(["research.execute"], "control-plane")],
	["task_steps", policy(["workflow.plan", "memory.mutate"], "control-plane")],
	["pipeline", policy(["workflow.plan", "filesystem.write"], "control-plane")],
	["tool_task", policy(["process.exec", "workflow.delegate"], "control-plane")],
	["worktree_sync", policy(["worktree.mutate", "filesystem.write"], "path-scope")],
	["ask_question", policy(["workflow.plan", "memory.query"], "control-plane")],
	["artifact_retrieve", policy(["filesystem.read"], "path-scope")],
	["context_scout", policy(["filesystem.read"], "path-scope")],
	["tmux_dispatch", policy(["process.exec", "workflow.delegate"], "process-launcher")],
	["improvement_loop", policy(["process.exec", "tests.execute"], "process-launcher")],
]);

export function getToolCapabilityPolicy(toolName: string): ToolCapabilityPolicy | undefined {
	return TOOL_CAPABILITY_POLICIES.get(toolName.toLowerCase());
}

export function hasToolCapabilityPolicy(toolName: string): boolean {
	return getToolCapabilityPolicy(toolName) !== undefined;
}

export function toolCapabilityRequirementClauses(
	toolName: string,
	args?: unknown,
): readonly (readonly HarnessCapability[])[] {
	const name = toolName.toLowerCase();
	if (name === "memory") {
		return args && typeof args === "object" && "query" in args ? [["memory.query"]] : [["memory.mutate"]];
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
	return [itemPolicy.capabilityCandidates];
}

export function requiredEnvelopeCapabilities(toolName: string, args?: unknown): readonly HarnessCapability[] {
	const clauses = toolCapabilityRequirementClauses(toolName, args);
	return clauses.map((clause) => clause[0]).filter((c): c is HarnessCapability => c !== undefined);
}

export function envelopeHasToolCapability(
	capabilities: readonly HarnessCapability[],
	toolName: string,
	args?: unknown,
): boolean {
	const clauses = toolCapabilityRequirementClauses(toolName, args);
	if (clauses.length === 0) return false;
	return clauses.every((clause) => clause.some((capability) => capabilities.includes(capability)));
}

export function resolveProfileToolCapability(
	profile: Pick<OrchestrationProfile, "capabilityCeiling">,
	toolName: string,
): HarnessCapability | undefined {
	const clauses = toolCapabilityRequirementClauses(toolName);
	for (const clause of clauses) {
		const match = clause.find((capability) => profile.capabilityCeiling.includes(capability));
		if (!match) return undefined;
	}
	return clauses[0]?.[0];
}

export function describeToolCapabilityAuthority(toolName: string): string {
	switch (getToolCapabilityPolicy(toolName)?.capabilityCandidates[0]) {
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
