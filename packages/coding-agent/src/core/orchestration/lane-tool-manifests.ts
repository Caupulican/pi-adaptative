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
	"bash",
	"powershell",
] as const;
export const ORCHESTRATION_PROFILE_TOOL_NAMES = [
	...CLASSIFIED_LANE_TOOL_NAMES,
	"delegate",
	"delegate_status",
	"profile_writer",
] as const;

/** Kernel control tools are available to every in-process agent and inherited by descendants. */
export const INHERITED_ORCHESTRATION_TOOL_NAMES = ["delegate"] as const;

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

	for (const toolName of new Set([...profile.toolNames, ...INHERITED_ORCHESTRATION_TOOL_NAMES])) {
		if (!enabled.has(toolName)) continue;
		const policy = getToolCapabilityPolicy(toolName);
		const capability = INHERITED_ORCHESTRATION_TOOL_NAMES.includes(
			toolName as (typeof INHERITED_ORCHESTRATION_TOOL_NAMES)[number],
		)
			? "workflow.delegate"
			: resolveProfileToolCapability(profile, toolName);
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
