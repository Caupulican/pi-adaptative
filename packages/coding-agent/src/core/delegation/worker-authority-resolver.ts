import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import {
	ROOT_MEMORY_TOOL_NAME,
	WORKER_MEMORY_READ_TOOL_NAME,
	WORKER_ROOT_MEMORY_TOOL_NAMES,
} from "../memory/worker-memory-tools.ts";
import type { ModelRegistry } from "../model-registry.ts";
import {
	type HarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
	type OrchestrationThinkingLevel,
} from "../orchestration/contracts.ts";
import { CLASSIFIED_LANE_TOOL_NAMES } from "../orchestration/lane-tool-manifests.ts";
import { resolvePinnedOrchestrationModel } from "../orchestration/model-binding.ts";
import { envelopeHasToolCapability, getToolCapabilityPolicy } from "../tool-capability-policy.ts";
import type { WorkerDelegationAuthorityRequest } from "./worker-delegation-request.ts";
import { LEAF_WORKER_DELEGATION_LIMITS } from "./worker-fleet-limits.ts";
import { resolveWorkerWorkspacePath } from "./worker-machine-scope.ts";
import type { ResolvedWorkerProfile } from "./worker-profile-resolver.ts";

/**
 * Smallest token grant a worker can survive on. A worker's first response pays the full
 * uncached system prompt (~3.3k budgeted tokens in the field), so grants below this floor
 * starve mid-flight with every tool call denied `token_budget_exhausted` — reject them at
 * admission with an explicit reason instead (field session 019fd4dc: 8-9k grants died in
 * 2-3 responses under face-value cache-read counting; the floor plus discounted counting
 * makes small grants viable again).
 */
export const MIN_VIABLE_WORKER_TOKEN_BUDGET = 5_000;

const DEFAULT_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"python",
	STABLE_SHELL_TOOL_NAME,
	"artifact_retrieve",
	"skill",
	"skill_audit",
] as const;
const AVAILABLE_TOOL_NAMES: ReadonlySet<string> = new Set(CLASSIFIED_LANE_TOOL_NAMES);
const DEFAULT_CAPABILITIES: readonly HarnessCapability[] = [
	"filesystem.read",
	"filesystem.write",
	"worktree.read",
	"worktree.mutate",
	"process.exec",
	"network.http",
	"service.mcp",
	"skill.read",
];
export interface WorkerAuthorityResolutionInput {
	authority?: WorkerDelegationAuthorityRequest;
	base?: ResolvedWorkerProfile;
	modelPin?: OrchestrationModelBinding;
	foregroundModel?: Model<Api>;
	foregroundThinkingLevel?: OrchestrationThinkingLevel;
	foregroundToolNames?: readonly string[];
	foregroundEnvelope?: CapabilityEnvelope;
	cwd?: string;
	modelRegistry: ModelRegistry;
	isModelExhausted(model: Model<Api>): boolean;
}

export type WorkerAuthorityResolution =
	| {
			ok: true;
			shipment: ResolvedWorkerProfile;
	  }
	| { ok: false; reason: string };

/**
 * Bind a compiled implementation profile to the compiled verifier identity it will persist.
 * Verifier admission can legitimately derive a new immutable profile id (for example when the
 * host forces a legacy delegation-capable preset to the leaf contract), so retaining the
 * configured source id would make the execution contract internally inconsistent. Rebinding changes compiled
 * content and therefore derives a fresh implementation identity as well.
 */
export function bindCompiledVerifierIdentity(
	shipment: ResolvedWorkerProfile,
	verifierProfileId: string,
): ResolvedWorkerProfile {
	if (shipment.profile.verificationProfileId === verifierProfileId) return shipment;
	const profile: OrchestrationProfile = {
		...shipment.profile,
		verificationProfileId: verifierProfileId,
		profileId: adaptiveProfileId({
			baseProfileId: shipment.profile.profileId,
			verificationProfileId: verifierProfileId,
		}),
	};
	return { ...shipment, profile };
}

/** Bind the immutable profile snapshot to the exact native tools its host plan materialized. */
export function bindCompiledToolSurface(
	shipment: ResolvedWorkerProfile,
	toolNames: readonly string[],
): ResolvedWorkerProfile {
	if (isDeepStrictEqual(shipment.profile.toolNames, toolNames)) return shipment;
	const profile: OrchestrationProfile = {
		...shipment.profile,
		toolNames: [...toolNames],
		profileId: adaptiveProfileId({
			baseProfileId: shipment.profile.profileId,
			toolNames,
		}),
	};
	return { ...shipment, profile };
}

