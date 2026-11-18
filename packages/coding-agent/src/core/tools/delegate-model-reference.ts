/** Resolve the public delegate model field before it becomes an exact worker admission request. */
import type { Api, Model } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { resolveWorkerModelReference } from "../model-router/candidate-pool.ts";
import {
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../orchestration/contracts.ts";
import { resolveModelFavorites } from "../settings/model-routing-settings.ts";
import type { Settings } from "../settings/settings-schema.ts";

export const delegateModelReferenceSchema = Type.Optional(
	Type.Union(
		[
			Type.String({
				minLength: 1,
				maxLength: MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH + 1 + MAX_ORCHESTRATION_MODEL_ID_LENGTH,
			}),
			Type.Object(
				{
					provider: Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH }),
					modelId: Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_MODEL_ID_LENGTH }),
				},
				{ additionalProperties: false },
			),
		],
		{
			description:
				'Model reference: a unique favorite shorthand such as "sol", exact "provider/modelId", or {provider, modelId}. Use agentId only for an existing worker.',
		},
	),
);

type ExactModel = { provider: string; modelId: string };
export type DelegateModelResolver = (reference: string) => ReturnType<typeof resolveWorkerModelReference>;

export function bindDelegateModelResolver(source: {
	getSettingsManager(): { settings: Pick<Settings, "modelFavorites"> };
	getModelRegistry(): { getAll(): readonly Model<Api>[] };
	getScopedModelCandidates?(): readonly Model<Api>[];
}): DelegateModelResolver {
	return (reference) =>
		resolveWorkerModelReference(reference, {
			favorites: resolveModelFavorites(source.getSettingsManager().settings),
			catalog: () => source.getModelRegistry().getAll(),
			available: () => source.getScopedModelCandidates?.() ?? [],
		});
}

export function resolveDelegateModelInput<Input extends { model?: string | ExactModel }>(
	input: Input,
	resolve: DelegateModelResolver = resolveWorkerModelReference,
):
	| { ok: true; input: Omit<Input, "model"> & { model?: ExactModel } }
	| { ok: false; message: string; skipReason: string } {
	const { model, ...fields } = input;
	if (typeof model !== "string") return { ok: true, input: { ...fields, ...(model ? { model } : {}) } };
	const outcome = resolve(model);
	if (outcome.ok) return { ok: true, input: { ...fields, model: outcome.model } };
	const candidates = outcome.candidates.join(", ");
	const remedy =
		outcome.reason === "ambiguous"
			? `Use an exact provider/modelId: ${candidates}.`
			: outcome.reason === "unavailable"
				? `${candidates} is a configured favorite but is unavailable in this session. Ask the owner to restore access or choose a different model.`
				: `Use a unique favorite name or an exact provider/modelId.${candidates ? ` Configured favorites include ${candidates}.` : ""}`;
	return {
		ok: false,
		message: `Worker model reference is ${outcome.reason}. ${remedy}`,
		skipReason: `delegate_model_reference_${outcome.reason}`,
	};
}
