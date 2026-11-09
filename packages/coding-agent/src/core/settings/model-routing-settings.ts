/**
 * Model settings the manager resolves for the session: the model router (with active-profile overrides and its
 * normalizer), the System One switch, the model capability mode, the peer advisor, the model favorites and the Bedrock
 * verification scope. The resolvers are pure; the manager delegates to them.
 */

import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../expert-routing/vocabulary.ts";
import type { SystemOneProviderChoice } from "../system-one/access.ts";
import {
	DEFAULT_MODEL_CAPABILITY_MODE,
	DEFAULT_MODEL_ROUTER_POOL_PREFERENCE,
	DEFAULT_MODEL_ROUTER_SELECTION_MODE,
	isHmoeIndependence,
	isHmoePreference,
	isHmoePreset,
	isHmoeTeamStrategy,
	isModelRouterPoolPreference,
	isModelRouterSelectionMode,
	isThinkingLevel,
	normalizeBedrockScopeSettings,
	normalizeHmoeWeights,
} from "./settings-rules.ts";
import type {
	AdvisorSettings,
	BedrockScopeSettings,
	ModelCapabilityMode,
	ModelCapabilitySettings,
	ModelFavorite,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	Settings,
	SystemOneSettings,
	ThinkingLevel,
} from "./settings-schema.ts";

/**
 * The model router as written to settings: enumerations and thinking levels validated, model ids trimmed, weights
 * normalized.
 */
export function normalizeModelRouterSettings(settings: ModelRouterSettings): ModelRouterSettings {
	return {
		enabled: settings.enabled ?? false,
		selectionMode: isModelRouterSelectionMode(settings.selectionMode)
			? settings.selectionMode
			: DEFAULT_MODEL_ROUTER_SELECTION_MODE,
		poolPreference: isModelRouterPoolPreference(settings.poolPreference)
			? settings.poolPreference
			: DEFAULT_MODEL_ROUTER_POOL_PREFERENCE,
		cheapModel: settings.cheapModel?.trim() || undefined,
		mediumModel: settings.mediumModel?.trim() || undefined,
		expensiveModel: settings.expensiveModel?.trim() || undefined,
		learningModel: settings.learningModel?.trim() || undefined,
		fitnessGate: settings.fitnessGate ?? false,
		executorModel: settings.executorModel?.trim() || undefined,
		cheapThinking: isThinkingLevel(settings.cheapThinking) ? settings.cheapThinking : undefined,
		mediumThinking: isThinkingLevel(settings.mediumThinking) ? settings.mediumThinking : undefined,
		expensiveThinking: isThinkingLevel(settings.expensiveThinking) ? settings.expensiveThinking : undefined,
		executorThinking: isThinkingLevel(settings.executorThinking) ? settings.executorThinking : undefined,
		hmoePreset: isHmoePreset(settings.hmoePreset) ? settings.hmoePreset : undefined,
		hmoeTeamStrategy: isHmoeTeamStrategy(settings.hmoeTeamStrategy) ? settings.hmoeTeamStrategy : undefined,
		hmoeIndependence: isHmoeIndependence(settings.hmoeIndependence) ? settings.hmoeIndependence : undefined,
		hmoePreference: isHmoePreference(settings.hmoePreference) ? settings.hmoePreference : undefined,
		hmoeWeights: normalizeHmoeWeights(settings.hmoeWeights),
	};
}

/**
 * The effective model router: stored values with invalid ones defaulted, overridden field by field by the active
 * profile.
 */
