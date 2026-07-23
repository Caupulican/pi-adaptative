import type { CapabilityName } from "./autonomy/contracts.ts";
import type { CapabilityEnforcementKind, HarnessCapability, OrchestrationProfile } from "./orchestration/contracts.ts";

export interface ToolCapabilityPolicy {
	envelopeCapability: CapabilityName;
	harnessCapabilityCandidates: readonly HarnessCapability[];
	enforcement: CapabilityEnforcementKind;
}

function policy(
	envelopeCapability: CapabilityName,
	harnessCapabilityCandidates: readonly HarnessCapability[],
	enforcement: CapabilityEnforcementKind,
): ToolCapabilityPolicy {
	return Object.freeze({
		envelopeCapability,
		harnessCapabilityCandidates: Object.freeze([...harnessCapabilityCandidates]),
		enforcement,
	});
}

const READ_POLICY = policy("read_files", ["filesystem.read", "worktree.read"], "path-scope");
const WRITE_POLICY = policy("write_files", ["filesystem.write", "worktree.mutate"], "path-scope");
const PROCESS_POLICY = policy("run_shell", ["process.exec", "tests.execute"], "process-launcher");
const NETWORK_POLICY = policy("network", ["network.http", "service.mcp"], "service-proxy");
const DELEGATE_POLICY = policy("delegate", ["workflow.delegate"], "control-plane");

const TOOL_CAPABILITY_POLICIES = new Map<string, ToolCapabilityPolicy>([
	...["read", "ls", "grep", "find"].map((toolName) => [toolName, READ_POLICY] as const),
	...["write", "edit", "edit-diff"].map((toolName) => [toolName, WRITE_POLICY] as const),
	...["bash", "python", "powershell", "shell", "run_toolkit_script", "run_process"].map(
		(toolName) => [toolName, PROCESS_POLICY] as const,
	),
	...["fetch", "web_search"].map((toolName) => [toolName, NETWORK_POLICY] as const),
	["skill_audit", policy("skill_read", ["filesystem.read"], "path-scope")],
	["skillify", policy("skill_write", ["filesystem.write"], "path-scope")],
	["extensionify", policy("source_write", ["filesystem.write"], "path-scope")],
	["goal", policy("memory_write", ["memory.mutate"], "memory-broker")],
	["memory", policy("memory_write", ["memory.mutate", "memory.query"], "memory-broker")],
	...["delegate", "delegate_status"].map((toolName) => [toolName, DELEGATE_POLICY] as const),
	["model_fitness", policy("research", ["workflow.plan"], "control-plane")],
]);

export function getToolCapabilityPolicy(toolName: string): ToolCapabilityPolicy | undefined {
	return TOOL_CAPABILITY_POLICIES.get(toolName.toLowerCase());
}

export function hasToolCapabilityPolicy(toolName: string): boolean {
	return getToolCapabilityPolicy(toolName) !== undefined;
}

export function requiredEnvelopeCapabilities(toolName: string, args?: unknown): readonly CapabilityName[] {
	if (toolName.toLowerCase() === "memory" && args && typeof args === "object" && "query" in args) {
		return ["memory_read"];
	}
	const policy = getToolCapabilityPolicy(toolName);
	return policy ? [policy.envelopeCapability] : [];
}

export function resolveProfileToolCapability(
	profile: Pick<OrchestrationProfile, "capabilityCeiling">,
	toolName: string,
): HarnessCapability | undefined {
	return getToolCapabilityPolicy(toolName)?.harnessCapabilityCandidates.find((capability) =>
		profile.capabilityCeiling.includes(capability),
	);
}

export function describeToolCapabilityAuthority(toolName: string): string {
	switch (getToolCapabilityPolicy(toolName)?.envelopeCapability) {
		case "read_files":
			return "read";
		case "write_files":
			return "write";
		case "run_shell":
			return "process";
		case "network":
			return "network";
		case "memory_read":
		case "memory_write":
			return "memory";
		case "delegate":
			return "delegation";
		case "skill_read":
		case "skill_write":
			return "skill";
		case "source_read":
		case "source_write":
			return "source";
		case "research":
			return "research";
		case "settings_read":
		case "settings_write":
			return "settings";
		case "publish":
			return "publish";
		case "auth_change":
			return "authentication";
		default:
			return "capability";
	}
}
