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
export { CapabilityCatalog, type CapabilityCatalogEntry } from "./capability-catalog.ts";
export {
	type CapabilityNeed,
	CapabilityResolver,
	type DeepResolutionResult,
	type WideResolutionResult,
} from "./capability-resolution.ts";
export {
	type RollbackSnapshot,
	RuntimeAdaptationCoordinator,
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
	type SpecialistCognitiveRequirements,
	type SpecialistContextPolicy,
	type SpecialistLifetime,
	type SpecialistRecord,
	type SpecialistRecordState,
	type SpecialistSpec,
	type WorkerAdaptationNeedKind,
	type WorkerAdaptationSignal,
} from "./types.ts";
