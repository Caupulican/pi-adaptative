/**
 * Dedup module exports.
 */

export {
	CANDIDATE_LIMIT,
	type CandidateDiscoveryDeps,
	CandidateDiscoveryService,
} from "./candidate-discovery.ts";
export { ResponsibilityRegistry } from "./responsibility-registry.ts";
export {
	ResponsibilityEvidenceInsufficientError,
	SemanticDuplicateResponsibilityError,
	SemanticResponsibilityController,
	type SemanticResponsibilityControllerDeps,
} from "./semantic-responsibility-controller.ts";
export type {
	DispositionOutcome,
	IntentionalDuplicationWaiver,
	PostMutationDedupVerdict,
	ResponsibilityCandidate,
	ResponsibilityDisposition,
	ResponsibilityRecord,
	ResponsibilityRecordStatus,
	ResponsibilityStatement,
} from "./types.ts";
export { WaiverStore } from "./waiver-store.ts";
