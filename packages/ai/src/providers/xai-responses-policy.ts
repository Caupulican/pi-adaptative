import type { Api, Model, ServiceTier } from "../types.ts";

/** Grok Build Fast is selected by model routing, separately from public API Priority Processing. */
export function resolveXaiBuildModelId(
	model: Model<Api>,
	serviceTier: ServiceTier | undefined,
): "grok-4.7" | "grok-4.7-build-fast" | undefined {
	if (
		model.provider !== "xai" ||
		model.api !== "openai-responses" ||
		!model.compat ||
		!("requestFormat" in model.compat) ||
		model.compat.requestFormat !== "xai-cli" ||
		(model.id !== "grok-4.7" && model.id !== "grok-4.7-build-fast")
	)
		return undefined;
	if (serviceTier === "priority") return "grok-4.7-build-fast";
	if (serviceTier === "default") return "grok-4.7";
	return serviceTier == null ? model.id : undefined;
}
