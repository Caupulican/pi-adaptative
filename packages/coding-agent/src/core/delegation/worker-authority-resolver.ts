import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, KnownProvider, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { lendableToolSurface, mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import {
	ROOT_MEMORY_TOOL_NAME,
	WORKER_MEMORY_READ_TOOL_NAME,
	WORKER_ROOT_MEMORY_TOOL_NAMES,
} from "../memory/worker-memory-tools.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { defaultModelPerProvider } from "../model-resolver.ts";
import {
	type HarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
	type OrchestrationThinkingLevel,
} from "../orchestration/contracts.ts";
import { CLASSIFIED_LANE_TOOL_NAMES } from "../orchestration/lane-tool-manifests.ts";
import { resolvePinnedOrchestrationModel } from "../orchestration/model-binding.ts";
import {
	DEFAULT_WORKER_DELEGATION_ACCOUNT,
	DEFAULT_WORKER_DELEGATION_THINKING,
	type WorkerAccountRouting,
	type WorkerThinkingPolicy,
} from "../settings-manager.ts";
import {
	capabilitySurvivesReadOnly,
	envelopeHasToolCapability,
	getToolCapabilityPolicy,
} from "../tool-capability-policy.ts";
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
	"repo_read",
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
	"repo.read",
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
	/** How an inherited foreground thinking level is applied to the worker; default `step_down`. */
	foregroundThinkingPolicy?: WorkerThinkingPolicy;
	/** Which account a fresh, unpinned worker runs on; default routes away from the foreground's. */
	accountRouting?: WorkerAccountRouting;
	foregroundToolNames?: readonly string[];
	foregroundEnvelope?: CapabilityEnvelope;
	cwd?: string;
	/** Caller task cwd for explicit relative path intent; preset paths remain anchored to cwd. */
	executionCwd?: string;
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

/**
 * One notch below `level` on the orchestration thinking ladder. `off` stays off (reasoning is
 * disabled, not merely low) and `minimal` is the floor, so stepping down never turns reasoning off
 * on a model the foreground runs with reasoning on.
 */
export function stepDownThinkingLevel(level: OrchestrationThinkingLevel): OrchestrationThinkingLevel {
	const index = ORCHESTRATION_THINKING_LEVELS.indexOf(level);
	if (index <= ORCHESTRATION_THINKING_LEVELS.indexOf("minimal")) return level;
	return ORCHESTRATION_THINKING_LEVELS[index - 1]!;
}

/**
 * The model a fresh, unpinned worker runs on under `account: "other"`: the first routing candidate
 * (`provider` or `provider/modelId`, in the configured order, then every other authenticated
 * provider in catalog order) that is not the foreground's provider, has configured auth, and is not
 * exhausted. Undefined when no alternative exists, in which case the worker inherits the foreground.
 */
export function selectRoutedWorkerModel(input: {
	foregroundModel: Model<Api>;
	routing: WorkerAccountRouting;
	modelRegistry: ModelRegistry;
	isModelExhausted: (model: Model<Api>) => boolean;
}): Model<Api> | undefined {
	if (input.routing.account !== "other") return undefined;
	const { foregroundModel, modelRegistry } = input;
	const available = modelRegistry.getAvailable();
	// Automatic candidates are ACCOUNTS: providers with a stored credential (OAuth or API key). A
	// provider that merely needs no auth (a local llama-cpp server, a models.json entry with a
	// placeholder key) is not a separate budget and would swallow a worker wave the owner never
	// pointed at it; the owner can still name such a provider explicitly in `routeProviders`.
	const isAccount = (provider: string): boolean => modelRegistry.authStorage.hasAuth(provider);
	const candidate = (provider: string, modelId?: string): Model<Api> | undefined => {
		if (provider === foregroundModel.provider) return undefined;
		const model = modelId
			? modelRegistry.find(provider, modelId)
			: (modelRegistry.find(provider, defaultModelPerProvider[provider as KnownProvider] ?? "") ??
				available.find((entry) => entry.provider === provider));
		if (!model || !modelRegistry.hasConfiguredAuth(model) || input.isModelExhausted(model)) return undefined;
		return model;
	};
	for (const entry of input.routing.routeProviders) {
		const slash = entry.indexOf("/");
		const found = slash > 0 ? candidate(entry.slice(0, slash), entry.slice(slash + 1)) : candidate(entry);
		if (found) return found;
	}
	const seen = new Set<string>();
	for (const model of available) {
		if (seen.has(model.provider)) continue;
		seen.add(model.provider);
		if (!isAccount(model.provider)) continue;
		const found = candidate(model.provider);
		if (found) return found;
	}
	return undefined;
}

function selectModelBinding(
	modelPin: OrchestrationModelBinding | undefined,
	authority: WorkerDelegationAuthorityRequest | undefined,
	base: ResolvedWorkerProfile | undefined,
	foregroundModel: Model<Api> | undefined,
	foregroundThinkingLevel: OrchestrationThinkingLevel | undefined,
	foregroundThinkingPolicy: WorkerThinkingPolicy,
	modelRegistry: ModelRegistry,
	accountRouting: WorkerAccountRouting,
	isModelExhausted: (model: Model<Api>) => boolean,
): OrchestrationModelBinding | undefined {
	if (modelPin) return { ...modelPin };
	// Routing applies only to a fresh worker nothing has bound: no pin, no authority model, no
	// profile binding. An authored choice is never moved to another account.
	if (!authority?.model && !base && foregroundModel) {
		const routed = selectRoutedWorkerModel({
			foregroundModel,
			routing: accountRouting,
			modelRegistry,
			isModelExhausted,
		});
		if (routed) {
			const inherited = foregroundThinkingLevel ?? resolveModelThinkingLevel(foregroundModel, undefined);
			const level =
				foregroundThinkingPolicy === "inherit"
					? resolveModelThinkingLevel(routed, inherited)
					: resolveModelThinkingLevel(routed, stepDownThinkingLevel(inherited));
			return { provider: routed.provider, modelId: routed.id, thinkingLevel: level };
		}
	}
	const provider = authority?.model?.provider ?? base?.modelBinding.provider ?? foregroundModel?.provider;
	const modelId = authority?.model?.modelId ?? base?.modelBinding.modelId ?? foregroundModel?.id;
	if (!provider || !modelId) return undefined;
	const sameAsBase = provider === base?.modelBinding.provider && modelId === base.modelBinding.modelId;
	const selectedModel = modelRegistry.find(provider, modelId);
	// Only the branch that copies the FOREGROUND level is subject to the thinking policy: an
	// authority pin and a profile binding are authored choices and stay exactly as written.
	const inheritedFromForeground = (): OrchestrationThinkingLevel => {
		const level = foregroundThinkingLevel ?? resolveModelThinkingLevel(foregroundModel!, undefined);
		if (foregroundThinkingPolicy === "inherit") return level;
		return resolveModelThinkingLevel(foregroundModel!, stepDownThinkingLevel(level));
	};
	const thinkingLevel =
		authority?.thinkingLevel ??
		(sameAsBase
			? base.modelBinding.thinkingLevel
			: foregroundModel && provider === foregroundModel.provider && modelId === foregroundModel.id
				? inheritedFromForeground()
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
		input.foregroundThinkingPolicy ?? DEFAULT_WORKER_DELEGATION_THINKING,
		input.modelRegistry,
		input.accountRouting ?? { account: DEFAULT_WORKER_DELEGATION_ACCOUNT, routeProviders: [] },
		input.isModelExhausted,
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
	// A parent with bash lends the catalog read tools natively (see lendableToolSurface); a request
	// for grep/find/ls/repo_read is therefore satisfied with read authority, never with bash.
	const inheritedSurfaceNames = lendableToolSurface(
		input.base ? input.base.profile.toolNames : inheritedForegroundToolNames,
	);
	const configuredToolNames = mapToolNamesForPlatform(
		input.authority?.toolNames ?? input.base?.profile.toolNames ?? inheritedSurfaceNames,
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
		const inheritedSurface = new Set(inheritedSurfaceNames);
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
	// A parent that may run processes can already read its repository through git; the read grain
	// of that authority is lent alongside. An explicit capability list or a base profile stays exact.
	if (
		!input.authority?.capabilities &&
		!input.base &&
		(capabilities.has("process.exec") || capabilities.has("tests.execute"))
	) {
		capabilities.add("repo.read");
	}
	if (input.authority?.readOnly) {
		for (const capability of capabilities) {
			if (!capabilitySurvivesReadOnly(capability)) capabilities.delete(capability);
		}
	}
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
		? resolveWorkerWorkspacePath(
				(input.authority?.path ? input.executionCwd : undefined) ?? input.cwd ?? process.cwd(),
				requestedWorkspacePath,
			)
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
