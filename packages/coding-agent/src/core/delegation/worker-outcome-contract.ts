/**
 * The Outcome contract: one bounded, versioned record of how a unit of delegated work ended, computed by host code from
 * durable facts and never from model prose. A leaf module (types and constants only) so the orchestration reducer, the
 * snapshot codec and the projection share one definition.
 */

export const OUTCOME_VERSION = 1;

export const OUTCOME_STATUSES = ["succeeded", "partial", "blocked", "failed", "cancelled"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const OUTCOME_SCOPES = ["lane", "node", "join", "leader"] as const;
export type OutcomeScope = (typeof OUTCOME_SCOPES)[number];

export const BLOCKER_ATTRIBUTIONS = ["model", "provider", "task", "harness", "owner", "environment", "none"] as const;
export type BlockerAttribution = (typeof BLOCKER_ATTRIBUTIONS)[number];

/** The one closed blocker taxonomy. Design-specific causes ride in `Outcome.sourceCodes`, never as new members here. */
export const BLOCKER_CODES = [
	"none",
	// work quality (attribution model)
	"requirement_uncovered",
	"evidence_missing",
	"evidence_contradicts_claim",
	"output_malformed",
	"context_exhausted",
	"time_exhausted",
	"model_unfit",
	"verification_failed",
	// model fit and provider
	"model_fit_open",
	"model_unavailable",
	"provider_transient",
	"provider_quota",
	"provider_auth",
	// stated by the worker (declarable subset) or settled later
	"worker_reported_blocker",
	"missing_input",
	"dependency_wrong",
	"needs_owner_decision",
	"needs_root_answer",
	"external_unavailable",
	// authority and scope
	"scope_denied",
	"owner_authority_required",
	// verification state
	"verification_pending",
	"unverified_result",
	// limits and time
	"budget_exhausted",
	"deadline_reached",
	// environment and placement
	"capacity_unavailable",
	"placement_unreachable",
	"interrupted",
	"action_outcome_unknown",
	"result_unverifiable",
	// harness and request
	"dependency_failed",
	"preflight_failed",
	"request_rejected",
	// cancellation
	"cancelled_by_owner",
	"superseded",
	"unclassified",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/** The blocker each code is attributed to; only `model` attribution is evidence about the model's work. */
export const BLOCKER_ATTRIBUTION: Readonly<Record<BlockerCode, BlockerAttribution>> = {
	none: "none",
	requirement_uncovered: "model",
	evidence_missing: "model",
	evidence_contradicts_claim: "model",
	output_malformed: "model",
	context_exhausted: "model",
	time_exhausted: "model",
	model_unfit: "model",
	verification_failed: "model",
	model_fit_open: "none",
	model_unavailable: "provider",
	provider_transient: "provider",
	provider_quota: "provider",
	provider_auth: "provider",
	worker_reported_blocker: "task",
	missing_input: "task",
	dependency_wrong: "task",
	needs_owner_decision: "owner",
	needs_root_answer: "task",
	external_unavailable: "environment",
	scope_denied: "harness",
	owner_authority_required: "owner",
	verification_pending: "task",
	unverified_result: "none",
	budget_exhausted: "task",
	deadline_reached: "task",
	capacity_unavailable: "environment",
	placement_unreachable: "environment",
	interrupted: "environment",
	action_outcome_unknown: "environment",
	result_unverifiable: "environment",
	dependency_failed: "task",
	preflight_failed: "harness",
	request_rejected: "harness",
	cancelled_by_owner: "owner",
	superseded: "none",
	unclassified: "none",
};

/** Every blocker a worker may declare through `submit_report.blockerCode` once a delegation runtime exists. */
export const WORKER_DECLARABLE_BLOCKERS = [
	"missing_input",
	"dependency_wrong",
	"needs_owner_decision",
	"needs_root_answer",
	"scope_denied",
	"owner_authority_required",
	"external_unavailable",
] as const satisfies readonly BlockerCode[];
export type WorkerDeclarableBlocker = (typeof WORKER_DECLARABLE_BLOCKERS)[number];

/**
 * The subset a leaf worker's `submit_report` schema accepts today. `needs_root_answer` belongs to delegation runtimes
 * (a worker that can ask its root), which leaf workers are not.
 */
export const LEAF_WORKER_DECLARABLE_BLOCKERS = WORKER_DECLARABLE_BLOCKERS.filter(
	(code): code is Exclude<WorkerDeclarableBlocker, "needs_root_answer"> => code !== "needs_root_answer",
);

export const COVERAGE_SOURCES = ["host_verdict", "verification", "requirement_check", "delegation"] as const;
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];

export const UNCOVERED_REASONS = [
	"not_met",
	"partial",
	"no_evidence",
	"evidence_failed",
	"inconclusive",
	"not_attempted",
	"unverified",
] as const;
export type UncoveredReason = (typeof UNCOVERED_REASONS)[number];

export interface RequirementCoverage {
	readonly required: readonly string[];
	readonly covered: readonly { readonly id: string; readonly by: CoverageSource }[];
	readonly uncovered: readonly { readonly id: string; readonly reason: UncoveredReason }[];
}

export const OUTCOME_ASSURANCES = ["host_verified", "independently_verified", "host_check", "unverified"] as const;
export type OutcomeAssurance = (typeof OUTCOME_ASSURANCES)[number];

export const OUTCOME_ARTIFACT_KINDS = ["file", "commit", "bundle", "report", "receipt", "join_result"] as const;
export type OutcomeArtifactKind = (typeof OUTCOME_ARTIFACT_KINDS)[number];

export interface OutcomeAttempt {
	readonly attemptId: string;
	readonly resultId?: string;
	readonly modelRef: string;
	readonly accountKey?: string;
	readonly thinking: string;
	readonly rung: number;
	readonly laneStatus: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly attestedBy?: string;
}

export const ABANDON_REASONS = ["cancelled", "dependency", "superseded"] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

/**
 * What should happen next, computed by code. `wait_capacity.reason` is a fleet wait-reason id and
 * `replace.excludePlacement` a placement capacity key, `machine:<id>`, the placement the step may not return to.
 */
export type NextAction =
	| { readonly kind: "accept" }
	| { readonly kind: "verify_in_lane" }
	| { readonly kind: "verify_independently"; readonly requirementIds: readonly string[] }
	| { readonly kind: "host_check"; readonly requirementIds: readonly string[] }
	| {
			readonly kind: "rerun_uncovered";
			readonly requirementIds: readonly string[];
			readonly rung: 1 | 2;
			readonly modelRef: string;
			readonly thinking: string;
	  }
	| { readonly kind: "retry_after"; readonly notBefore: string }
	| { readonly kind: "wait_capacity"; readonly reason: string }
	| { readonly kind: "replace"; readonly excludePlacement: string }
	| { readonly kind: "fix_request"; readonly remedy: string }
	| { readonly kind: "ask_owner"; readonly question: string; readonly signature: string }
	| { readonly kind: "ask_root"; readonly question: string }
	| { readonly kind: "abandon"; readonly reason: AbandonReason };

export const NEXT_ACTION_KINDS = [
	"accept",
	"verify_in_lane",
	"verify_independently",
	"host_check",
	"rerun_uncovered",
	"retry_after",
	"wait_capacity",
	"replace",
	"fix_request",
	"ask_owner",
	"ask_root",
	"abandon",
] as const satisfies readonly NextAction["kind"][];

export interface Outcome {
	readonly v: typeof OUTCOME_VERSION;
	/** `outcome-${taskId}-${generation}`. */
	readonly outcomeId: string;
	readonly scope: OutcomeScope;
	/** PlanNode id when present, else the task id. */
	readonly nodeId: string;
	readonly taskId?: string;
	readonly objectiveId: string;
	/** Bumps by one on each recorded outcome of the task. */
	readonly generation: number;
	readonly status: OutcomeStatus;
	/** `none` exactly when the status is `succeeded`. */
	readonly blocker: BlockerCode;
	readonly attribution: BlockerAttribution;
	/** Raw host reason codes the blocker was mapped from; never prose. */
	readonly sourceCodes: readonly string[];
	readonly coverage: RequirementCoverage;
	readonly assurance: OutcomeAssurance;
	readonly artifacts: readonly { readonly kind: OutcomeArtifactKind; readonly ref: string }[];
	readonly changedFiles: readonly string[];
	readonly cost: {
		readonly usd: number;
		readonly metered: boolean;
		readonly inputTokens: number;
		readonly outputTokens: number;
	};
	readonly durationMs: number;
	readonly attempts: readonly OutcomeAttempt[];
	readonly nextAction: NextAction;
	/** The decision exit that produced `nextAction`. */
	readonly ladder: { readonly rung: number; readonly exit: string };
	readonly children?: readonly string[];
	/** Path of the OutcomeDigest artifact. */
	readonly digestRef?: string;
	readonly recordedAt: string;
}

/**
 * An outcome written by a newer build than this one. It keeps only the identity fields every version carries; readers
 * recompute the outcome from durable facts instead of trusting a shape they do not know.
 */
export interface OutcomeFromNewerBuild {
	readonly v: number;
	readonly outcomeId: string;
	readonly generation: number;
	readonly recordedAt: string;
	readonly unsupported: true;
}

export type StoredOutcome = Outcome | OutcomeFromNewerBuild;

export interface OutcomeDigest {
	readonly v: 1;
	readonly outcomeId: string;
	/** Fenced as untrusted when it carries worker words. */
	readonly summary: string;
	readonly blockerDetail?: string;
	readonly findings: readonly {
		readonly summary: string;
		readonly confidence: number;
		readonly cites: readonly string[];
	}[];
	readonly receipts?: readonly {
		readonly command: string;
		readonly exitCode?: number;
		readonly isError: boolean;
		readonly attestedBy?: string;
	}[];
}

export const OUTCOME_LIMITS = {
	maxRequirementIds: 64,
	maxSourceCodes: 8,
	maxArtifacts: 32,
	maxChangedFiles: 64,
	maxAttempts: 12,
	maxChildren: 64,
	maxStringChars: 160,
	maxRefChars: 4096,
	maxSerializedBytes: 8 * 1024,
	digestMaxBytes: 64 * 1024,
	digestSummaryChars: 2000,
	digestBlockerDetailChars: 500,
	digestFindings: 12,
	digestReceipts: 32,
	describeChars: 280,
} as const;

export function isOutcomeFromNewerBuild(outcome: StoredOutcome | undefined): outcome is OutcomeFromNewerBuild {
	return outcome !== undefined && "unsupported" in outcome;
}
