/**
 * Expert Identity Materialization.
 * Implements EXPERT_IDENTITY.md and HMOE-030/HMOE-031.
 */

import { createHash } from "node:crypto";
import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertDescriptor,
	type ExpertPrivacyClass,
	type ExpertRuntimeKind,
} from "./contracts.ts";

export interface CreateExpertDescriptorInput {
	provider: string;
	modelId?: string;
	model_id?: string;
	role?: string;
	thinkingLevel?: string;
	thinking_level?: string;
	runtimeKind?: ExpertRuntimeKind;
	runtime_kind?: ExpertRuntimeKind;
	modelFamily?: string | null;
	model_family?: string | null;
	capabilityClass?: string | null;
	capability_class?: string | null;
	capabilityTier?: string | null;
	capability_tier?: string | null;
	toolNames?: readonly string[];
	tool_names?: readonly string[];
	resourceProfiles?: readonly string[];
	resource_profiles?: readonly string[];
	contextWindow?: number | null;
	context_window?: number | null;
	privacyClass?: ExpertPrivacyClass;
	privacy_class?: ExpertPrivacyClass;
	hostKey?: string | null;
	host_key?: string | null;
}

/**
 * Computes a deterministic identity digest across behaviorally relevant fields.
 * Excludes volatile operational metrics (quota, live latency, ephemeral load).
 */
export function computeExpertIdentityDigest(input: CreateExpertDescriptorInput): string {
	const provider = (input.provider ?? "").toLowerCase().trim();
	const modelId = (input.modelId ?? input.model_id ?? "").toLowerCase().trim();
	const role = (input.role ?? "generalist").toLowerCase().trim();
	const thinkingLevel = (input.thinkingLevel ?? input.thinking_level ?? "off").toLowerCase().trim();
	const runtimeKind = input.runtimeKind ?? input.runtime_kind ?? "remote";
	const toolNames = [...(input.toolNames ?? input.tool_names ?? [])].sort();
	const resourceProfiles = [...(input.resourceProfiles ?? input.resource_profiles ?? [])].sort();

	const canonical = {
		provider,
		modelId,
		role,
		thinkingLevel,
		runtimeKind,
		capabilityClass: input.capabilityClass ?? input.capability_class ?? null,
		capabilityTier: input.capabilityTier ?? input.capability_tier ?? null,
		toolNames,
		resourceProfiles,
		contextWindow: input.contextWindow ?? input.context_window ?? null,
		privacyClass: input.privacyClass ?? input.privacy_class ?? "remote_allowed",
		hostKey: input.hostKey ?? input.host_key ?? null,
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Generates a stable human-readable expert ID with a deterministic hash suffix.
 */
export function generateExpertId(input: CreateExpertDescriptorInput, digest: string): string {
	const safeProvider = (input.provider ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
	const modelId = input.modelId ?? input.model_id ?? "";
	const safeModel = modelId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const role = input.role ?? "generalist";
	const safeRole = role.replace(/[^a-zA-Z0-9_-]/g, "_");
	const thinking = input.thinkingLevel ?? input.thinking_level ?? "off";
	const safeThinking = thinking.replace(/[^a-zA-Z0-9_-]/g, "_");
	const suffix = digest.slice(0, 8);
	return `${safeProvider}__${safeModel}__${safeRole}__${safeThinking}__${suffix}`;
}

/**
 * Materializes an immutable ExpertDescriptor from component fields.
 */
export function materializeExpertDescriptor(input: CreateExpertDescriptorInput): ExpertDescriptor {
	const digest = computeExpertIdentityDigest(input);
	const expertId = generateExpertId(input, digest);
	const modelId = input.modelId ?? input.model_id ?? "";
	const role = input.role ?? "generalist";
	const thinkingLevel = input.thinkingLevel ?? input.thinking_level ?? "off";
	const runtimeKind = input.runtimeKind ?? input.runtime_kind ?? "remote";

	return {
		schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
		expert_id: expertId,
		provider: input.provider,
		model_id: modelId,
		role,
		thinking_level: thinkingLevel,
		runtime_kind: runtimeKind,
		model_family: input.modelFamily ?? input.model_family ?? null,
		capability_class: input.capabilityClass ?? input.capability_class ?? null,
		capability_tier: input.capabilityTier ?? input.capability_tier ?? null,
		tool_names: input.toolNames ?? input.tool_names ?? [],
		resource_profiles: input.resourceProfiles ?? input.resource_profiles ?? [],
		context_window: input.contextWindow ?? input.context_window ?? null,
		privacy_class: input.privacyClass ?? input.privacy_class ?? "remote_allowed",
		host_key: input.hostKey ?? input.host_key ?? null,
		identity_digest: digest,
	};
}
