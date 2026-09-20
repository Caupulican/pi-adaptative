/**
 * Adaptive module exports.
 */

export { AdaptationCycleError, AdaptationGraph } from "./adaptation-graph.ts";
export {
	AdaptiveCapabilityController,
	type AdaptiveCapabilityControllerDeps,
	type CandidateArtifact,
	type CandidateVerificationResult,
} from "./adaptive-capability-controller.ts";
export {
	type AdaptiveDimension,
	type AdaptiveResolution,
	AdaptiveResolutionController,
	type AdaptiveResolutionInput,
	type CatalogRevisionProvider,
} from "./adaptive-resolution-controller.ts";
export {
	type AdaptiveRuntimeStack,
	type CreateAdaptiveRuntimeStackOptions,
	createAdaptiveRuntimeStack,
	createProductionAdaptiveRuntimeStack,
	createTestAdaptiveRuntimeStack,
} from "./adaptive-runtime-factory.ts";
export {
	AdaptiveRuntimeReadiness,
	type AdaptiveRuntimeReadinessDeps,
	type AdaptiveRuntimeStatus,
} from "./adaptive-runtime-readiness.ts";
export { CapabilityCatalog, type CapabilityCatalogEntry } from "./capability-catalog.ts";
export {
	capabilityArtifactRelativePath,
	compileCapabilityProofObligations,
	compileNodeProofCommand,
} from "./capability-proof-obligations.ts";
export {
	CapabilityProofRunner,
	type CapabilityProofRunnerPort,
	type ProofExecutionResult,
	type ProofKind,
	type ProofRunRequest,
} from "./capability-proof-runner.ts";
export {
	type CapabilityNeed,
	CapabilityResolver,
	type DeepResolutionResult,
	type WideResolutionResult,
} from "./capability-resolution.ts";
export {
	assertWorkerResultLineage,
	CapabilityExecutionError,
	CapabilityProofFailedError,
	RealCapabilityBuilder,
	type RealCapabilityBuilderDeps,
	RealMechanicalVerifier,
	type RealMechanicalVerifierDeps,
	RealScriptRegistry,
	RealWorkerDispatcher,
	type ResolvedExpertBinding,
	resolveExpertBinding,
} from "./execution-ports.ts";
export {
	type RollbackSnapshot,
	RuntimeAdaptationCoordinator,
	RuntimeAdaptationUnavailableError,
	type RuntimeUpdateAdapter,
} from "./runtime-adaptation-coordinator.ts";
export { SpecialistCatalog, type SpecialistCatalogEntry } from "./specialist-catalog.ts";
export {
	SpecialistMaterializationError,
	type SpecialistNeed,
	SpecialistSynthesisController,
	type SpecialistSynthesisControllerDeps,
} from "./specialist-synthesis-controller.ts";
export {
	type AdaptationNode,
	type AdaptationNodeKind,
	type AdaptationNodeStatus,
	CAPABILITY_LEVELS,
	type CapabilityGap,
	type CapabilityKind,
	type CapabilityLevel,
	type CapabilityLifetime,
	type CapabilityRecord,
	type CapabilityRecordState,
	type CapabilityReuseExpectation,
	type CapabilitySpec,
	type CapabilitySpecProof,
	type EstablishedCapability,
	type MaterializedSpecialist,
	type PortProvenance,
	type ProvenancedPort,
	type SpecialistCognitiveRequirements,
	type SpecialistContextPolicy,
	type SpecialistLifetime,
	type SpecialistRecord,
	type SpecialistRecordState,
	type SpecialistSpec,
	type WorkerAdaptationNeedKind,
} from "./types.ts";
