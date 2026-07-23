import type { HarnessCapability, OrchestrationProfile, ToolCapabilityManifest } from "./contracts.ts";

export const CLASSIFIED_LANE_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"memory",
	"run_process",
] as const;
export const ORCHESTRATION_PROFILE_TOOL_NAMES = [...CLASSIFIED_LANE_TOOL_NAMES, "delegate", "delegate_status"] as const;

const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

function firstGranted(
	profile: OrchestrationProfile,
	candidates: readonly HarnessCapability[],
): HarnessCapability | undefined {
	return candidates.find((capability) => profile.capabilityCeiling.includes(capability));
}

/**
 * Manifest-only lane catalogue. It contains no tool factories, so policy compilation can omit
 * denied tools before their executable implementations are constructed.
 */
export function buildLaneToolManifests(
	profile: OrchestrationProfile,
	enabledToolNames: readonly string[],
): ToolCapabilityManifest[] {
	const enabled = new Set(enabledToolNames);
	const manifests: ToolCapabilityManifest[] = [];
	const readCapability = firstGranted(profile, ["filesystem.read", "worktree.read"]);
	const writeCapability = firstGranted(profile, ["filesystem.write", "worktree.mutate"]);
	const processCapability = firstGranted(profile, ["process.exec", "tests.execute"]);

	for (const toolName of profile.toolNames) {
		if (!enabled.has(toolName)) continue;
		let capability: HarnessCapability | undefined;
		let enforcement: ToolCapabilityManifest["enforcements"][number] | undefined;
		if (READ_TOOLS.has(toolName)) {
			capability = readCapability;
			enforcement = "path-scope";
		} else if (WRITE_TOOLS.has(toolName)) {
			capability = writeCapability;
			enforcement = "path-scope";
		} else if (toolName === "memory") {
			capability = profile.capabilityCeiling.includes("memory.query") ? "memory.query" : undefined;
			enforcement = "memory-broker";
		} else if (toolName === "run_process") {
			capability = processCapability;
			enforcement = "process-launcher";
		}
		if (!capability || !enforcement) continue;
		manifests.push({
			toolName,
			moduleSpecifier: `../tools/${toolName}.ts`,
			capabilities: [capability],
			roles: [profile.role],
			enforcements: [enforcement],
		});
	}
	return manifests;
}
