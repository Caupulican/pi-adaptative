import type { CapabilityName } from "./contracts.ts";

const TOOL_CAPABILITY_REQUIREMENTS = new Map<string, readonly CapabilityName[]>([
	["read", ["read_files"]],
	["ls", ["read_files"]],
	["grep", ["read_files"]],
	["find", ["read_files"]],
	["write", ["write_files"]],
	["edit", ["write_files"]],
	["edit-diff", ["write_files"]],
	["bash", ["run_shell"]],
	["shell", ["run_shell"]],
	["fetch", ["network"]],
	["web_search", ["network"]],
	["skill_audit", ["skill_read"]],
	["skillify", ["skill_write"]],
	["extensionify", ["source_write"]],
	["goal", ["memory_write"]],
]);

export function hasCapabilityPolicyForTool(toolName: string): boolean {
	return TOOL_CAPABILITY_REQUIREMENTS.has(toolName);
}

export function requiredCapabilitiesForTool(toolName: string, _args?: unknown): readonly CapabilityName[] {
	return TOOL_CAPABILITY_REQUIREMENTS.get(toolName) ?? [];
}
