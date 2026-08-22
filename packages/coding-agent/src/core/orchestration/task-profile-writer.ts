import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { LEAF_WORKER_DELEGATION_LIMITS } from "../delegation/worker-fleet-limits.ts";
import { resolveWorkerWorkspacePath } from "../delegation/worker-machine-scope.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type {
	OrchestrationModelBinding,
	OrchestrationModelPolicy,
	OrchestrationProfile,
	OrchestrationThinkingLevel,
} from "./contracts.ts";
import { MAX_ORCHESTRATION_DESCRIPTION_LENGTH } from "./contracts.ts";
import { resolvePinnedOrchestrationModel } from "./model-binding.ts";
import { validateOrchestrationProfile } from "./profile-registry.ts";
import { OrchestrationProfileStore } from "./profile-store.ts";
import type { SessionTaskProfileStore } from "./session-task-profile-store.ts";

export interface TaskProfileModelSelection {
	provider: string;
	modelId: string;
}

export interface TaskProfileCreateInput {
	task: string;
	baseProfileId?: string;
	model?: TaskProfileModelSelection;
	thinkingLevel?: OrchestrationThinkingLevel;
	path?: string;
	toolNames?: readonly string[];
}

export interface TaskProfileInspection {
	baseProfiles: Array<{ profileId: string; role: string; description: string }>;
	/** Exact native-lane surface a no-base profile inherits from the live foreground session. */
	inheritedToolNames: readonly string[];
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
	/** Host-compiled foreground inheritance used when no owner-authored base is selected. */
	getInheritedBaseProfile(): OrchestrationProfile | undefined;
}

const MAX_INSPECTED_MODELS = 64;
const MAX_TASK_DESCRIPTION_LENGTH = 3_500;
const INHERITED_BASE_PROFILE_ID = "inherited-foreground";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExactSubset(candidate: readonly string[], ceiling: readonly string[]): boolean {
	const allowed = new Set(ceiling);
	const unique = new Set(candidate);
	return unique.size === candidate.length && candidate.every((value) => allowed.has(value));
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
		return {
			baseProfiles,
			models,
			inheritedToolNames: [...(this.options.getInheritedBaseProfile()?.toolNames ?? [])],
		};
	}

	createTaskProfile(input: TaskProfileCreateInput): TaskProfileCreateResult {
		try {
			const task = input.task.trim();
			if (!task || task.length > MAX_TASK_DESCRIPTION_LENGTH) {
				return { created: false, reason: "task_profile_description_invalid" };
			}
			const requestedBaseProfileId = input.baseProfileId?.trim();
			let baseProfileId = INHERITED_BASE_PROFILE_ID;
			let base: OrchestrationProfile | undefined;
			if (requestedBaseProfileId) {
				baseProfileId = requestedBaseProfileId;
				base = this.loadOwnerProfiles().get(baseProfileId);
				if (!base || base.role === "orchestrator") {
					return { created: false, reason: "task_profile_base_not_found" };
				}
				if (!this.authorizedBaseProfiles().some((candidate) => candidate.profileId === baseProfileId)) {
					return { created: false, reason: "task_profile_base_not_authorized" };
				}
			} else {
				base = this.options.getInheritedBaseProfile();
				if (!base) return { created: false, reason: "task_profile_inherited_base_unavailable" };
			}

			const compatibleBaseToolNames = base.toolNames.filter((toolName) => toolName !== "delegate");
			const toolNames = input.toolNames ? [...input.toolNames] : compatibleBaseToolNames;
			if (!isExactSubset(toolNames, compatibleBaseToolNames)) {
				return { created: false, reason: "task_profile_tool_authority_expansion" };
			}
			const budget = structuredClone(base.budget);

			let modelPolicy = structuredClone(base.modelPolicy);
			if (input.model || input.thinkingLevel) {
				const baseBinding = base.modelPolicy.candidates[0];
				if (!baseBinding) return { created: false, reason: "task_profile_model_unavailable" };
				const provider = input.model?.provider ?? baseBinding.provider;
				const modelId = input.model?.modelId ?? baseBinding.modelId;
				const model = this.options.getModelRegistry().find(provider, modelId);
				if (!model) return { created: false, reason: "task_profile_model_unavailable" };
				const sameModel = provider === baseBinding.provider && modelId === baseBinding.modelId;
				const binding: OrchestrationModelBinding = {
					provider,
					modelId,
					thinkingLevel:
						input.thinkingLevel ??
						(sameModel ? baseBinding.thinkingLevel : resolveModelThinkingLevel(model, undefined)),
				};
				const resolved = resolvePinnedOrchestrationModel(binding, this.options.getModelRegistry(), (candidate) =>
					this.options.isModelExhausted(candidate.provider, candidate.id),
				);
				if (!resolved) return { created: false, reason: "task_profile_model_unavailable" };
				modelPolicy = { mode: "fixed", candidates: [binding] };
			}

			let workspacePath = base.workspacePath;
			if (input.path !== undefined) {
				const trimmedPath = input.path.trim();
				if (!trimmedPath) return { created: false, reason: "task_profile_path_invalid" };
				const requestedPath = resolveWorkerWorkspacePath(this.options.cwd, trimmedPath);
				if (base.workspacePath && !isPathWithinScope(requestedPath, base.workspacePath)) {
					return { created: false, reason: "task_profile_path_authority_expansion" };
				}
				workspacePath = requestedPath;
			}

			const now = new Date().toISOString();
			const profile = structuredClone(base);
			delete profile.sourcePath;
			profile.profileId = `task-${randomUUID()}`;
			profile.description = `Task-scoped worker: ${task}`.slice(0, MAX_ORCHESTRATION_DESCRIPTION_LENGTH);
			profile.modelPolicy = modelPolicy;
			profile.capabilityCeiling = base.capabilityCeiling.filter(
				(capability) => capability !== "workflow.delegate" && capability !== "memory.mutate",
			);
			profile.toolNames = toolNames;
			if (workspacePath) profile.workspacePath = workspacePath;
			else delete profile.workspacePath;
			profile.resourceProfileNames = [...base.resourceProfileNames];
			profile.dispatchProfileIds = [];
			profile.delegationLimits = structuredClone(LEAF_WORKER_DELEGATION_LIMITS);
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
			if ((input.model || input.thinkingLevel) && !sameModelPolicy(modelPolicy, base.modelPolicy)) {
				changedFields.push(input.model ? "model" : "thinking");
			}
			if (workspacePath !== base.workspacePath) changedFields.push("path");
			if (!sameStrings(toolNames, base.toolNames)) changedFields.push("tools");
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
