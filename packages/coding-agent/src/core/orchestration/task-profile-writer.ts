import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type {
	OrchestrationModelBinding,
	OrchestrationModelPolicy,
	OrchestrationProfile,
	OrchestrationThinkingLevel,
	RiskBudget,
} from "./contracts.ts";
import { MAX_ORCHESTRATION_DESCRIPTION_LENGTH } from "./contracts.ts";
import { resolvePinnedOrchestrationModel } from "./model-binding.ts";
import { validateOrchestrationProfile } from "./profile-registry.ts";
import { OrchestrationProfileStore } from "./profile-store.ts";
import type { SessionTaskProfileStore } from "./session-task-profile-store.ts";

export interface TaskProfileModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: OrchestrationThinkingLevel;
}

export interface TaskProfileCreateInput {
	task: string;
	baseProfileId?: string;
	model?: TaskProfileModelSelection;
	toolNames?: readonly string[];
	resourceProfileNames?: readonly string[];
	budget?: RiskBudget;
}

export interface TaskProfileInspection {
	baseProfiles: Array<{ profileId: string; role: string; description: string }>;
	models: Array<{
		provider: string;
		modelId: string;
		thinkingLevels: readonly OrchestrationThinkingLevel[];
	}>;
}

export interface TaskProfileCreateResult {
	created: boolean;
	reason?: string;
	profileId?: string;
	baseProfileId?: string;
	changedFields?: string[];
}

export interface TaskProfileWriterPort {
	inspectTaskProfileOptions(): TaskProfileInspection;
	createTaskProfile(input: TaskProfileCreateInput): TaskProfileCreateResult;
}

export interface TaskProfileWriterOptions {
	agentDir: string;
	cwd: string;
	store: SessionTaskProfileStore;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	isModelExhausted(provider: string, modelId: string): boolean;
	getActiveOrchestrationProfile(): OrchestrationProfile | undefined;
}

const MAX_INSPECTED_MODELS = 64;
const MAX_TASK_DESCRIPTION_LENGTH = 3_500;
const MAX_BUDGET_KEYS = ["maxTokens", "maxWallClockMs", "maxCostUsd", "maxAttempts", "maxToolCalls"] as const;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExactSubset(candidate: readonly string[], ceiling: readonly string[]): boolean {
	const allowed = new Set(ceiling);
	const unique = new Set(candidate);
	return unique.size === candidate.length && candidate.every((value) => allowed.has(value));
}

function narrowBudget(base: RiskBudget, patch: RiskBudget | undefined): RiskBudget | undefined {
	if (!patch) return structuredClone(base);
	const narrowed: RiskBudget = { ...base };
	for (const key of MAX_BUDGET_KEYS) {
		const requested = patch[key];
		if (requested === undefined) continue;
		const ceiling = base[key];
		if (ceiling !== undefined && requested > ceiling) return undefined;
		narrowed[key] = requested;
	}
	if (patch.requireApprovalAboveCostUsd !== undefined) {
		const ceiling = base.requireApprovalAboveCostUsd;
		if (ceiling !== undefined && patch.requireApprovalAboveCostUsd > ceiling) return undefined;
		narrowed.requireApprovalAboveCostUsd = patch.requireApprovalAboveCostUsd;
	}
	return narrowed;
}

function sameBudget(left: RiskBudget, right: RiskBudget): boolean {
	return (
		MAX_BUDGET_KEYS.every((key) => left[key] === right[key]) &&
		left.requireApprovalAboveCostUsd === right.requireApprovalAboveCostUsd
	);
}

function sameModelPolicy(left: OrchestrationModelPolicy, right: OrchestrationModelPolicy): boolean {
	return (
		left.mode === right.mode &&
		left.candidates.length === right.candidates.length &&
		left.candidates.every((candidate, index) => {
			const other = right.candidates[index];
			return (
				other !== undefined &&
				candidate.provider === other.provider &&
				candidate.modelId === other.modelId &&
				candidate.thinkingLevel === other.thinkingLevel
			);
		})
	);
}

export class TaskProfileWriter implements TaskProfileWriterPort {
	private readonly options: TaskProfileWriterOptions;

	constructor(options: TaskProfileWriterOptions) {
		this.options = options;
	}

