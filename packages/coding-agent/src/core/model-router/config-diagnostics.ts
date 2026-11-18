import type { Model } from "@caupulican/pi-ai";
import type { Api } from "@caupulican/pi-ai/types";
import { resolveCliModel } from "../model-resolver.ts";
import { type FitnessReportLookup, FitnessStore } from "../models/fitness-store.ts";
import { evaluateModelFitness, type FitnessGatedSurface } from "./fitness-gate.ts";
import type { ModelRouterStatusSettings } from "./status.ts";

/** The model registry members this module uses, declared by the module itself; the composition root passes the ModelRegistry. */
export interface ConfigDiagnosticsModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
}

function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function collectModelRouterModelDiagnostics(
	label: "cheap model" | "medium model" | "expensive model",
	settingKey: "modelRouter.cheapModel" | "modelRouter.mediumModel" | "modelRouter.expensiveModel",
	modelPattern: string | undefined,
	modelRegistry: ConfigDiagnosticsModelSource,
	selectionMode: ModelRouterStatusSettings["selectionMode"],
): string[] {
	if (!modelPattern) {
		// Outside manual mode an unset tier is chosen automatically from the candidate pool: nothing to configure.
		if (selectionMode !== "manual") return [];
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

function collectFitnessGateDiagnostic(
	label: "cheap model" | "medium model" | "expensive model",
	surface: FitnessGatedSurface,
	modelPattern: string | undefined,
	modelRegistry: ConfigDiagnosticsModelSource,
	fitness: FitnessReportLookup,
): string[] {
	if (!modelPattern) return [];
	const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry });
	if (!resolved.model || !modelRegistry.hasConfiguredAuth(resolved.model)) return [];
	const modelRef = formatModel(resolved.model);
	const verdict = evaluateModelFitness(surface, resolved.model, fitness);
	if (verdict.fit) return [];
	if (verdict.reason === "unprobed") return [`Model router ${label} is unprobed for the fitness gate: ${modelRef}.`];
	return [
		`Model router ${label} is unfit for the fitness gate: ${modelRef} (${verdict.lane} ${verdict.succeeded}/${verdict.total}).`,
	];
}

export function collectModelRouterConfigDiagnostics(
	settings: ModelRouterStatusSettings,
	modelRegistry: ConfigDiagnosticsModelSource,
	agentDir?: string,
): string[] {
	if (!settings.enabled) return [];
	const fitness =
		settings.fitnessGate && agentDir ? FitnessStore.forAgentDir(agentDir).createReportLookup() : undefined;
	return [
		...collectModelRouterModelDiagnostics(
			"cheap model",
			"modelRouter.cheapModel",
			settings.cheapModel,
			modelRegistry,
			settings.selectionMode,
		),
		...collectModelRouterModelDiagnostics(
			"medium model",
			"modelRouter.mediumModel",
			settings.mediumModel,
			modelRegistry,
			settings.selectionMode,
		),
		...collectModelRouterModelDiagnostics(
			"expensive model",
			"modelRouter.expensiveModel",
			settings.expensiveModel,
			modelRegistry,
			settings.selectionMode,
		),
		...(fitness
			? [
					...collectFitnessGateDiagnostic(
						"cheap model",
						"router_cheap",
						settings.cheapModel,
						modelRegistry,
						fitness,
					),
					...collectFitnessGateDiagnostic(
						"medium model",
						"router_medium",
						settings.mediumModel,
						modelRegistry,
						fitness,
					),
					...collectFitnessGateDiagnostic(
						"expensive model",
						"router_expensive",
						settings.expensiveModel,
						modelRegistry,
						fitness,
					),
				]
			: []),
	];
}
