import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import type { Api, Model } from "@caupulican/pi-ai/types";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationModelBinding, OrchestrationProfile } from "./contracts.ts";

export interface ResolvedOrchestrationModel {
	model: Model<Api>;
	binding: OrchestrationModelBinding;
}

export function resolvePinnedOrchestrationModel(
	binding: OrchestrationModelBinding,
	modelRegistry: ModelRegistry,
	isUnavailable: (model: Model<Api>) => boolean = () => false,
): ResolvedOrchestrationModel | undefined {
	const model = modelRegistry.find(binding.provider, binding.modelId);
	if (
		!model ||
		!modelRegistry.hasConfiguredAuth(model) ||
		isUnavailable(model) ||
		!getSupportedThinkingLevels(model).includes(binding.thinkingLevel)
	) {
		return undefined;
	}
	return { model, binding: structuredClone(binding) };
}

/**
 * Resolve an owner-authored model policy without weakening it. Fixed policies never fall through;
 * ordered policies use only their declared order, and every candidate must have configured auth
 * plus exact support for its pinned thinking level.
 */
export function resolveConfiguredOrchestrationModel(
	profile: OrchestrationProfile,
	modelRegistry: ModelRegistry,
	isUnavailable: (model: Model<Api>) => boolean = () => false,
): ResolvedOrchestrationModel | undefined {
	for (const binding of profile.modelPolicy.candidates) {
		const resolved = resolvePinnedOrchestrationModel(binding, modelRegistry, isUnavailable);
		if (!resolved) {
			if (profile.modelPolicy.mode === "fixed") return undefined;
			continue;
		}
		return resolved;
	}
	return undefined;
}
