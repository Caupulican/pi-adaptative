import { type Api, getSupportedThinkingLevels, type Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationModelBinding, OrchestrationProfile } from "./contracts.ts";

export interface ResolvedOrchestrationModel {
	model: Model<Api>;
	binding: OrchestrationModelBinding;
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
		const model = modelRegistry.find(binding.provider, binding.modelId);
		if (
			!model ||
			!modelRegistry.hasConfiguredAuth(model) ||
			isUnavailable(model) ||
			!getSupportedThinkingLevels(model).includes(binding.thinkingLevel)
		) {
			if (profile.modelPolicy.mode === "fixed") return undefined;
			continue;
		}
		return { model, binding: structuredClone(binding) };
	}
	return undefined;
}