export function resolveModelRouterSettings(
	merged: Pick<Settings, "modelRouter">,
	profileSettings: ModelRouterSettings | undefined,
	defaultEnabled: boolean,
): {
	enabled: boolean;
	selectionMode: ModelRouterSelectionMode;
	poolPreference: ModelRouterPoolPreference;
	cheapModel?: string;
	mediumModel?: string;
	expensiveModel?: string;
	learningModel?: string;
	executorModel?: string;
	fitnessGate: boolean;
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel;
	hmoePreset?: HmoePreset;
	hmoeTeamStrategy?: HmoeTeamStrategy;
	hmoeIndependence?: HmoeIndependence;
	hmoePreference?: HmoePreference;
	hmoeWeights?: HmoeWeights;
} {
	const settings = {
		enabled: merged.modelRouter?.enabled ?? defaultEnabled,
		selectionMode: isModelRouterSelectionMode(merged.modelRouter?.selectionMode)
			? merged.modelRouter.selectionMode
			: DEFAULT_MODEL_ROUTER_SELECTION_MODE,
		poolPreference: isModelRouterPoolPreference(merged.modelRouter?.poolPreference)
			? merged.modelRouter.poolPreference
			: DEFAULT_MODEL_ROUTER_POOL_PREFERENCE,
		cheapModel: merged.modelRouter?.cheapModel?.trim() || undefined,
		mediumModel: merged.modelRouter?.mediumModel?.trim() || undefined,
		expensiveModel: merged.modelRouter?.expensiveModel?.trim() || undefined,
		learningModel: merged.modelRouter?.learningModel?.trim() || undefined,
		fitnessGate: merged.modelRouter?.fitnessGate ?? false,
		executorModel: merged.modelRouter?.executorModel?.trim() || undefined,
		cheapThinking: isThinkingLevel(merged.modelRouter?.cheapThinking) ? merged.modelRouter?.cheapThinking : undefined,
		mediumThinking: isThinkingLevel(merged.modelRouter?.mediumThinking)
			? merged.modelRouter?.mediumThinking
			: undefined,
		expensiveThinking: isThinkingLevel(merged.modelRouter?.expensiveThinking)
			? merged.modelRouter?.expensiveThinking
			: undefined,
		executorThinking: isThinkingLevel(merged.modelRouter?.executorThinking)
			? merged.modelRouter?.executorThinking
			: undefined,
		hmoePreset: merged.modelRouter?.hmoePreset,
		hmoeTeamStrategy: merged.modelRouter?.hmoeTeamStrategy,
		hmoeIndependence: merged.modelRouter?.hmoeIndependence,
		hmoePreference: merged.modelRouter?.hmoePreference,
		hmoeWeights: merged.modelRouter?.hmoeWeights,
	};
	return {
		enabled: profileSettings?.enabled ?? settings.enabled,
		selectionMode: profileSettings?.selectionMode ?? settings.selectionMode,
		poolPreference: profileSettings?.poolPreference ?? settings.poolPreference,
		cheapModel: profileSettings?.cheapModel?.trim() || settings.cheapModel,
		mediumModel: profileSettings?.mediumModel?.trim() || settings.mediumModel,
		expensiveModel: profileSettings?.expensiveModel?.trim() || settings.expensiveModel,
		learningModel: profileSettings?.learningModel?.trim() || settings.learningModel,
		fitnessGate: profileSettings?.fitnessGate ?? settings.fitnessGate,
		executorModel: profileSettings?.executorModel?.trim() || settings.executorModel,
		cheapThinking: profileSettings?.cheapThinking ?? settings.cheapThinking,
		mediumThinking: profileSettings?.mediumThinking ?? settings.mediumThinking,
		expensiveThinking: profileSettings?.expensiveThinking ?? settings.expensiveThinking,
		executorThinking: profileSettings?.executorThinking ?? settings.executorThinking,
		hmoePreset: profileSettings?.hmoePreset ?? settings.hmoePreset,
		hmoeTeamStrategy: profileSettings?.hmoeTeamStrategy ?? settings.hmoeTeamStrategy,
		hmoeIndependence: profileSettings?.hmoeIndependence ?? settings.hmoeIndependence,
		hmoePreference: profileSettings?.hmoePreference ?? settings.hmoePreference,
		hmoeWeights: profileSettings?.hmoeWeights ?? settings.hmoeWeights,
	};
}