	inspectTaskProfileOptions(): TaskProfileInspection {
		const baseProfiles = this.authorizedBaseProfiles().map((profile) => ({
			profileId: profile.profileId,
			role: profile.role,
			description: profile.description,
		}));
		const models = this.options
			.getModelRegistry()
			.getAvailable()
			.filter((model) => !this.options.isModelExhausted(model.provider, model.id))
			.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
			.slice(0, MAX_INSPECTED_MODELS)
			.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				thinkingLevels: getSupportedThinkingLevels(model),
			}));
		return { baseProfiles, models };
	}

	createTaskProfile(input: TaskProfileCreateInput): TaskProfileCreateResult {
		try {
			const task = input.task.trim();
			if (!task || task.length > MAX_TASK_DESCRIPTION_LENGTH) {
				return { created: false, reason: "task_profile_description_invalid" };
			}
			const bases = this.authorizedBaseProfiles();
			const baseProfileId = input.baseProfileId?.trim() || (bases.length === 1 ? bases[0].profileId : undefined);
			if (!baseProfileId) return { created: false, reason: "task_profile_base_required" };
			const ownerProfiles = this.loadOwnerProfiles();
			const base = ownerProfiles.get(baseProfileId);
			if (!base || base.role === "orchestrator") {
				return { created: false, reason: "task_profile_base_not_found" };
			}
			if (!bases.some((candidate) => candidate.profileId === baseProfileId)) {
				return { created: false, reason: "task_profile_base_not_authorized" };
			}

			const toolNames = input.toolNames ? [...input.toolNames] : [...base.toolNames];
			if (!isExactSubset(toolNames, base.toolNames)) {
				return { created: false, reason: "task_profile_tool_authority_expansion" };
			}
			const resourceProfileNames = input.resourceProfileNames
				? [...input.resourceProfileNames]
				: [...base.resourceProfileNames];
			if (!isExactSubset(resourceProfileNames, base.resourceProfileNames)) {
				return { created: false, reason: "task_profile_resource_authority_expansion" };
			}
			const budget = narrowBudget(base.budget, input.budget);
			if (!budget) return { created: false, reason: "task_profile_budget_expansion" };

			let modelPolicy = structuredClone(base.modelPolicy);
			if (input.model) {
				const binding: OrchestrationModelBinding = { ...input.model };
				const resolved = resolvePinnedOrchestrationModel(binding, this.options.getModelRegistry(), (model) =>
					this.options.isModelExhausted(model.provider, model.id),
				);
				if (!resolved) return { created: false, reason: "task_profile_model_unavailable" };
				modelPolicy = { mode: "fixed", candidates: [binding] };
			}

			const now = new Date().toISOString();
			const profile = structuredClone(base);
			delete profile.sourcePath;
			profile.profileId = `task-${randomUUID()}`;
			profile.description = `Task-scoped worker: ${task}`.slice(0, MAX_ORCHESTRATION_DESCRIPTION_LENGTH);
			profile.modelPolicy = modelPolicy;
			profile.toolNames = toolNames;
			profile.resourceProfileNames = resourceProfileNames;
			profile.budget = budget;
			profile.createdAt = now;
			profile.updatedAt = now;
			validateOrchestrationProfile(profile);

			const activeProfile = this.options.getActiveOrchestrationProfile();
			this.options.store.append({
				baseProfileId,
				...(activeProfile ? { authorProfileId: activeProfile.profileId } : {}),
				profile,
			});
			const changedFields = ["description"];
			if (input.model && !sameModelPolicy(modelPolicy, base.modelPolicy)) changedFields.push("model");
			if (!sameStrings(toolNames, base.toolNames)) changedFields.push("tools");
			if (!sameStrings(resourceProfileNames, base.resourceProfileNames)) changedFields.push("resources");
			if (!sameBudget(budget, base.budget)) changedFields.push("budget");
			return { created: true, profileId: profile.profileId, baseProfileId, changedFields };
		} catch (error) {
			return { created: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	private authorizedBaseProfiles(): OrchestrationProfile[] {
		const active = this.options.getActiveOrchestrationProfile();
		if (active && active.role !== "orchestrator") return [];
		const allowed = active ? new Set(active.dispatchProfileIds) : undefined;
		return [...this.loadOwnerProfiles().values()].filter(
			(profile) => profile.role !== "orchestrator" && (!allowed || allowed.has(profile.profileId)),
		);
	}

	private loadOwnerProfiles(): ReadonlyMap<string, OrchestrationProfile> {
		const profiles = new OrchestrationProfileStore({
			agentDir: this.options.agentDir,
			cwd: this.options.cwd,
			projectTrusted: this.options.getSettingsManager().isProjectTrusted(),
		}).load().profiles;
		return new Map(profiles.map((profile) => [profile.profileId, profile]));
	}
}
