import { createHash } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import type { ModelRegistry } from "../model-registry.ts";
import {
	type HarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
} from "../orchestration/contracts.ts";
import { CLASSIFIED_LANE_TOOL_NAMES } from "../orchestration/lane-tool-manifests.ts";
import { resolvePinnedOrchestrationModel } from "../orchestration/model-binding.ts";
import { getToolCapabilityPolicy } from "../tool-capability-policy.ts";
import type { WorkerDelegationAuthorityRequest } from "./worker-delegation-request.ts";
import type { ResolvedWorkerProfile } from "./worker-profile-resolver.ts";

const DEFAULT_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit", "memory", STABLE_SHELL_TOOL_NAME] as const;
const AVAILABLE_TOOL_NAMES: ReadonlySet<string> = new Set([...CLASSIFIED_LANE_TOOL_NAMES, "delegate"]);
const DEFAULT_CAPABILITIES: readonly HarnessCapability[] = [
	"filesystem.read",
	"filesystem.write",
	"worktree.read",
	"worktree.mutate",
	"process.exec",
	"network.http",
	"service.mcp",
	"memory.query",
];

export interface WorkerAuthorityResolutionInput {
	authority?: WorkerDelegationAuthorityRequest;
	base?: ResolvedWorkerProfile;
	foregroundModel?: Model<Api>;
	modelRegistry: ModelRegistry;
	isModelExhausted(model: Model<Api>): boolean;
}

export type WorkerAuthorityResolution =
	| {
			ok: true;
			shipment: ResolvedWorkerProfile;
			requestedReadPaths?: readonly string[];
			requestedWritePaths?: readonly string[];
	  }
	| { ok: false; reason: string };

function selectModelBinding(
	authority: WorkerDelegationAuthorityRequest | undefined,
	base: ResolvedWorkerProfile | undefined,
	foregroundModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): OrchestrationModelBinding | undefined {
	const provider = authority?.model?.provider ?? base?.modelBinding.provider ?? foregroundModel?.provider;
	const modelId = authority?.model?.modelId ?? base?.modelBinding.modelId ?? foregroundModel?.id;
	if (!provider || !modelId) return undefined;
	const sameAsBase = provider === base?.modelBinding.provider && modelId === base.modelBinding.modelId;
	const selectedModel = modelRegistry.find(provider, modelId);
	const thinkingLevel =
		authority?.thinkingLevel ??
		(sameAsBase
			? base.modelBinding.thinkingLevel
			: foregroundModel && provider === foregroundModel.provider && modelId === foregroundModel.id
				? resolveModelThinkingLevel(foregroundModel, undefined)
				: selectedModel
					? resolveModelThinkingLevel(selectedModel, undefined)
					: "off");
	return { provider, modelId, thinkingLevel };
}

function adaptiveProfileId(value: object): string {
	return `adaptive-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

/** Materialize free-form model choices as one immutable profile-shaped execution snapshot. */
export function resolveWorkerAuthority(input: WorkerAuthorityResolutionInput): WorkerAuthorityResolution {
	if (!input.authority && input.base) return { ok: true, shipment: input.base };
	const binding = selectModelBinding(input.authority, input.base, input.foregroundModel, input.modelRegistry);
	if (!binding) return { ok: false, reason: "orchestration_model_required" };
	const resolvedModel = resolvePinnedOrchestrationModel(binding, input.modelRegistry, input.isModelExhausted);
	if (!resolvedModel) return { ok: false, reason: "orchestration_model_unavailable" };

	const requestedToolNames = mapToolNamesForPlatform(
		input.authority?.toolNames ?? input.base?.profile.toolNames ?? DEFAULT_TOOL_NAMES,
	);
	const uniqueToolNames = [...new Set(requestedToolNames)];
	const unavailableTools = uniqueToolNames.filter((toolName) => !AVAILABLE_TOOL_NAMES.has(toolName));
	if (unavailableTools.length > 0) {
		return { ok: false, reason: `orchestration_tool_unavailable:${unavailableTools.join(",")}` };
	}
	const capabilities = new Set<HarnessCapability>(
		input.authority?.capabilities ?? input.base?.profile.capabilityCeiling ?? DEFAULT_CAPABILITIES,
	);
	const toolNames: string[] = [];
	for (const toolName of uniqueToolNames) {
		const policy = getToolCapabilityPolicy(toolName);
		if (!policy) return { ok: false, reason: `orchestration_tool_unclassified:${toolName}` };
		if (policy.capabilityCandidates.some((capability) => capabilities.has(capability))) {
			toolNames.push(toolName);
			continue;
		}
		if (input.authority?.toolNames !== undefined) {
			return { ok: false, reason: `orchestration_tool_capability_missing:${toolName}` };
		}
	}
	const budget = structuredClone(input.authority?.budget ?? input.base?.profile.budget ?? {});
	const role = input.authority?.role ?? input.base?.profile.role ?? "orchestrator";
	const now = new Date().toISOString();
	const descriptor = {
		role,
		binding: resolvedModel.binding,
		capabilities: [...capabilities],
		toolNames,
		budget,
		resourceProfileNames: input.base?.profile.resourceProfileNames ?? [],
	};
	const maxWallClockMs = budget.maxWallClockMs ?? 0;
	const wallClockLeaseTtlMs =
		maxWallClockMs > Number.MAX_SAFE_INTEGER - 30_000 ? Number.MAX_SAFE_INTEGER : maxWallClockMs + 30_000;
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: adaptiveProfileId(descriptor),
		description: "Admission-time adaptive agent authority",
		role,
		modelPolicy: { mode: "fixed", candidates: [resolvedModel.binding] },
		capabilityCeiling: [...capabilities],
		toolNames,
		resourceProfileNames: [...(input.base?.profile.resourceProfileNames ?? [])],
		dispatchProfileIds: [],
		...(input.base?.profile.executionPolicy ? { executionPolicy: input.base.profile.executionPolicy } : {}),
		budget,
		maxConcurrent: Number.MAX_SAFE_INTEGER,
		leaseTtlMs: Math.max(input.base?.profile.leaseTtlMs ?? 0, wallClockLeaseTtlMs, 90_000),
		requireIndependentVerification: input.base?.profile.requireIndependentVerification ?? false,
		...(input.base?.profile.verificationProfileId
			? { verificationProfileId: input.base.profile.verificationProfileId }
			: {}),
		createdAt: now,
		updatedAt: now,
	};
	return {
		ok: true,
		shipment: {
			model: resolvedModel.model,
			modelBinding: resolvedModel.binding,
			profile,
			resourcePointers: structuredClone(input.base?.resourcePointers ?? []),
			...(input.base?.soul ? { soul: input.base.soul } : {}),
		},
		...(input.authority?.readPaths ? { requestedReadPaths: [...input.authority.readPaths] } : {}),
		...(input.authority?.writePaths ? { requestedWritePaths: [...input.authority.writePaths] } : {}),
	};
}
