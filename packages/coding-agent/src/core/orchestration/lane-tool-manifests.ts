import { mapToolNamesForPlatform } from "../default-tool-surface.ts";
import { getToolCapabilityPolicy, resolveProfileToolCapabilities } from "../tool-capability-policy.ts";
import type { OrchestrationProfile, ToolCapabilityManifest } from "./contracts.ts";

export const CLASSIFIED_LANE_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"memory",
	"python",
	"run_process",
	"bash",
	"artifact_retrieve",
	"run_toolkit_script",
	"skill",
	"skill_audit",
] as const;
export const ORCHESTRATION_PROFILE_TOOL_NAMES = [...CLASSIFIED_LANE_TOOL_NAMES, "delegate"] as const;

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

	for (const toolName of new Set(mapToolNamesForPlatform(profile.toolNames))) {
		if (!enabled.has(toolName)) continue;
		const policy = getToolCapabilityPolicy(toolName);
		const capabilities = resolveProfileToolCapabilities(profile, toolName);
		if (!capabilities || !policy) continue;
		manifests.push({
			toolName,
			moduleSpecifier: `../tools/${toolName}.ts`,
			capabilities,
			roles: [profile.role],
			enforcements: policy.enforcements,
		});
	}
	return manifests;
}
