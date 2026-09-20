/**
 * Adaptive Runtime Factory.
 * Constructs production and test compositions of the adaptive runtime stack.
 * Implements PRODUCTION_COMPOSITION.md, PRC-001..PRC-010, PRC-020..PRC-025.
 */

import path from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
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
import type { ModelRegistry } from "../model-registry.ts";
import type { ModelAdaptationStore } from "../models/adaptation-store.ts";
import type { FitnessStore } from "../models/fitness-store.ts";
import {
	ObjectiveExecutionController,
	type ObjectiveExecutionControllerDeps,
} from "../objective-execution/objective-execution-controller.ts";
import type { TaskProfileWriterPort } from "../orchestration/task-profile-writer.ts";
import type { WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import type { RuntimeUpdateController } from "../runtime-update-controller.ts";
import { SteeringCertificateStore } from "../steering/certificate-store.ts";
import { DEFAULT_STEERING_POLICY } from "../steering/policy.ts";
import { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import {
	AdaptiveCapabilityController,
	type CandidateArtifact,
	type CandidateVerificationResult,
	type CapabilityActivator,
} from "./adaptive-capability-controller.ts";
import { AdaptiveResolutionController } from "./adaptive-resolution-controller.ts";
import { AdaptiveRuntimeReadiness } from "./adaptive-runtime-readiness.ts";
import { CapabilityCatalog } from "./capability-catalog.ts";
import { type CapabilityKindSupportContext, resolveCapabilityKindSupport } from "./capability-kind-support.ts";
import type { CapabilityProofRunnerPort } from "./capability-proof-runner.ts";
import {
	createRuntimeUpdateAdapterFromController,
	RuntimeAdaptationCoordinator,
	type RuntimeUpdateAdapter,
} from "./runtime-adaptation-coordinator.ts";
import { SpecialistCatalog } from "./specialist-catalog.ts";
import {
	SpecialistSynthesisController,
	type WorkerExecutionContractFactory,
} from "./specialist-synthesis-controller.ts";
import type { CapabilityKind, CapabilitySpec } from "./types.ts";

export interface AdaptiveRuntimeStack {
	readonly provenance?: "production-live" | "test-fixture";
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
	readonly mode?: "production" | "test";
	readonly agentDir?: string;
	readonly persistentPath?: string;
	readonly steeringPlane?: SystemOneSteeringPlane;
	readonly charter?: ExecutionCharter;
	readonly runtimeUpdateAdapter?: RuntimeUpdateAdapter;
	readonly runtimeUpdateController?: RuntimeUpdateController;
	readonly taskRuntime?: unknown;
	readonly durableTaskRuntime?: unknown;
	/** The objective controller's runtime port over the live session; without it the raw task runtime is used. */
	readonly objectiveRuntime?: ObjectiveExecutionControllerDeps["runtime"];
	/** Loop mode the objective controller reports (`getMode`); the session's own setting wins at run time. */
	readonly loopMode?: ObjectiveExecutionControllerDeps["mode"];
	readonly completionProfile?: ObjectiveExecutionControllerDeps["completionProfile"];
	readonly customTools?: readonly unknown[];
	readonly modelRegistry?: ModelRegistry;
	readonly fitnessStore?: FitnessStore;
	readonly adaptationStore?: ModelAdaptationStore;
	readonly modelPinPolicy?: WorkerModelPinPolicy;
	readonly isModelExhausted?: (model: Model<Api>) => boolean;
	readonly taskProfiles?: TaskProfileWriterPort;
	readonly taskProfileWriter?: TaskProfileWriterPort;
	readonly contractFactory?: WorkerExecutionContractFactory;
	readonly capabilityBuilder?: {
		build(spec: CapabilitySpec, signal?: AbortSignal, expertBinding?: unknown): Promise<CandidateArtifact>;
	};
	readonly mechanicalVerifier?: {
		verifyCandidate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<CandidateVerificationResult>;
		verifyActivation(activation: unknown, spec: CapabilitySpec): Promise<boolean>;
		runTaskSpecificProof?(spec: CapabilitySpec): Promise<string>;
	};
	readonly capabilityActivators?: Partial<Record<CapabilityKind, CapabilityActivator>>;
	readonly skillVault?: unknown;
	readonly extensionRunner?: unknown;
	readonly scriptRegistry?: unknown;
	readonly workerDispatcher?: unknown;
	readonly cwd?: string;
	/** Agent-owned root synthesized capability artifacts are written to and proved against. */
	readonly capabilityArtifactRoot?: string;
	readonly isSynthetic?: boolean;
	/** Durable owner development rules, propagated into every synthesized mission. */
	readonly getOwnerRules?: () => string;
	/** Root semantic project rules, consulted at task postflight and completion. */
	readonly projectRules?: ObjectiveExecutionControllerDeps["projectRules"];
	/** Bounded execution owner for the ephemeral-script activation smoke (ACT-007). */
	readonly proofRunner?: CapabilityProofRunnerPort;
	/** Live extension runtime owning extension activation and lookup (ACT-009). */
	readonly extensionRuntime?: {
		reload(extensionPath: string): Promise<void>;
		listActive(): readonly { name: string; path: string }[];
	};
	/** Session facts that decide conditionally-supported capability kinds (ACT-001). */
	readonly kindSupportContext?: CapabilityKindSupportContext;
}

/**
 * Production Adaptive Runtime Stack Factory.
 * Enforces live production dependencies, rejects synthetic fixtures,
 * wires live H-MoE, TaskProfileWriter, DurableTaskRuntime, and asserts live readiness.
 * Implements PRC-001..PRC-010, PRC-020..PRC-025, and ERC-001..ERC-008.
 */
export function createProductionAdaptiveRuntimeStack(options: CreateAdaptiveRuntimeStackOptions): AdaptiveRuntimeStack {
	// PRC-010: Reject synthetic fixtures in production mode
	if (options.isSynthetic === true || (options as any).synthetic === true || (options as any).isTestFixture === true) {
		throw new Error("Test fixtures rejected in production mode (PRC-010)");
	}

	// PRC-020: Live ModelRegistry mandatory
	if (!options.modelRegistry) {
		throw new Error("Production adaptive runtime requires ModelRegistry (PRC-020)");
	}

	// PRC-003: Live DurableTaskRuntime mandatory
	const taskRuntime = options.taskRuntime ?? options.durableTaskRuntime;
	if (!taskRuntime) {
		throw new Error("Production adaptive runtime requires DurableTaskRuntime (PRC-003)");
	}

	// PRC-004: Actual ExecutionCharter mandatory
	if (!options.charter) {
		throw new Error("Production adaptive runtime requires actual ExecutionCharter (PRC-004)");
	}

	// PRC-005: Actual TaskProfileWriter mandatory
	const taskProfiles = options.taskProfiles ?? options.taskProfileWriter;
	if (!taskProfiles) {
		throw new Error("Production adaptive runtime requires TaskProfileWriter (PRC-005)");
	}

	// PRC-006: Real WorkerExecutionContract materializer mandatory
	if (!options.contractFactory) {
		throw new Error("Production adaptive runtime requires WorkerExecutionContract materializer (PRC-006)");
	}

	// ERC-004, PRC-007, PRC-040: Capability builder worker port mandatory and not synthetic/fixture
	if (
		!options.capabilityBuilder ||
		(options.capabilityBuilder as any).isSynthetic === true ||
		(options.capabilityBuilder as any).provenance === "unbound" ||
		(options.capabilityBuilder as any).provenance === "test-fixture"
	) {
		throw new Error("Production adaptive runtime requires capability builder worker port (PRC-007, PRC-040)");
	}

	// ERC-005, RCG-022: Real mechanical verifier with a real proof runner is mandatory. The factory
	// never manufactures one, because a verifier built here would have no owner to answer for it.
	const mechanicalVerifier = options.mechanicalVerifier;
	if (
		!mechanicalVerifier ||
		(mechanicalVerifier as any).isSynthetic === true ||
		(mechanicalVerifier as any).isDummy === true ||
		(mechanicalVerifier as any).isAlwaysPass === true ||
		(mechanicalVerifier as any).provenance === "unbound" ||
		(mechanicalVerifier as any).provenance === "test-fixture"
	) {
		throw new Error("Production adaptive runtime requires a real mechanical verifier (ERC-005)");
	}
	if (typeof mechanicalVerifier.runTaskSpecificProof !== "function") {
		throw new Error("Production adaptive runtime requires a mechanical verifier with a real proof runner (RCG-022)");
	}

	// PRC-007: Reject dummy builder/verifier/runtime/task profile/charter
	if (
		(options.charter as any)?.isDummy ||
		(taskProfiles as any)?.isDummy ||
		(taskRuntime as any)?.isDummy ||
		(options.capabilityBuilder as any)?.isDummy ||
		(mechanicalVerifier as any)?.isDummy
	) {
		throw new Error(
			"Production factory cannot instantiate dummy builder/verifier/runtime/task profile/charter (PRC-007)",
		);
	}

	// ERC-003, PRC-002: RuntimeUpdateController mandatory and not a no-op
	let adapter = options.runtimeUpdateAdapter;
	if (!adapter && options.runtimeUpdateController) {
		adapter = createRuntimeUpdateAdapterFromController(options.runtimeUpdateController);
	}
	const reloadFn =
		(options.runtimeUpdateController as any)?.deps?.reload ?? (options.runtimeUpdateController as any)?.reload;
	const reloadStr = reloadFn?.toString?.().replace(/\s+/g, "") ?? "";
	const isReloadNoOp =
		reloadStr === "async()=>{}" ||
		reloadStr === "()=>Promise.resolve()" ||
		reloadStr === "async()=>undefined" ||
		reloadStr === "()=>undefined";

	if (
		!adapter ||
		(adapter as any).isNoOp === true ||
		(options.runtimeUpdateController as any)?.isNoOp === true ||
		isReloadNoOp ||
		(adapter as any).provenance === "unbound" ||
		(adapter as any).provenance === "test-fixture"
	) {
		throw new Error("No-op RuntimeUpdateController rejected in production mode (ERC-003)");
	}

	// ERC-007, ERC-008, RCG-016: Real worker dispatcher owned by a live session is mandatory.
	const workerDispatcher = options.workerDispatcher;
	if (
		!workerDispatcher ||
		(workerDispatcher as any).isSynthetic === true ||
		(workerDispatcher as any).isDummy === true ||
		(workerDispatcher as any).provenance === "unbound" ||
		(workerDispatcher as any).provenance === "test-fixture"
	) {
		throw new Error("Production adaptive runtime requires live worker dispatcher (ERC-007, ERC-008)");
	}

	const stack = assembleAdaptiveRuntimeStack(
		{ ...options, mechanicalVerifier, workerDispatcher },
		"production-live",
		adapter,
		taskRuntime,
		taskProfiles,
		options.charter,
	);

	// PRC-008, ERC-002: Live readiness assertion enforced before completion of construction
	const hasDurableBackend = Boolean(
		options.persistentPath ||
			(options.agentDir && path.join(options.agentDir, "certificates.json")) ||
			options.steeringPlane?.certificates?.hasDurableBackend(),
	);
	stack.readiness.assertReady({
		systemOneRequired: hasDurableBackend,
		startOnly: true,
		adaptiveEnabled: true,
	});

	return stack;
}

/**
 * Fixture verifier for the test stack only. Production never reaches this: it requires an explicit
 * verifier, so an always-pass verifier can never be labelled production-live.
 */
function buildTestMechanicalVerifier(
	provenance: "production-live" | "test-fixture",
): CreateAdaptiveRuntimeStackOptions["mechanicalVerifier"] {
	if (provenance === "production-live") return undefined;
	return {
		verifyCandidate: async (candidate, _spec) => ({
			passed: Boolean(candidate.code && candidate.code.length > 0 && candidate.digest),
			testCount: 1,
			failures: [],
		}),
		verifyActivation: async () => true,
		runTaskSpecificProof: async () => "task_proof_verified",
	};
}

/**
 * Common assembly helper for both production and test stacks.
 */
function assembleAdaptiveRuntimeStack(
	options: CreateAdaptiveRuntimeStackOptions,
	provenance: "production-live" | "test-fixture",
	adapter: RuntimeUpdateAdapter,
	taskRuntime: unknown,
	taskProfiles: unknown,
	charter: ExecutionCharter,
): AdaptiveRuntimeStack {
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

	// 2. H-MoE expert selection plane (PRC-020..PRC-025)
	const expertCatalog = new ExpertCatalog({
		modelRegistry: options.modelRegistry,
		fitnessStore: options.fitnessStore,
		adaptationStore: options.adaptationStore,
		modelPinPolicy: options.modelPinPolicy,
		isModelExhausted: options.isModelExhausted,
	});
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
	const runtimeAdaptation = new RuntimeAdaptationCoordinator(steeringPlane, adapter);

	// 4. Capability controller
	const capabilityCatalog = new CapabilityCatalog();
	const adaptiveCapabilities = new AdaptiveCapabilityController({
		steering: steeringPlane,
		catalog: capabilityCatalog,
		experts: expertService,
		builder: options.capabilityBuilder,
		mechanicalVerifier: options.mechanicalVerifier ?? buildTestMechanicalVerifier(provenance),
		runtimeAdaptation,
		activators: options.capabilityActivators,
		skillVault: options.skillVault as any,
		extensionRunner: options.extensionRunner as any,
		scriptRegistry: options.scriptRegistry as any,
		// Activation owners: bounded execution for the ephemeral-script smoke, and the live
		// extension runtime for extension load + registry lookup (ACT-007, ACT-009).
		proofRunner: options.proofRunner,
		extensionRuntime: options.extensionRuntime,
		cwd: options.cwd,
		capabilityArtifactRoot: options.capabilityArtifactRoot,
		// Availability is resolved against this session: a kind whose precondition is unmet here is
		// unavailable here, rather than advertised and then failing at activation.
		kindSupport: resolveCapabilityKindSupport(options.kindSupportContext),
	});

	// 5. Specialist synthesis
	const specialistCatalog = new SpecialistCatalog();
	const specialistSynthesis = new SpecialistSynthesisController({
		steering: steeringPlane,
		catalog: specialistCatalog,
		experts: expertService,
		capabilityController: adaptiveCapabilities,
		taskProfiles: taskProfiles as any,
		contractFactory: options.contractFactory,
		getOwnerRules: options.getOwnerRules,
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

	// 8. Objective execution controller
	const objectiveController = new ObjectiveExecutionController({
		runtime: options.objectiveRuntime ?? (taskRuntime as any),
		...(options.loopMode ? { mode: options.loopMode } : {}),
		...(options.completionProfile ? { completionProfile: options.completionProfile } : {}),
		steeringPlane,
		adaptiveResolution,
		specialistSynthesis,
		adaptiveCapabilities,
		responsibilityController,
		expertSelector: expertService,
		outcomeRecorder: expertOutcomeRecorder,
		executionCharter: charter,
		workerDispatcher: (options as any).workerDispatcher,
		projectRules: options.projectRules,
	});

	// 9. Adaptive runtime readiness
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
		workerDispatcher: (options as any).workerDispatcher,
		capabilityBuilder: options.capabilityBuilder,
		runtimeUpdater: adapter,
		mechanicalVerifier: options.mechanicalVerifier,
		taskProfileWriter: taskProfiles,
		contractFactory: options.contractFactory,
		provenance,
		mode: options.mode,
		kindSupport: resolveCapabilityKindSupport(options.kindSupportContext),
	});

	return {
		provenance,
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

/**
 * Test Adaptive Runtime Stack Factory.
 * Provides fallback mock fixtures for unit and regression testing.
 */
export function createTestAdaptiveRuntimeStack(options: CreateAdaptiveRuntimeStackOptions = {}): AdaptiveRuntimeStack {
	let adapter = options.runtimeUpdateAdapter;
	if (!adapter && options.runtimeUpdateController) {
		adapter = createRuntimeUpdateAdapterFromController(options.runtimeUpdateController);
	}
	if (!adapter) {
		adapter = {
			createSnapshot: async () => ({
				snapshotId: "snapshot-test-default",
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

	const taskRuntime = options.taskRuntime ??
		options.durableTaskRuntime ?? {
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
		};

	const taskProfiles = options.taskProfiles ??
		options.taskProfileWriter ?? {
			createTaskProfile: () => ({ created: true, profileId: `prof-${Date.now()}` }),
			inspectTaskProfileOptions: () => ({
				baseProfiles: [],
				inheritedToolNames: [],
				models: [],
			}),
		};

	const charter =
		options.charter ??
		compileExecutionCharter({
			objectiveId: "test-objective",
			prompt: "Perform safe scoped execution",
		});

	const capabilityBuilder = options.capabilityBuilder ?? {
		build: async (spec) => ({
			capabilityId: spec.capability_id,
			kind: spec.kind,
			code: "// test synthesized capability",
			digest: "cap-digest-test",
		}),
	};

	const contractFactory = options.contractFactory ?? {
		createContract: (input) => ({
			schemaVersion: 1,
			authorityRole: input.authorityRole,
			modelRequirements: {
				primaryModelId: input.expertBinding.modelId,
				provider: input.expertBinding.providerId,
			},
			boundedToolSurface: [...input.toolNames],
		}),
	};

	return assembleAdaptiveRuntimeStack(
		{
			...options,
			capabilityBuilder,
			contractFactory,
		},
		"test-fixture",
		adapter,
		taskRuntime,
		taskProfiles,
		charter,
	);
}

/**
 * Dispatcher factory: routes to createProductionAdaptiveRuntimeStack when mode === "production"
 * or creates test stack when mode === "test" or defaults to test when unconfigured.
 */
export function createAdaptiveRuntimeStack(options: CreateAdaptiveRuntimeStackOptions = {}): AdaptiveRuntimeStack {
	if (options.mode === "production") {
		return createProductionAdaptiveRuntimeStack(options);
	}
	return createTestAdaptiveRuntimeStack(options);
}