function selectModelBinding(
	modelPin: OrchestrationModelBinding | undefined,
	authority: WorkerDelegationAuthorityRequest | undefined,
	base: ResolvedWorkerProfile | undefined,
	foregroundModel: Model<Api> | undefined,
	foregroundThinkingLevel: OrchestrationThinkingLevel | undefined,
	modelRegistry: ModelRegistry,
): OrchestrationModelBinding | undefined {
	if (modelPin) return { ...modelPin };
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
				? (foregroundThinkingLevel ?? resolveModelThinkingLevel(foregroundModel, undefined))
				: selectedModel
					? resolveModelThinkingLevel(selectedModel, undefined)
					: "off");
	return { provider, modelId, thinkingLevel };
}

function adaptiveProfileId(value: object): string {
	return `adaptive-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function tokenBudgetFloorFailure(maxTokens: number | undefined): string | undefined {
	return maxTokens !== undefined && maxTokens < MIN_VIABLE_WORKER_TOKEN_BUDGET
		? `token_budget_below_floor:requested=${maxTokens},min=${MIN_VIABLE_WORKER_TOKEN_BUDGET}`
		: undefined;
}

/** Materialize free-form model choices as one immutable profile-shaped execution snapshot. */
export function resolveWorkerAuthority(input: WorkerAuthorityResolutionInput): WorkerAuthorityResolution {
	const binding = selectModelBinding(
		input.modelPin,
		input.authority,
		input.base,
		input.foregroundModel,
		input.foregroundThinkingLevel,
		input.modelRegistry,
	);
	if (!binding) return { ok: false, reason: "orchestration_model_required" };
	const resolvedModel = resolvePinnedOrchestrationModel(binding, input.modelRegistry, input.isModelExhausted);
	if (!resolvedModel) return { ok: false, reason: "orchestration_model_unavailable" };
	if (
		input.modelPin &&
		((input.authority?.model !== undefined &&
			(input.authority.model.provider !== input.modelPin.provider ||
				input.authority.model.modelId !== input.modelPin.modelId)) ||
			(input.authority?.thinkingLevel !== undefined &&
				input.authority.thinkingLevel !== input.modelPin.thinkingLevel))
	) {
		return {
			ok: false,
			reason: `worker_model_pin_conflict:${input.authority?.role ?? input.base?.profile.role ?? "implementer"}`,
		};
	}

	const inheritedForegroundToolNames = mapToolNamesForPlatform(
		input.foregroundToolNames ?? input.foregroundEnvelope?.allowedTools ?? DEFAULT_TOOL_NAMES,
	).filter((toolName) => AVAILABLE_TOOL_NAMES.has(toolName) && !WORKER_ROOT_MEMORY_TOOL_NAMES.has(toolName));
	const requestedForbiddenTool = input.authority?.toolNames?.find((toolName) =>
		WORKER_ROOT_MEMORY_TOOL_NAMES.has(toolName),
	);
	if (requestedForbiddenTool) {
		return { ok: false, reason: `orchestration_tool_unavailable:${requestedForbiddenTool}` };
	}
	const baseForbiddenTool = input.base?.profile.toolNames.find((toolName) =>
		WORKER_ROOT_MEMORY_TOOL_NAMES.has(toolName),
	);
	if (baseForbiddenTool) {
		return { ok: false, reason: `orchestration_tool_unavailable:${baseForbiddenTool}` };
	}
	const configuredToolNames = mapToolNamesForPlatform(
		input.authority?.toolNames ?? input.base?.profile.toolNames ?? inheritedForegroundToolNames,
	).filter((toolName) => !WORKER_ROOT_MEMORY_TOOL_NAMES.has(toolName));
	const deniedForegroundTools = new Set(input.base ? [] : (input.foregroundEnvelope?.deniedTools ?? []));
	const uniqueToolNames = [
		...new Set(
			configuredToolNames.filter((toolName) => toolName !== "delegate" && !deniedForegroundTools.has(toolName)),
		),
	];
	if (input.authority?.toolNames?.includes("delegate")) {
		return { ok: false, reason: "orchestration_tool_unavailable:delegate" };
	}
	const unavailableTools = uniqueToolNames.filter((toolName) => !AVAILABLE_TOOL_NAMES.has(toolName));
	if (unavailableTools.length > 0) {
		return { ok: false, reason: `orchestration_tool_unavailable:${unavailableTools.join(",")}` };
	}
	if (input.authority?.toolNames !== undefined) {
		const inheritedSurface = new Set(
			input.base ? mapToolNamesForPlatform(input.base.profile.toolNames) : inheritedForegroundToolNames,
		);
		const foregroundTools = input.foregroundToolNames ?? input.foregroundEnvelope?.allowedTools ?? DEFAULT_TOOL_NAMES;
		const boundedMemoryReadInherited =
			uniqueToolNames.includes(WORKER_MEMORY_READ_TOOL_NAME) &&
			foregroundTools.includes(ROOT_MEMORY_TOOL_NAME) &&
			input.foregroundEnvelope?.capabilities.includes("memory.query") === true;
		const uninheritedTools = uniqueToolNames.filter(
			(toolName) =>
				!inheritedSurface.has(toolName) &&
				!(toolName === WORKER_MEMORY_READ_TOOL_NAME && boundedMemoryReadInherited),
		);
		if (uninheritedTools.length > 0) {
			return { ok: false, reason: `orchestration_tool_unavailable:${uninheritedTools.join(",")}` };
		}
	}
	const capabilities = new Set<HarnessCapability>(
		input.authority?.capabilities ??
			input.base?.profile.capabilityCeiling ??
			input.foregroundEnvelope?.capabilities ??
			DEFAULT_CAPABILITIES,
	);
	capabilities.delete("workflow.delegate");
	capabilities.delete("memory.mutate");
	const capabilityList = [...capabilities];
	const toolNames: string[] = [];
	for (const toolName of uniqueToolNames) {
		const policy = getToolCapabilityPolicy(toolName);
		if (!policy) return { ok: false, reason: `orchestration_tool_unclassified:${toolName}` };
		if (envelopeHasToolCapability(capabilityList, toolName)) {
			toolNames.push(toolName);
			continue;
		}
		if (input.authority?.toolNames !== undefined) {
			return { ok: false, reason: `orchestration_tool_capability_missing:${toolName}` };
		}
	}
	const budget = structuredClone(input.authority?.budget ?? input.base?.profile.budget ?? {});
	const floorFailure = tokenBudgetFloorFailure(budget.maxTokens);
	if (floorFailure) return { ok: false, reason: floorFailure };
	const role = input.authority?.role ?? input.base?.profile.role ?? "implementer";
	const delegationLimits = structuredClone(LEAF_WORKER_DELEGATION_LIMITS);
	const requestedWorkspacePath = input.authority?.path ?? input.base?.profile.workspacePath;
	const workspacePath = requestedWorkspacePath
		? resolveWorkerWorkspacePath(input.cwd ?? process.cwd(), requestedWorkspacePath)
		: undefined;
	const now = new Date().toISOString();
	const descriptor = {
		baseProfileId: input.base?.profile.profileId ?? null,
		role,
		binding: resolvedModel.binding,
		capabilities: [...capabilities],
		toolNames,
		budget,
		delegationLimits: delegationLimits ?? null,
		workspacePath: workspacePath ?? null,
		resourceProfileNames: input.base?.profile.resourceProfileNames ?? [],
		dispatchProfileIds: input.base?.profile.dispatchProfileIds ?? [],
		executionPolicy: input.base?.profile.executionPolicy ?? null,
		requireIndependentVerification: input.base?.profile.requireIndependentVerification ?? false,
		verificationProfileId: input.base?.profile.verificationProfileId ?? null,
	};
	const maxWallClockMs = budget.maxWallClockMs ?? 0;
	const wallClockLeaseTtlMs =
		maxWallClockMs > Number.MAX_SAFE_INTEGER - 30_000 ? Number.MAX_SAFE_INTEGER : maxWallClockMs + 30_000;
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: input.base?.profile.profileId ?? "",
		description: input.base?.profile.description ?? "Admission-time adaptive agent authority",
		role,
		modelPolicy: { mode: "fixed", candidates: [resolvedModel.binding] },
		capabilityCeiling: [...capabilities],
		toolNames,
		...(workspacePath ? { workspacePath } : {}),
		resourceProfileNames: [...(input.base?.profile.resourceProfileNames ?? [])],
		dispatchProfileIds: [...(input.base?.profile.dispatchProfileIds ?? [])],
		...(input.base?.profile.executionPolicy ? { executionPolicy: input.base.profile.executionPolicy } : {}),
		delegationLimits,
		budget,
		maxConcurrent: input.base?.profile.maxConcurrent ?? Number.MAX_SAFE_INTEGER,
		leaseTtlMs: Math.max(input.base?.profile.leaseTtlMs ?? 0, wallClockLeaseTtlMs, 90_000),
		requireIndependentVerification: input.base?.profile.requireIndependentVerification ?? false,
		...(input.base?.profile.verificationProfileId
			? { verificationProfileId: input.base.profile.verificationProfileId }
			: {}),
		createdAt: input.base?.profile.createdAt ?? now,
		updatedAt: input.base?.profile.updatedAt ?? now,
	};
	const unchangedBase = input.base && isDeepStrictEqual(profile, input.base.profile);
	profile.profileId = unchangedBase ? profile.profileId : adaptiveProfileId(descriptor);
	return {
		ok: true,
		shipment: {
			model: resolvedModel.model,
			modelBinding: resolvedModel.binding,
			profile,
			resourcePointers: structuredClone(input.base?.resourcePointers ?? []),
			...(input.base?.soul ? { soul: input.base.soul } : {}),
		},
	};
}
