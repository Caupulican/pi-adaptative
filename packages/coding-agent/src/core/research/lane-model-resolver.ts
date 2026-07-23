import type { Api, Model } from "@caupulican/pi-ai";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import type { NormalizedProfile } from "../profile-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface LaneModelResolverDeps {
	getCwd(): string;
	getModel(): Model<Api> | undefined;
	getModelRegistry(): ModelRegistry;
	getSettingsManager(): SettingsManager;
	isModelExhausted(model: Model<Api>): boolean;
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
		if (configuredPattern) {
			const resolved = resolveCliModel({
				cliModel: configuredPattern,
				modelRegistry: this.deps.getModelRegistry(),
			});
			if (resolved.model && this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) {
				return resolved.model;
			}
			return undefined;
		}
		return this.deps.getModel() ?? undefined;
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
