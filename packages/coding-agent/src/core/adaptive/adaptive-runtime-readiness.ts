/**
 * Adaptive Runtime Readiness.
 * Diagnostic gate ensuring required production wiring, Jev credentials,
 * persistence, and policy are sound before objective admission.
 * Implements LIVE_RUNTIME_WIRING.md and PH-037, PH-038.
 */

import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type { SemanticResponsibilityController } from "../dedup/semantic-responsibility-controller.ts";
import type { ExpertSelectionService } from "../expert-routing/service.ts";
import type { ObjectiveExecutionController } from "../objective-execution/objective-execution-controller.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import type { AdaptiveCapabilityController } from "./adaptive-capability-controller.ts";
import type { AdaptiveResolutionController } from "./adaptive-resolution-controller.ts";
import type { RuntimeAdaptationCoordinator } from "./runtime-adaptation-coordinator.ts";
import type { SpecialistSynthesisController } from "./specialist-synthesis-controller.ts";

export interface AdaptiveRuntimeReadinessDeps {
	readonly steeringPlane?: SystemOneSteeringPlane;
	readonly adaptiveResolution?: AdaptiveResolutionController;
	readonly specialistSynthesis?: SpecialistSynthesisController;
	readonly adaptiveCapabilities?: AdaptiveCapabilityController;
	readonly responsibilityController?: SemanticResponsibilityController;
	readonly runtimeAdaptation?: RuntimeAdaptationCoordinator;
	readonly objectiveController?: ObjectiveExecutionController;
	readonly expertService?: ExpertSelectionService;
	readonly charter?: ExecutionCharter;
}

export interface AdaptiveRuntimeStatus {
	readonly ready: boolean;
	readonly steeringModel?: string;
	readonly steeringMode?: string;
	readonly certificatePersistenceHealth: "healthy" | "degraded" | "unavailable";
	readonly controllerWiring: {
		readonly steeringPlane: boolean;
		readonly adaptiveResolution: boolean;
		readonly specialistSynthesis: boolean;
		readonly adaptiveCapability: boolean;
		readonly semanticResponsibility: boolean;
		readonly hmoeService: boolean;
		readonly runtimeAdaptation: boolean;
		readonly objectiveExecution: boolean;
	};
	readonly charterDigest?: string;
	readonly specialistCatalogRevision: number;
	readonly capabilityCatalogRevision: number;
	readonly responsibilityDiscoveryMethods: readonly string[];
	readonly hmoeHealth: "healthy" | "degraded" | "unavailable";
	readonly issues: readonly string[];
}

export class AdaptiveRuntimeReadiness {
	private readonly deps: AdaptiveRuntimeReadinessDeps;

	constructor(deps: AdaptiveRuntimeReadinessDeps) {
		this.deps = deps;
	}

	getStatus(): AdaptiveRuntimeStatus {
		const issues: string[] = [];

		const steeringPlane = Boolean(this.deps.steeringPlane);
		const adaptiveResolution = Boolean(this.deps.adaptiveResolution);
		const specialistSynthesis = Boolean(this.deps.specialistSynthesis);
		const adaptiveCapability = Boolean(this.deps.adaptiveCapabilities);
		const semanticResponsibility = Boolean(this.deps.responsibilityController);
		const hmoeService = Boolean(this.deps.expertService);
		const runtimeAdaptation = Boolean(this.deps.runtimeAdaptation);
		const objectiveExecution = Boolean(this.deps.objectiveController);

		if (!steeringPlane) issues.push("SystemOneSteeringPlane is not wired");
		if (!adaptiveResolution) issues.push("AdaptiveResolutionController is not wired");
		if (!specialistSynthesis) issues.push("SpecialistSynthesisController is not wired");
		if (!adaptiveCapability) issues.push("AdaptiveCapabilityController is not wired");
		if (!semanticResponsibility) issues.push("SemanticResponsibilityController is not wired");
		if (!hmoeService) issues.push("ExpertSelectionService (H-MoE) is not wired");
		if (!runtimeAdaptation) issues.push("RuntimeAdaptationCoordinator is not wired");
		if (!objectiveExecution) issues.push("ObjectiveExecutionController is not wired");

		const steeringModel = this.deps.steeringPlane?.policy?.model?.id;
		const steeringMode = this.deps.steeringPlane?.policy?.mode;

		let certHealth: "healthy" | "degraded" | "unavailable" = "healthy";
		if (!this.deps.steeringPlane) {
			certHealth = "unavailable";
		}

		let hmoeHealth: "healthy" | "degraded" | "unavailable" = "healthy";
		if (!this.deps.expertService) {
			hmoeHealth = "unavailable";
		}

		const specRev = this.deps.specialistSynthesis?.catalog?.revision?.() ?? 1;
		const capRev = this.deps.adaptiveCapabilities?.catalog?.revision?.() ?? 1;

		const discoveryMethods = [
			"responsibility_registry",
			"textual_clone",
			"repo_search",
			"symbol_graph",
			"structural_ast",
			"semantic_index",
		];

		const charterDigest = this.deps.charter ? `charter_${this.deps.charter.objective_id}` : undefined;

		return {
			ready: issues.length === 0,
			steeringModel,
			steeringMode,
			certificatePersistenceHealth: certHealth,
			controllerWiring: {
				steeringPlane,
				adaptiveResolution,
				specialistSynthesis,
				adaptiveCapability,
				semanticResponsibility,
				hmoeService,
				runtimeAdaptation,
				objectiveExecution,
			},
			charterDigest,
			specialistCatalogRevision: specRev,
			capabilityCatalogRevision: capRev,
			responsibilityDiscoveryMethods: discoveryMethods,
			hmoeHealth,
			issues,
		};
	}

	assertReady(profile?: { systemOneRequired?: boolean; startOnly?: boolean; adaptiveEnabled?: boolean }): void {
		const status = this.getStatus();
		const isRequired =
			profile === undefined ||
			profile.systemOneRequired ||
			profile.startOnly ||
			profile.adaptiveEnabled ||
			status.steeringMode === "system_one_required";

		if (isRequired && !status.ready) {
			throw new Error(`Adaptive runtime is not ready: ${status.issues.join("; ")}`);
		}
	}
}
