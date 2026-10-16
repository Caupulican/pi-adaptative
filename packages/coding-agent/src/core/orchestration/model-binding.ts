import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import type { Api, Model, ModelThinkingLevel } from "@caupulican/pi-ai/types";
import type { OrchestrationModelBinding, OrchestrationProfile } from "./contracts.ts";

/** The model registry members this module uses, declared by the module itself; the composition root passes the ModelRegistry. */
export interface ModelBindingModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	isModelInProviderScope(model: Model<Api>): boolean;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface ResolvedOrchestrationModel {
	model: Model<Api>;
	binding: OrchestrationModelBinding;
}

/** Why the host reports a model unusable right now: its quota is exhausted, or the owner's account does not offer it. */
export type OrchestrationModelUnusableCause =
	| "model_quota_exhausted"
	| "model_account_refused"
	| "model_account_rejected"
	| "model_account_unlisted";

/**
 * A gate a binding failed, named for what that gate tests:
 * - `model_not_found`: the registry has no model with this provider and id.
 * - `model_out_of_scope`: the provider's verified model scope does not offer the model.
 * - `auth_missing`: no configured credentials for the provider.
 * - `model_account_refused`, `model_account_rejected`, `model_account_unlisted`: the host reports the model unusable, and
 *   no wait can make it usable.
 * - `model_quota_exhausted`: never a refusal of a fixed binding, which is admitted and waits for the recorded reset at
 *   the admission gate. An ordered candidate out of quota is skipped, and is recorded as this refusal only when every
 *   candidate is skipped.
 * - `thinking_level_unsupported`: the pinned thinking level is outside the model's supported set. It carries that set,
 *   so the caller can choose a level the model accepts without another lookup.
 */
export type OrchestrationModelRefusal =
	| { cause: "model_not_found" | "model_out_of_scope" | "auth_missing" | OrchestrationModelUnusableCause }
	| { cause: "thinking_level_unsupported"; supportedThinkingLevels: readonly ModelThinkingLevel[] };

export type OrchestrationModelResolution =
	/**
	 * `quotaExhausted`: the model is out of quota. A fixed binding is admitted anyway, and the admission gate waits for the
	 * recorded reset; an ordered candidate is skipped, so the policy moves to its next candidate.
	 */
	| { ok: true; resolved: ResolvedOrchestrationModel; quotaExhausted: boolean }
	/** Non-empty for a pinned binding; an ordered policy lists each distinct refusal across its candidates, in order. */
	| { ok: false; refusals: OrchestrationModelRefusal[] };

/** The reason suffix every resolver reports, e.g. `model_not_found,thinking_level_unsupported(off|low|high)`. */
export function formatOrchestrationModelRefusals(refusals: readonly OrchestrationModelRefusal[]): string {
	return refusals
		.map((refusal) =>
			refusal.cause === "thinking_level_unsupported"
				? `${refusal.cause}(${refusal.supportedThinkingLevels.join("|")})`
				: refusal.cause,
		)
		.join(",");
}

export function resolvePinnedOrchestrationModelResolution(
	binding: OrchestrationModelBinding,
	modelRegistry: ModelBindingModelSource,
	unusableCause: (model: Model<Api>) => OrchestrationModelUnusableCause | undefined = () => undefined,
): OrchestrationModelResolution {
	const model = modelRegistry.find(binding.provider, binding.modelId);
	if (!model) return { ok: false, refusals: [{ cause: "model_not_found" }] };
	if (!modelRegistry.isModelInProviderScope(model)) return { ok: false, refusals: [{ cause: "model_out_of_scope" }] };
	if (!modelRegistry.hasConfiguredAuth(model)) return { ok: false, refusals: [{ cause: "auth_missing" }] };
	const unusable = unusableCause(model);
	if (unusable !== undefined && unusable !== "model_quota_exhausted") {
		return { ok: false, refusals: [{ cause: unusable }] };
	}
	const supportedThinkingLevels = getSupportedThinkingLevels(model);
	if (!supportedThinkingLevels.includes(binding.thinkingLevel)) {
		return { ok: false, refusals: [{ cause: "thinking_level_unsupported", supportedThinkingLevels }] };
	}
	return {
		ok: true,
		resolved: { model, binding: structuredClone(binding) },
		quotaExhausted: unusable !== undefined,
	};
}

export function resolvePinnedOrchestrationModel(
	binding: OrchestrationModelBinding,
	modelRegistry: ModelBindingModelSource,
	unusableCause: (model: Model<Api>) => OrchestrationModelUnusableCause | undefined = () => undefined,
): ResolvedOrchestrationModel | undefined {
	const outcome = resolvePinnedOrchestrationModelResolution(binding, modelRegistry, unusableCause);
	return outcome.ok ? outcome.resolved : undefined;
}

/**
 * Resolve an owner-authored model policy without weakening it. Fixed policies never fall through;
 * ordered policies use only their declared order, and every candidate must have configured auth
 * plus exact support for its pinned thinking level.
 */
export function resolveConfiguredOrchestrationModelResolution(
	profile: OrchestrationProfile,
	modelRegistry: ModelBindingModelSource,
	unusableCause: (model: Model<Api>) => OrchestrationModelUnusableCause | undefined = () => undefined,
): OrchestrationModelResolution {
	const refusals: OrchestrationModelRefusal[] = [];
	const seen = new Set<string>();
	for (const binding of profile.modelPolicy.candidates) {
		const outcome = resolvePinnedOrchestrationModelResolution(binding, modelRegistry, unusableCause);
		if (outcome.ok && !outcome.quotaExhausted) return outcome;
		if (profile.modelPolicy.mode === "fixed") return outcome;
		// An ordered candidate out of quota is skipped, so the policy moves on to its next candidate.
		const found: OrchestrationModelRefusal[] = outcome.ok ? [{ cause: "model_quota_exhausted" }] : outcome.refusals;
		for (const refusal of found) {
			const text = formatOrchestrationModelRefusals([refusal]);
			if (seen.has(text)) continue;
			seen.add(text);
			refusals.push(refusal);
		}
	}
	return { ok: false, refusals };
}

export function resolveConfiguredOrchestrationModel(
	profile: OrchestrationProfile,
	modelRegistry: ModelBindingModelSource,
	unusableCause: (model: Model<Api>) => OrchestrationModelUnusableCause | undefined = () => undefined,
): ResolvedOrchestrationModel | undefined {
	const outcome = resolveConfiguredOrchestrationModelResolution(profile, modelRegistry, unusableCause);
	return outcome.ok ? outcome.resolved : undefined;
}
