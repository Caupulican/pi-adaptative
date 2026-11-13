import {
	formatToolCapabilityRequirement,
	hasToolCapabilityPolicy,
	type ToolCallFacts,
} from "../tool-capability-policy.ts";

export function hasCapabilityPolicyForTool(toolName: string): boolean {
	return hasToolCapabilityPolicy(toolName);
}

export function describeCapabilityRequirementForTool(toolName: string, args?: unknown, facts?: ToolCallFacts): string {
	return formatToolCapabilityRequirement(toolName, args, facts);
}
