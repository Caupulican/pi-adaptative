import type { Api, Model } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import type { NormalizedProfile, ProfileRegistry } from "../profile-registry.ts";
import type { ModelCapabilitySettings } from "../settings/settings-schema.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface LaneModelResolverSettingsSource {
	getModelCapabilitySettings(): Required<ModelCapabilitySettings>;
	getProfileRegistry(): ProfileRegistry;
}

export interface LaneModelResolverDeps {
	getCwd(): string;
	getModel(): Model<Api> | undefined;
	getModelRegistry(): ModelRegistry;
	getSettingsManager(): LaneModelResolverSettingsSource;
	isModelExhausted(model: Model<Api>): boolean;
	/** The owner's live model policy; a lane model it disallows is reallocated. */
	isModelAllowed?(model: Model<Api>): boolean;
	allocateAllowedModel?(): Model<Api> | undefined;
}

export type LaneShipment =
	| { ok: true; model: Model<Api>; laneProfile?: NormalizedProfile }
	| { ok: false; skipReason: string };

export function clampLaneMaxUsd(settingsMaxUsd: number, foregroundMaxEstimatedUsd?: number): number {
	return Math.min(settingsMaxUsd, foregroundMaxEstimatedUsd ?? Number.POSITIVE_INFINITY);
}

/** Shared provider-neutral model/profile resolution for research and fitness lanes. */
export class LaneModelResolver {
	private readonly deps: LaneModelResolverDeps;

	constructor(deps: LaneModelResolverDeps) {
		this.deps = deps;
	}

	capabilityProfile(model: Model<Api>): ModelCapabilityProfile {
		return deriveModelCapabilityProfile({
			contextWindow: model.contextWindow,
			mode: this.deps.getSettingsManager().getModelCapabilitySettings().mode,
		});
	}

	resolveModel(configuredPattern: string | undefined): Model<Api> | undefined {
		const model = this.resolveConfiguredModel(configuredPattern);
		if (!model || !this.deps.isModelAllowed || this.deps.isModelAllowed(model)) return model;
		return this.deps.allocateAllowedModel?.();
	}

	private resolveConfiguredModel(configuredPattern: string | undefined): Model<Api> | undefined {
		if (configuredPattern) {
			const registry = this.deps.getModelRegistry();
			const resolved = resolveCliModel({
				cliModel: configuredPattern,
				modelRegistry: registry,
			});
			if (resolved.model) {
				if (registry.hasConfiguredAuth(resolved.model) && !this.deps.isModelExhausted(resolved.model)) {
					return resolved.model;
				}
				// Self-heal when a real catalog model had a stored credential that became unusable at runtime
				// (refused OAuth refresh or quota/account exhaustion): fail over to a healthy authenticated
				// model that satisfies the same local/egress and xhigh capabilities.
				const isCatalogModel = registry.find(resolved.model.provider, resolved.model.id) !== undefined;
				const hadStoredCredential =
					registry.authStorage.get(resolved.model.provider) !== undefined ||
					registry.hasConfiguredAuth(resolved.model);
				if (isCatalogModel && hadStoredCredential) {
					return this.resolveHealthyFallback(resolved.model);
				}
			}
			return undefined;
		}
		return this.deps.getModel() ?? undefined;
	}

	private resolveHealthyFallback(unusableModel: Model<Api>): Model<Api> | undefined {
		const registry = this.deps.getModelRegistry();
		const needsXhigh = getSupportedThinkingLevels(unusableModel).includes("xhigh");
		const localOnly = isLocalExecutionModel(unusableModel);
		const candidates: Array<Model<Api> | undefined> = [
			this.deps.getModel(),
			this.deps.allocateAllowedModel?.(),
			...registry.getAvailable(),
		];
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (candidate.provider === unusableModel.provider && candidate.id === unusableModel.id) continue;
			if (!registry.hasConfiguredAuth(candidate) || this.deps.isModelExhausted(candidate)) continue;
			if (localOnly && !isLocalExecutionModel(candidate)) continue;
			if (needsXhigh && !getSupportedThinkingLevels(candidate).includes("xhigh")) continue;
			return candidate;
		}
		return undefined;
	}

	resolveShipment(laneSettings: { model?: string; profile?: string }, missingModelReason: string): LaneShipment {
		let laneProfile: NormalizedProfile | undefined;
		if (laneSettings.profile) {
			const profileRef = laneSettings.profile.trim();
			const registry = this.deps.getSettingsManager().getProfileRegistry();
			laneProfile =
				profileRef.startsWith("./") || profileRef.startsWith("../")
					? registry.resolveProfileRef(profileRef, this.deps.getCwd())
					: registry.getProfile(profileRef);
			if (!laneProfile) return { ok: false, skipReason: "lane_profile_not_found" };
		}

		let model: Model<Api> | undefined;
		if (laneSettings.model) {
			model = this.resolveModel(laneSettings.model);
			if (!model) return { ok: false, skipReason: missingModelReason };
		} else if (laneProfile?.model) {
			model = this.resolveModel(laneProfile.model);
			if (!model) return { ok: false, skipReason: "no_lane_profile_model" };
		} else {
			model = this.deps.getModel() ?? undefined;
			if (!model) return { ok: false, skipReason: missingModelReason };
		}
		if (this.deps.isModelExhausted(model)) {
			return { ok: false, skipReason: `${model.provider}/${model.id} model exhausted: quota` };
		}
		return { ok: true, model, laneProfile };
	}
}
