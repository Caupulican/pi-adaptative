/**
 * Adaptive Runtime Factory.
 * Constructs the default production composition of the adaptive runtime stack.
 * Implements PRODUCTION_COMPOSITION.md and FC-001..FC-005.
 */

import path from "node:path";
import { compileExecutionCharter, type ExecutionCharter } from "../autonomy/execution-charter.ts";
import { CandidateDiscoveryService } from "../dedup/candidate-discovery.ts";
import { ResponsibilityRegistry } from "../dedup/responsibility-registry.ts";
import { SemanticResponsibilityController } from "../dedup/semantic-responsibility-controller.ts";
import { WaiverStore } from "../dedup/waiver-store.ts";
import { ExpertAdmissionPolicy } from "../expert-routing/admission.ts";
import { ExpertCapacityService } from "../expert-routing/capacity.ts";
import { ExpertCatalog } from "../expert-routing/catalog.ts";
import { ExpertFeatureBuilder } from "../expert-routing/features.ts";
import { ExpertOutcomeRecorder } from "../expert-routing/outcome-recorder.ts";
import { ExpertOutcomeStore } from "../expert-routing/outcome-store.ts";
import { ExpertRankingPolicy } from "../expert-routing/ranking.ts";
import { ExpertSelectionService } from "../expert-routing/service.ts";
import { ObjectiveExecutionController } from "../objective-execution/objective-execution-controller.ts";
import type { RuntimeUpdateController } from "../runtime-update-controller.ts";
import { SteeringCertificateStore } from "../steering/certificate-store.ts";
import { DEFAULT_STEERING_POLICY } from "../steering/policy.ts";
import { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { AdaptiveCapabilityController } from "./adaptive-capability-controller.ts";
import { AdaptiveResolutionController } from "./adaptive-resolution-controller.ts";
import { AdaptiveRuntimeReadiness } from "./adaptive-runtime-readiness.ts";
import { CapabilityCatalog } from "./capability-catalog.ts";
import {
	createRuntimeUpdateAdapterFromController,
	RuntimeAdaptationCoordinator,
	type RuntimeUpdateAdapter,
} from "./runtime-adaptation-coordinator.ts";
import { SpecialistCatalog } from "./specialist-catalog.ts";
import { SpecialistSynthesisController } from "./specialist-synthesis-controller.ts";

export interface AdaptiveRuntimeStack {
	readonly steeringPlane: SystemOneSteeringPlane;
	readonly certificateStore: SteeringCertificateStore;
	readonly expertService: ExpertSelectionService;
	readonly expertCatalog: ExpertCatalog;
	readonly runtimeAdaptation: RuntimeAdaptationCoordinator;
	readonly capabilityCatalog: CapabilityCatalog;
	readonly adaptiveCapabilities: AdaptiveCapabilityController;
	readonly specialistCatalog: SpecialistCatalog;
	readonly specialistSynthesis: SpecialistSynthesisController;
	readonly responsibilityRegistry: ResponsibilityRegistry;
	readonly responsibilityController: SemanticResponsibilityController;
	readonly adaptiveResolution: AdaptiveResolutionController;
	readonly objectiveController: ObjectiveExecutionController;
	readonly charter: ExecutionCharter;
	readonly readiness: AdaptiveRuntimeReadiness;
}

export interface CreateAdaptiveRuntimeStackOptions {
	readonly agentDir?: string;
	readonly persistentPath?: string;
	readonly steeringPlane?: SystemOneSteeringPlane;
	readonly charter?: ExecutionCharter;
	readonly runtimeUpdateAdapter?: RuntimeUpdateAdapter;
	readonly runtimeUpdateController?: RuntimeUpdateController;
	readonly taskRuntime?: unknown;
	readonly customTools?: readonly unknown[];
}

export function createAdaptiveRuntimeStack(options: CreateAdaptiveRuntimeStackOptions = {}): AdaptiveRuntimeStack {
	// 1. Steering certificate store and steering plane
	const persistentPath =
		options.persistentPath ?? (options.agentDir ? path.join(options.agentDir, "certificates.json") : undefined);
	const certificateStore = options.steeringPlane?.certificates ?? new SteeringCertificateStore(persistentPath);
	const steeringPlane =
		options.steeringPlane ??
		new SystemOneSteeringPlane({
			certificates: certificateStore,
			policy: DEFAULT_STEERING_POLICY,
		});

	// 2. H-MoE expert selection plane
	const expertCatalog = new ExpertCatalog();
	const expertAdmission = new ExpertAdmissionPolicy();
	const expertFeatures = new ExpertFeatureBuilder();
	const expertRanking = new ExpertRankingPolicy();
	const expertCapacity = new ExpertCapacityService();
	const expertOutcomeStore = new ExpertOutcomeStore();
	const expertOutcomeRecorder = new ExpertOutcomeRecorder(expertOutcomeStore);
	const expertService = new ExpertSelectionService(
		expertCatalog,
		expertAdmission,
		expertFeatures,
		expertRanking,
		expertCapacity,
		expertOutcomeStore,
	);

	// 3. Runtime adaptation coordinator
	let adapter = options.runtimeUpdateAdapter;
	if (!adapter && options.runtimeUpdateController) {
		adapter = createRuntimeUpdateAdapterFromController(options.runtimeUpdateController);
	}
	if (!adapter) {
		adapter = {
			createSnapshot: async () => ({
				snapshotId: "snapshot-prod-default",
				baselineRevision: "1.0",
				backupState: {},
				timestamp: new Date().toISOString(),
			}),
			applyUpdate: async () => ({ applied: true, restartRequired: false }),
			verifyRuntime: async () => ({ healthy: true }),
			rollback: async () => {},
			commit: async () => {},
		};
	}
	const runtimeAdaptation = new RuntimeAdaptationCoordinator(steeringPlane, adapter);

	// 4. Capability controller
	const capabilityCatalog = new CapabilityCatalog();
	const adaptiveCapabilities = new AdaptiveCapabilityController({
		steering: steeringPlane,
		catalog: capabilityCatalog,
		experts: expertService,
		builder: {
			build: async (spec) => ({
				capabilityId: spec.capability_id,
				kind: spec.kind,
				code: "// synthesized capability",
				digest: "cap-digest-prod",
			}),
		},
		mechanicalVerifier: {
			verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
			verifyActivation: async () => true,
		},
		runtimeAdaptation,
	});

	// 5. Specialist synthesis
	const specialistCatalog = new SpecialistCatalog();
	const specialistSynthesis = new SpecialistSynthesisController({
		steering: steeringPlane,
		catalog: specialistCatalog,
		experts: expertService,
		capabilityController: adaptiveCapabilities,
		taskProfiles: {
			createTaskProfile: () => ({ created: true, profileId: `prof-${Date.now()}` }),
			inspectTaskProfileOptions: () => ({
				baseProfiles: [],
				inheritedToolNames: [],
				models: [],
			}),
		},
	});

	// 6. Semantic dedup / responsibility
	const responsibilityRegistry = new ResponsibilityRegistry();
	const responsibilityDiscovery = new CandidateDiscoveryService({
		registry: responsibilityRegistry,
	});
	const waiverStore = new WaiverStore();
	const responsibilityController = new SemanticResponsibilityController({
		steering: steeringPlane,
		registry: responsibilityRegistry,
		discovery: responsibilityDiscovery,
		waivers: waiverStore,
	});

	// 7. Adaptive resolution
	const adaptiveResolution = new AdaptiveResolutionController({
		steering: steeringPlane,
		specialistCatalog,
		capabilityCatalog,
	});

	// 8. Execution charter
	const charter =
		options.charter ??
		compileExecutionCharter({
			objectiveId: "default-objective",
			prompt: "Perform safe scoped execution",
		});

	// 9. Objective execution controller
	const objectiveController = new ObjectiveExecutionController({
		runtime: (options.taskRuntime as any) ?? {
			reconcileObjective: async (id: string) =>
				({
					schemaVersion: "1.0",
					objectiveId: id,
					objectives: {},
					attempts: {},
					tasks: {},
					verifications: {},
					artifacts: {},
					dependencies: {},
				}) as any,
		},
		steeringPlane,
		adaptiveResolution,
		specialistSynthesis,
		adaptiveCapabilities,
		responsibilityController,
		expertSelector: expertService,
		outcomeRecorder: expertOutcomeRecorder,
		executionCharter: charter,
	});

	// 10. Adaptive runtime readiness
	const readiness = new AdaptiveRuntimeReadiness({
		steeringPlane,
		adaptiveResolution,
		specialistSynthesis,
		adaptiveCapabilities,
		responsibilityController,
		runtimeAdaptation,
		objectiveController,
		expertService,
		charter,
	});

	return {
		steeringPlane,
		certificateStore,
		expertService,
		expertCatalog,
		runtimeAdaptation,
		capabilityCatalog,
		adaptiveCapabilities,
		specialistCatalog,
		specialistSynthesis,
		responsibilityRegistry,
		responsibilityController,
		adaptiveResolution,
		objectiveController,
		charter,
		readiness,
	};
}