/** System One's enablement, provider choice, and the loop and completion modes when they hold a known value. */
export function resolveSystemOneSettings(settings: Pick<Settings, "systemOne">): {
	enabled: boolean;
	provider: SystemOneProviderChoice;
	loopMode?: SystemOneSettings["loopMode"];
	completionProfile?: SystemOneSettings["completionProfile"];
} {
	const raw = settings.systemOne;
	const loopMode =
		raw?.loopMode === "legacy_goal" || raw?.loopMode === "objective_shadow" || raw?.loopMode === "objective_primary"
			? raw.loopMode
			: undefined;
	const completionProfile =
		raw?.completionProfile === "mechanical" ||
		raw?.completionProfile === "mechanical_plus_reviewer" ||
		raw?.completionProfile === "semantic_enhanced" ||
		raw?.completionProfile === "system_one_required"
			? raw.completionProfile
			: undefined;
	return {
		enabled: raw?.enabled ?? true,
		provider: raw?.provider === "typesafe" || raw?.provider === "openrouter" ? raw.provider : "auto",
		...(loopMode ? { loopMode } : {}),
		...(completionProfile ? { completionProfile } : {}),
	};
}

/** The model capability mode, the default when unset or unknown. */
export function resolveModelCapabilitySettings(
	settings: Pick<Settings, "modelCapability">,
): Required<ModelCapabilitySettings> {
	const configured = settings.modelCapability?.mode;
	const mode: ModelCapabilityMode =
		configured === "auto" ||
		configured === "off" ||
		configured === "full" ||
		configured === "lean" ||
		configured === "minimal" ||
		configured === "chat"
			? configured
			: DEFAULT_MODEL_CAPABILITY_MODE;
	return { mode };
}

/** The peer advisor settings, or the reason they are off when the stored value is malformed. */
export function resolveAdvisorSettings(
	settings: Pick<Settings, "advisor">,
): AdvisorSettings & { enabled: boolean; error?: string } {
	const configured = settings.advisor;
	if (configured === undefined) return { enabled: true };
	if (!configured || typeof configured !== "object" || Array.isArray(configured))
		return { enabled: false, error: "Peer settings must be an object." };
	if (configured.enabled !== undefined && typeof configured.enabled !== "boolean")
		return { enabled: false, error: "Peer enabled must be a boolean." };
	if (
		configured.model !== undefined &&
		(typeof configured.model !== "string" || !configured.model.trim() || !configured.model.includes("/"))
	)
		return { enabled: false, error: "Peer model must be an exact nonempty provider/model reference." };
	if (configured.thinkingLevel !== undefined && !isThinkingLevel(configured.thinkingLevel))
		return { enabled: false, error: "Peer thinkingLevel is unsupported." };
	return { enabled: configured.enabled ?? true, model: configured.model, thinkingLevel: configured.thinkingLevel };
}

/** The model favorites, deduplicated and trimmed; malformed entries are skipped. */
export function resolveModelFavorites(settings: Pick<Settings, "modelFavorites">): ModelFavorite[] {
	const favorites = settings.modelFavorites;
	if (!Array.isArray(favorites)) return [];
	const seen = new Set<string>();
	const result: ModelFavorite[] = [];
	for (const favorite of favorites) {
		if (!favorite || typeof favorite.provider !== "string" || typeof favorite.modelId !== "string") continue;
		const provider = favorite.provider.trim();
		const modelId = favorite.modelId.trim();
		if (!provider || !modelId) continue;
		const key = `${provider}\u0000${modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ provider, modelId });
	}
	return result;
}

/** The model favorites unioned with the given provider/model references, without persisting them. */
export function resolveModelFavoritesIncluding(
	settings: Pick<Settings, "modelFavorites">,
	refs: readonly string[],
): ModelFavorite[] {
	const favorites = resolveModelFavorites(settings);
	const seen = new Set(favorites.map((entry) => `${entry.provider}\u0000${entry.modelId}`));
	for (const ref of refs) {
		const slash = ref.indexOf("/");
		const provider = ref.slice(0, slash).trim();
		const modelId = ref.slice(slash + 1).trim();
		if (slash <= 0 || !provider || !modelId) throw new Error(`Invalid model favorite reference: ${ref}`);
		const key = `${provider}\u0000${modelId}`;
		if (!seen.has(key)) {
			favorites.push({ provider, modelId });
			seen.add(key);
		}
	}
	return favorites;
}

/** The Bedrock verification scope, normalized, or undefined when none is stored. */
export function resolveBedrockScopeSettings(bedrock: Settings["bedrock"]): BedrockScopeSettings | undefined {
	const scope = normalizeBedrockScopeSettings(bedrock);
	return scope
		? {
				...scope,
				modelIds: [...scope.modelIds],
			}
		: undefined;
}
