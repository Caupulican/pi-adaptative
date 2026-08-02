import { getToolCapabilityPolicy, resolveProfileToolCapability } from "../tool-capability-policy.ts";
import type { OrchestrationProfile, ToolCapabilityManifest } from "./contracts.ts";

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
export const ORCHESTRATION_PROFILE_TOOL_NAMES = [
	...CLASSIFIED_LANE_TOOL_NAMES,
	"delegate",
	"delegate_status",
	"profile_writer",
] as const;

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

	for (const toolName of profile.toolNames) {
		if (!enabled.has(toolName)) continue;
		const policy = getToolCapabilityPolicy(toolName);
		const capability = resolveProfileToolCapability(profile, toolName);
		if (!capability || !policy) continue;
		manifests.push({
			toolName,
			moduleSpecifier: `../tools/${toolName}.ts`,
			capabilities: [capability],
			roles: [profile.role],
			enforcements: [policy.enforcement],
		});
	}
	return manifests;
}
