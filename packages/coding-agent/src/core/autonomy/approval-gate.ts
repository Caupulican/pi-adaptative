import { hasToolCapabilityPolicy, requiredEnvelopeCapabilities } from "../tool-capability-policy.ts";
import type { CapabilityName } from "./contracts.ts";

export function hasCapabilityPolicyForTool(toolName: string): boolean {
	return hasToolCapabilityPolicy(toolName);
}

export function requiredCapabilitiesForTool(toolName: string, args?: unknown): readonly CapabilityName[] {
	return requiredEnvelopeCapabilities(toolName, args);
}
