import type { HarnessCapability } from "../capability-contract.ts";
import {
	envelopeHasToolCapability,
	formatToolCapabilityRequirement,
	hasToolCapabilityPolicy,
	requiredEnvelopeCapabilities,
} from "../tool-capability-policy.ts";

export function hasCapabilityPolicyForTool(toolName: string): boolean {
	return hasToolCapabilityPolicy(toolName);
}

export function requiredCapabilitiesForTool(toolName: string, args?: unknown): readonly HarnessCapability[] {
	return requiredEnvelopeCapabilities(toolName, args);
}

export function describeCapabilityRequirementForTool(toolName: string, args?: unknown): string {
	return formatToolCapabilityRequirement(toolName, args);
}

export function hasRequiredCapabilityForTool(
	capabilities: readonly HarnessCapability[],
	toolName: string,
	args?: unknown,
): boolean {
	return envelopeHasToolCapability(capabilities, toolName, args);
}
