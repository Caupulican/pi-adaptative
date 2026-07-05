import type { Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import { FitnessStore } from "../models/fitness-store.ts";
import { evaluateSurfaceFitness, type FitnessGatedSurface } from "./fitness-gate.ts";
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

function collectFitnessGateDiagnostic(
	label: "cheap model" | "medium model" | "expensive model",
	surface: FitnessGatedSurface,
	modelPattern: string | undefined,
	modelRegistry: ModelRegistry,
	agentDir: string | undefined,
): string[] {
	if (!agentDir || !modelPattern) return [];
	const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry });
	if (!resolved.model || !modelRegistry.hasConfiguredAuth(resolved.model)) return [];
	const modelRef = formatModel(resolved.model);
	const fitness = FitnessStore.forAgentDir(agentDir)
		.getForHost()
		.find((entry) => entry.model === modelRef);
	const verdict = evaluateSurfaceFitness(surface, fitness?.report);
	if (verdict.fit) return [];
	if (verdict.reason === "unprobed") return [`Model router ${label} is unprobed for the fitness gate: ${modelRef}.`];
	return [
		`Model router ${label} is unfit for the fitness gate: ${modelRef} (${verdict.lane} ${verdict.succeeded}/${verdict.total}).`,
	];
}

export function collectModelRouterConfigDiagnostics(
	settings: ModelRouterStatusSettings,
	modelRegistry: ModelRegistry,
	agentDir?: string,
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
		...(settings.fitnessGate
			? [
					...collectFitnessGateDiagnostic(
						"cheap model",
						"router_cheap",
						settings.cheapModel,
						modelRegistry,
						agentDir,
					),
					...collectFitnessGateDiagnostic(
						"medium model",
						"router_medium",
						settings.mediumModel,
						modelRegistry,
						agentDir,
					),
					...collectFitnessGateDiagnostic(
						"expensive model",
						"router_expensive",
						settings.expensiveModel,
						modelRegistry,
						agentDir,
					),
				]
			: []),
	];
}
