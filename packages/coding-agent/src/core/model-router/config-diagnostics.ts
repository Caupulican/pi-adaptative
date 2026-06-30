import type { Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import type { ModelRouterStatusSettings } from "./status.ts";

function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function collectModelRouterModelDiagnostics(
	label: "cheap model" | "medium model" | "expensive model",
	settingKey: "modelRouter.cheapModel" | "modelRouter.mediumModel" | "modelRouter.expensiveModel",
	modelPattern: string | undefined,
	modelRegistry: ModelRegistry,
): string[] {
	if (!modelPattern) {
		return [`Model router ${label} is unset; configure ${settingKey} or disable modelRouter.enabled.`];
	}
	const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry });
	if (!resolved.model) {
		return [`Model router ${label} is unresolved: ${modelPattern}.`];
	}
	if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
		return [`Model router ${label} is missing auth: ${formatModel(resolved.model)}.`];
	}
	return [];
}

export function collectModelRouterConfigDiagnostics(
	settings: ModelRouterStatusSettings,
	modelRegistry: ModelRegistry,
): string[] {
	if (!settings.enabled) return [];
	return [
		...collectModelRouterModelDiagnostics(
			"cheap model",
			"modelRouter.cheapModel",
			settings.cheapModel,
			modelRegistry,
		),
		...collectModelRouterModelDiagnostics(
			"medium model",
			"modelRouter.mediumModel",
			settings.mediumModel,
			modelRegistry,
		),
		...collectModelRouterModelDiagnostics(
			"expensive model",
			"modelRouter.expensiveModel",
			settings.expensiveModel,
			modelRegistry,
		),
	];
}
