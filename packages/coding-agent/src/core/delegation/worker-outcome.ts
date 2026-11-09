import { fileURLToPath } from "node:url";
import { harnessLog } from "../../kernel/harness-log.ts";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import type {
	WorkerClaim,
	WorkerClaimStatus,
	WorkerHostFindingCode,
	WorkerHostVerdictKind,
	WorkerReportRequirementStatus,
} from "../autonomy/contracts.ts";
import type { ArtifactContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { attemptVerification } from "../orchestration/verification-identity.ts";
import { boundedText } from "../util/bounded-line.ts";
import {
	attemptRung,
	type HostRequirementCheck,
	type OutcomeLadderContext,
	outcomeLadderFacts,
} from "./worker-escalation-facts.ts";
import { decideNextAction, type JudgmentPair } from "./worker-escalation-policy.ts";
import {
	attemptAwaitsVerification,
	NONTERMINAL_WORKER_ATTEMPT_STATUSES,
	projectWorkerAttemptLaneRecord,
} from "./worker-lane-projection.ts";
import {
	BLOCKER_ATTRIBUTION,
	BLOCKER_CODES,
	type BlockerAttribution,
	type BlockerCode,
	isOutcomeFromNewerBuild,
	OUTCOME_LIMITS,
	OUTCOME_VERSION,
	type Outcome,
	type OutcomeArtifactKind,
	type OutcomeAssurance,
	type OutcomeAttempt,
	type OutcomeStatus,
	type RequirementCoverage,
	type StoredOutcome,
	type UncoveredReason,
	WORKER_DECLARABLE_BLOCKERS,
	type WorkerDeclarableBlocker,
} from "./worker-outcome-contract.ts";

export * from "./worker-outcome-contract.ts";
export * from "./worker-outcome-words.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Source codes -> BlockerCode. Exact matches first, then prefixes for parameterized codes. A code no row names maps to
// `unclassified` and is logged, so the taxonomy gains an entry instead of a guess.
// ---------------------------------------------------------------------------------------------------------------------

const EXACT_SOURCE_CODES: Readonly<Record<string, BlockerCode>> = {
	// work quality
	requirement_partial: "requirement_uncovered",
	requirement_not_met: "requirement_uncovered",
	worker_partial: "requirement_uncovered",
	worker_failed: "requirement_uncovered",
	requirement_missing: "evidence_missing",
	requirement_id_unknown: "evidence_missing",
	requirement_without_evidence: "evidence_missing",
	requirement_unknown_evidence: "evidence_missing",
	requirement_evidence_incomplete: "evidence_missing",
	requirement_not_applicable_without_reason: "evidence_missing",
	change_not_recorded: "evidence_missing",
	verifier_without_verdict: "evidence_missing",
	worker_report_unbacked: "evidence_contradicts_claim",
	requirement_evidence_failed: "evidence_contradicts_claim",
	unreported_changes: "evidence_contradicts_claim",
	unparseable_output: "output_malformed",
	runaway_output: "output_malformed",
	summary_length_stop: "output_malformed",
	invalid_worker_claim: "output_malformed",
	context_overflow: "context_exhausted",
	token_budget_below_floor: "context_exhausted",
	timeout: "time_exhausted",
	wall_clock_exceeded: "time_exhausted",
	stall_limit_reached: "time_exhausted",
	// verification
	independent_verification_required: "verification_pending",
	verification_repair_required: "verification_pending",
	worker_host_findings: "unverified_result",
	// worker-stated
	worker_blocked: "worker_reported_blocker",
	worker_reported_blocker: "worker_reported_blocker",
	semantic_missing_information: "worker_reported_blocker",
	// model and provider
	worker_model_pin_unavailable: "model_unavailable",
	worker_model_pin_conflict: "model_unavailable",
	worker_model_disallowed: "model_unavailable",
	model_unsupported: "model_unavailable",
	worker_run_model_unpriced: "model_unavailable",
	worker_delegation_model_unpriced: "model_unavailable",
	overloaded: "provider_transient",
	rate_limit: "provider_transient",
	server_error: "provider_transient",
	network: "provider_transient",
	stream_stall: "provider_transient",
	billing_or_quota: "provider_quota",
	auth: "provider_auth",
	// limits
	budget_exhausted: "budget_exhausted",
	attempt_budget_exhausted: "budget_exhausted",
	worker_tree_attempt_budget_exhausted: "budget_exhausted",
	// scope and authority
	path_denied: "scope_denied",
	path_outside_allowed_roots: "scope_denied",
	overlapping_write_scope: "scope_denied",
	tool_denied: "scope_denied",
	tool_not_allowed: "scope_denied",
	role_ceiling_denied: "scope_denied",
	owner_authority_required: "owner_authority_required",
	approval_rejected: "owner_authority_required",
	// environment
	write_reservation_unavailable: "capacity_unavailable",
	worker_agent_session_limit_reached: "capacity_unavailable",
	worker_specialist_busy: "capacity_unavailable",
	worker_dispatch_dropped: "capacity_unavailable",
	worker_dispatch_queue_full: "capacity_unavailable",
	worker_interrupted: "interrupted",
	worker_process_interrupted: "interrupted",
	worker_cancelled: "interrupted",
	agent_interrupted: "interrupted",
	agent_process_interrupted: "interrupted",
	aborted: "interrupted",
	worker_start_aborted: "interrupted",
	session_disposed: "interrupted",
	interrupt_report_deadline: "interrupted",
	grant_expired: "interrupted",
	worker_task_recovered_after_prepare_interruption: "interrupted",
	worker_action_outcome_unknown: "action_outcome_unknown",
	// harness and request
	dependency_failed_or_cancelled: "dependency_failed",
	worker_preflight_error: "preflight_failed",
	worker_task_fitness_unavailable: "preflight_failed",
	worker_task_fitness_stale: "preflight_failed",
	worker_task_fitness_binding_unavailable: "preflight_failed",
	worker_task_model_unconfirmed: "model_fit_open",
	worker_task_model_fit_open: "model_fit_open",
	worker_delegation_error: "preflight_failed",
	// cancellation
	user_cancelled: "cancelled_by_owner",
	agent_cancelled: "cancelled_by_owner",
	parent_cancelled: "cancelled_by_owner",
	cancelled: "cancelled_by_owner",
	objective_cancelled: "cancelled_by_owner",
	forced_retire: "cancelled_by_owner",
	retired_with_force: "cancelled_by_owner",
	worker_agent_parent_retired: "cancelled_by_owner",
	superseded: "superseded",
	objective_completed: "superseded",
	// a placed job on a linked machine (`remote/outcome-adapter.ts`)
	machine_offline: "placement_unreachable",
	machine_revoked: "placement_unreachable",
	remote_lost: "placement_unreachable",
	machine_refused: "placement_unreachable",
	"machine_refused:no_room": "capacity_unavailable",
	"machine_refused:peer_budget_out": "capacity_unavailable",
	remote_deadline: "deadline_reached",
	owner_cancelled: "cancelled_by_owner",
};

const PREFIX_SOURCE_CODES: readonly (readonly [string, BlockerCode])[] = [
	["independent_verification_rejected:", "verification_failed"],
	["independent_verification_inconclusive:", "unverified_result"],
	["worker_task_model_inadequate", "model_unfit"],
	["orchestration_model_unavailable:", "model_unavailable"],
	["worker_model_not_allowed:", "model_unavailable"],
	["orchestration_tool_unavailable:", "scope_denied"],
	["orchestration_tool_capability_missing:", "scope_denied"],
	["check_", "evidence_missing"],
	["fanout_race", "superseded"],
	["machine_refused:", "placement_unreachable"],
];

/** The prefix a linked machine's reported blocker carries: `remote_reported:<blocker>` names the blocker it reported. */
const REMOTE_REPORTED = "remote_reported:";

/** The blocker one host source code names; undefined when no row names it. `none` for an accepted completion. */
export function blockerForSourceCode(code: string): BlockerCode | undefined {
	if (code === "worker_completed" || code === "independent_verification_accepted") return "none";
	const exact = EXACT_SOURCE_CODES[code];
	if (exact) return exact;
	if (code.startsWith(REMOTE_REPORTED)) {
		const reported = code.slice(REMOTE_REPORTED.length);
		return (BLOCKER_CODES as readonly string[]).includes(reported) && reported !== "none"
			? (reported as BlockerCode)
			: undefined;
	}
	return PREFIX_SOURCE_CODES.find(([prefix]) => code.startsWith(prefix))?.[1];
}

// ---------------------------------------------------------------------------------------------------------------------
// Claim facts: the host-normalized claim fields the projection reads. When the terminal path has no claim (verification
// reconcile, cancellation, recovery), the same attempt's previous outcome supplies what the host had judged.
// ---------------------------------------------------------------------------------------------------------------------

interface ClaimFacts {
	readonly status?: WorkerClaimStatus;
	readonly verdict?: WorkerHostVerdictKind;
	readonly judgedByCode: boolean;
	readonly coveredIds: readonly string[];
	readonly verdictReasonCodes: readonly string[];
	readonly findingCodes: readonly WorkerHostFindingCode[];
	readonly declared?: WorkerDeclarableBlocker;
	readonly requirementStatus: ReadonlyMap<string, WorkerReportRequirementStatus>;
	/** Requirements the worker named as unsettled: uncovered with reason `inconclusive` until a host fact settles them. */
	readonly inconclusiveIds: ReadonlySet<string>;
	readonly changedFiles?: readonly string[];
}

function isWorkerDeclarableBlocker(value: unknown): value is WorkerDeclarableBlocker {
	return WORKER_DECLARABLE_BLOCKERS.some((code) => code === value);
}

function claimFacts(claim: WorkerClaim): ClaimFacts {
	const verdict = claim.hostVerdict;
	const declared = claim.report?.blockerCode;
	return {
		status: claim.status,
		...(verdict ? { verdict: verdict.verdict } : {}),
		judgedByCode: verdict?.judgedBy === "code",
		coveredIds: verdict?.judgedBy === "code" ? verdict.coveredRequirementIds : [],
		verdictReasonCodes: verdict?.reasonCodes ?? [],
		findingCodes: (claim.hostFindings ?? []).map((finding) => finding.code),
		// A declared code counts only on a claim that states a blocker; host facts still override it.
		...(isWorkerDeclarableBlocker(declared) && (claim.status === "blocked" || (claim.blockers?.length ?? 0) > 0)
			? { declared }
			: {}),
		requirementStatus: new Map((claim.report?.requirements ?? []).map((entry) => [entry.id, entry.status])),
		inconclusiveIds: new Set((claim.report?.inconclusiveRequirements ?? []).map((entry) => entry.requirementId)),
		changedFiles: claim.changedFiles,
	};
}

function carriedClaimFacts(previous: Outcome): ClaimFacts {
	return {
		judgedByCode: false,
		coveredIds: previous.coverage.covered.filter((entry) => entry.by === "host_verdict").map((entry) => entry.id),
		verdictReasonCodes: [],
		findingCodes: [],
		requirementStatus: new Map(),
		inconclusiveIds: new Set(),
		changedFiles: previous.changedFiles,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------------------------------

export interface ProjectOutcomeInput {
	readonly snapshot: TaskRuntimeProjection;
	readonly attemptId: string;
	/** The host-normalized claim of this exact attempt, when the terminal path holds it. */
	readonly claim?: WorkerClaim;
	readonly generation: number;
	readonly outcomeId: string;
	/** The task's latest stored outcome. */
	readonly previous?: StoredOutcome;
	readonly recordedAt: string;
	/** What the escalation ladder reads beyond the journal; absent runs its hands-off defaults. */
	readonly ladder?: OutcomeLadderContext;
	/** Host requirement checks run after this attempt ended; later projections carry them from the stored outcome. */
	readonly requirementChecks?: readonly HostRequirementCheck[];
	/** A rerun the escalation could not start under the original authority (recorded by the rung executor). */
	readonly rungRefusal?: string;
	/** System One's answer pair for a worker-stated blocker (Q1 owner-only, Q1s sufficient); absent is open. */
	readonly ownerOnly?: JudgmentPair;
}

/**
 * Which requirement ids a host check settled for this attempt: the checks just run, else the ones the same attempt's
 * stored outcome recorded (a pass is covered by `requirement_check`, a failure is `evidence_failed` on a checkable id).
 */
function settledChecks(
	input: ProjectOutcomeInput,
	sameAttemptPrevious: Outcome | undefined,
): ReadonlyMap<string, boolean> {
	if (input.requirementChecks) return new Map(input.requirementChecks.map((check) => [check.id, check.passed]));
	if (!sameAttemptPrevious) return new Map();
	const checkable = input.ladder?.requirementCheckIds?.() ?? new Set<string>();
	return new Map([
		...sameAttemptPrevious.coverage.covered
			.filter((entry) => entry.by === "requirement_check")
			.map((entry) => [entry.id, true] as const),
		...sameAttemptPrevious.coverage.uncovered
			.filter((entry) => entry.reason === "evidence_failed" && checkable.has(entry.id))
			.map((entry) => [entry.id, false] as const),
	]);
}

interface BlockerChoice {
	readonly blocker: BlockerCode;
	readonly source?: string;
}

type ProjectionLaneStatus =
	| "succeeded"
	| "partial"
	| "blocked"
	| "failed"
	| "canceled"
	| "timeout"
	| "budget_exhausted";

/**
 * The outcome of one terminal attempt, computed from durable facts: the attempt and its result, the reconciled
 * verification, and the host-normalized claim. Undefined while the attempt is still running.
 */
export function projectOutcome(input: ProjectOutcomeInput): Outcome | undefined {
	const { snapshot } = input;
	const attempt = snapshot.attempts[input.attemptId];
	const task = attempt ? snapshot.tasks[attempt.taskId] : undefined;
	if (!attempt || !task || NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status)) return undefined;
	const lane = projectWorkerAttemptLaneRecord(snapshot, attempt.attemptId);
	if (!lane) return undefined;
	const awaitingVerification = attemptAwaitsVerification(snapshot, attempt);
	if (!awaitingVerification && (lane.status === "queued" || lane.status === "running")) return undefined;
	const laneStatus = lane.status as ProjectionLaneStatus | "running";
	const previous = input.previous && !isOutcomeFromNewerBuild(input.previous) ? input.previous : undefined;
	const sameAttemptPrevious = previous?.attempts.at(-1)?.attemptId === attempt.attemptId ? previous : undefined;
	const facts: ClaimFacts | undefined = input.claim
		? claimFacts(input.claim)
		: sameAttemptPrevious
			? carriedClaimFacts(sameAttemptPrevious)
			: undefined;
	const verification = attemptVerification(snapshot, attempt);
	const required = (attempt.dispatch.requirementIds ?? []).slice(0, OUTCOME_LIMITS.maxRequirementIds);
	const checks = settledChecks(input, sameAttemptPrevious);
	const coverage = projectCoverage(required, facts, checks, verification?.verdict, awaitingVerification, laneStatus);
	const sourceCodes = collectSourceCodes(attempt, lane.reasonCode, facts);
	const choice = selectBlocker({
		laneStatus,
		awaitingVerification,
		verificationVerdict: verification?.verdict,
		resultAccepted: attempt.result?.status === "completed",
		coverage,
		facts,
		reasonCode: lane.reasonCode,
		attempt,
	});
	let status = selectStatus(laneStatus, choice.blocker, coverage, verification?.verdict);
	let blocker = status === "succeeded" ? "none" : choice.blocker;
	if (status !== "succeeded" && blocker === "none") {
		blocker = "unclassified";
		status = status === "partial" || status === "blocked" ? status : "failed";
	}
	if (blocker === "unclassified") {
		harnessLog.warn("outcomes", "a worker outcome has no classified blocker", () => ({
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			laneStatus,
			sourceCodes,
		}));
	}
	const step = decideNextAction(
		outcomeLadderFacts({
			snapshot,
			attempt,
			lane,
			status,
			blocker,
			coverage,
			previous,
			checkedIds: new Set(checks.keys()),
			context: input.ladder,
			...(input.ownerOnly ? { ownerOnly: input.ownerOnly } : {}),
			...(input.rungRefusal !== undefined ? { rungRefusal: input.rungRefusal } : {}),
		}),
	);
	harnessLog.debug("outcomes", "the escalation ladder decided a next action", () => ({
		taskId: attempt.taskId,
		attemptId: attempt.attemptId,
		exit: step.exit,
		trace: step.trace.join(","),
	}));
	const outcome: Outcome = {
		v: OUTCOME_VERSION,
		outcomeId: input.outcomeId,
		scope: "lane",
		nodeId: attempt.taskId,
		taskId: attempt.taskId,
		objectiveId: task.task.objectiveId,
		generation: input.generation,
		status,
		blocker,
		attribution: blocker === "none" ? "none" : BLOCKER_ATTRIBUTION[blocker],
		sourceCodes,
		coverage,
		assurance: assuranceFor(status, required, facts, coverage, verification?.verdict),
		artifacts: outcomeArtifacts(attempt.result?.artifacts ?? []),
		changedFiles: (facts?.changedFiles ?? changedFilesFromArtifacts(attempt.result?.artifacts ?? [])).slice(
			0,
			OUTCOME_LIMITS.maxChangedFiles,
		),
		cost: outcomeCost(attempt),
		durationMs: Math.max(
			0,
			Math.round(attempt.result?.usage.wallClockMs ?? attempt.usageAccounting?.total.activeWallClockMs ?? 0),
		),
		attempts: outcomeAttempts(previous, attempt, lane, laneStatus, attemptRung(snapshot, attempt)),
		nextAction: step.nextAction,
		ladder: { rung: step.rung, exit: step.exit },
		recordedAt: input.recordedAt,
	};
	return withinSerializedBound(outcome);
}

function projectCoverage(
	required: readonly string[],
	facts: ClaimFacts | undefined,
	checks: ReadonlyMap<string, boolean>,
	verificationVerdict: "accepted" | "rejected" | "inconclusive" | undefined,
	awaitingVerification: boolean,
	laneStatus: ProjectionLaneStatus | "running",
): RequirementCoverage {
	if (verificationVerdict === "accepted") {
		return { required, covered: required.map((id) => ({ id, by: "verification" as const })), uncovered: [] };
	}
	const coveredIds = new Set(facts?.coveredIds ?? []);
	const covered = required
		.filter((id) => coveredIds.has(id) || checks.get(id) === true)
		.map((id) => ({ id, by: coveredIds.has(id) ? ("host_verdict" as const) : ("requirement_check" as const) }));
	const uncovered = required
		.filter((id) => !coveredIds.has(id) && checks.get(id) !== true)
		.map((id) => ({
			id,
			reason:
				checks.get(id) === false
					? ("evidence_failed" as const)
					: uncoveredReason(id, facts, verificationVerdict, awaitingVerification, laneStatus),
		}));
	return { required, covered, uncovered };
}

function uncoveredReason(
	id: string,
	facts: ClaimFacts | undefined,
	verificationVerdict: "accepted" | "rejected" | "inconclusive" | undefined,
	awaitingVerification: boolean,
	laneStatus: ProjectionLaneStatus | "running",
): UncoveredReason {
	if (verificationVerdict === "rejected") return "evidence_failed";
	if (verificationVerdict === "inconclusive") return "inconclusive";
	if (awaitingVerification) return "unverified";
	const reported = facts?.requirementStatus.get(id);
	if (reported === "partial") return "partial";
	if (reported === "not_met") return "not_met";
	if (facts?.inconclusiveIds.has(id)) return "inconclusive";
	if (facts?.verdict === "needs_more") return "no_evidence";
	if (facts?.verdict === "rejected") return "evidence_failed";
	if (facts?.verdict === "unverified") return "unverified";
	if (facts?.status === "completed" || laneStatus === "succeeded") return "no_evidence";
	return "not_attempted";
}

function collectSourceCodes(
	attempt: AttemptRuntimeState,
	laneReasonCode: string | undefined,
	facts: ClaimFacts | undefined,
): string[] {
	const codes = [
		laneReasonCode,
		attempt.result?.reasonCode,
		attempt.reasonCode,
		...(facts?.verdictReasonCodes ?? []),
		...(facts?.findingCodes ?? []).map((code) => `host_finding:${code}`),
		...(facts?.declared ? [`worker_declared:${facts.declared}`] : []),
	].filter((code): code is string => typeof code === "string" && code.length > 0);
	return [...new Set(codes)]
		.slice(0, OUTCOME_LIMITS.maxSourceCodes)
		.map((code) => boundedText(code, OUTCOME_LIMITS.maxStringChars));
}

const FINDING_BLOCKERS: Readonly<Record<WorkerHostFindingCode, BlockerCode>> = {
	overlap: "scope_denied",
	protected_path: "scope_denied",
	omitted: "evidence_missing",
	lane: "unverified_result",
};

function selectBlocker(args: {
	laneStatus: ProjectionLaneStatus | "running";
	awaitingVerification: boolean;
	verificationVerdict: "accepted" | "rejected" | "inconclusive" | undefined;
	resultAccepted: boolean;
	coverage: RequirementCoverage;
	facts: ClaimFacts | undefined;
	reasonCode: string | undefined;
	attempt: AttemptRuntimeState;
}): BlockerChoice {
	const { facts, reasonCode } = args;
	if (args.laneStatus === "canceled") return mappedBlocker(reasonCode);
	if (args.verificationVerdict === "accepted") return { blocker: "none" };
	if (args.verificationVerdict === "rejected") return { blocker: "verification_failed", source: reasonCode };
	if (args.verificationVerdict === "inconclusive") return { blocker: "unverified_result", source: reasonCode };
	if (args.awaitingVerification) return { blocker: "verification_pending" };
	if (facts?.declared) return { blocker: facts.declared, source: `worker_declared:${facts.declared}` };
	const finding =
		facts?.findingCodes.find((code) => FINDING_BLOCKERS[code] === "scope_denied") ?? facts?.findingCodes[0];
	if (finding) return { blocker: FINDING_BLOCKERS[finding], source: `host_finding:${finding}` };
	if (facts?.verdict === "rejected" || facts?.verdict === "needs_more") {
		const mapped = facts.verdictReasonCodes
			.map((code) => ({ code, blocker: blockerForSourceCode(code) }))
			.find((entry) => entry.blocker !== undefined && entry.blocker !== "none");
		if (mapped?.blocker) return { blocker: mapped.blocker, source: mapped.code };
		return { blocker: facts.verdict === "rejected" ? "evidence_contradicts_claim" : "evidence_missing" };
	}
	if (facts?.verdict === "blocked") return { blocker: "worker_reported_blocker" };
	if (args.laneStatus === "timeout") return { blocker: "time_exhausted", source: reasonCode };
	if (args.laneStatus === "budget_exhausted") return { blocker: "budget_exhausted", source: reasonCode };
	if (reasonCode === "completion_error") return classifiedCompletionError(args.attempt);
	const mapped = mappedBlocker(reasonCode);
	if (mapped.blocker !== "none" && mapped.blocker !== "unclassified") return mapped;
	if (args.coverage.uncovered.length > 0) {
		// The host accepted the work but nothing it checked covers these ids: the result stands unverified.
		return args.resultAccepted || facts?.verdict === "accepted" || facts?.verdict === "unverified"
			? { blocker: "unverified_result" }
			: { blocker: "requirement_uncovered" };
	}
	if (facts?.verdict === "unverified") return { blocker: "unverified_result" };
	if (args.resultAccepted) return { blocker: "none" };
	// A completed claim the host did not accept with nothing else named: a parent review holds it.
	if (facts?.status === "completed") return { blocker: "unverified_result", source: reasonCode };
	return mapped;
}

function mappedBlocker(code: string | undefined): BlockerChoice {
	if (code === undefined) return { blocker: "unclassified" };
	return { blocker: blockerForSourceCode(code) ?? "unclassified", source: code };
}

/** A completion error is classified through its host diagnostic when one was retained. */
function classifiedCompletionError(attempt: AttemptRuntimeState): BlockerChoice {
	if (!attempt.reasonDetail) return { blocker: "unclassified", source: "completion_error" };
	const classified = classifyFailure({ message: attempt.reasonDetail, provider: attemptProvider(attempt) });
	const blocker = blockerForSourceCode(classified.reason);
	return { blocker: blocker && blocker !== "none" ? blocker : "unclassified", source: classified.reason };
}

function attemptProvider(attempt: AttemptRuntimeState): string {
	return (
		attempt.runningModel?.provider ??
		attempt.dispatch.executionContract?.worker.modelBinding.provider ??
		attempt.dispatch.provider ??
		"unknown"
	);
}

const CLAIM_STATUS_BLOCKS: ReadonlySet<BlockerAttribution> = new Set(["owner", "harness", "task"]);

/** S1-S9 of the outcome table, first match wins. */
function selectStatus(
	laneStatus: ProjectionLaneStatus | "running",
	blocker: BlockerCode,
	coverage: RequirementCoverage,
	verificationVerdict: "accepted" | "rejected" | "inconclusive" | undefined,
): OutcomeStatus {
	if (laneStatus === "canceled") return "cancelled";
	if (verificationVerdict === "accepted") return "succeeded";
	if (blocker === "none" && laneStatus === "succeeded" && coverage.uncovered.length === 0) return "succeeded";
	// S4: every required id is covered and the host's own requirement checks proved at least one of them.
	if (
		verificationVerdict !== "rejected" &&
		coverage.required.length > 0 &&
		coverage.uncovered.length === 0 &&
		coverage.covered.some((entry) => entry.by === "requirement_check")
	)
		return "succeeded";
	if (coverage.covered.length > 0 && coverage.uncovered.length > 0) return "partial";
	if (CLAIM_STATUS_BLOCKS.has(BLOCKER_ATTRIBUTION[blocker]) || laneStatus === "blocked") return "blocked";
	// An honest partial, or host-accepted work that stands unverified, is partial with a classified blocker.
	if ((laneStatus === "partial" || laneStatus === "succeeded") && blocker !== "unclassified") return "partial";
	// S7 (failed, timeout or budget with nothing covered), S8 (completed but not accepted) and S9 all read failed.
	return "failed";
}

function assuranceFor(
	status: OutcomeStatus,
	required: readonly string[],
	facts: ClaimFacts | undefined,
	coverage: RequirementCoverage,
	verificationVerdict: "accepted" | "rejected" | "inconclusive" | undefined,
): OutcomeAssurance {
	if (status !== "succeeded") return "unverified";
	if (verificationVerdict === "accepted") return "independently_verified";
	if (coverage.covered.some((entry) => entry.by === "requirement_check")) return "host_check";
	// Host evidence is a code-judged accepted verdict; a success without it stays unverified.
	if (facts?.verdict === "accepted" && facts.judgedByCode) return "host_verified";
	return required.length === 0 ? "unverified" : "host_verified";
}

const ARTIFACT_KINDS: Readonly<Record<ArtifactContract["kind"], OutcomeArtifactKind>> = {
	diff: "file",
	file: "file",
	report: "report",
	"test-result": "receipt",
	log: "receipt",
	"structured-data": "receipt",
};

function outcomeArtifacts(artifacts: readonly ArtifactContract[]): Outcome["artifacts"] {
	return artifacts
		.filter((artifact) => artifact.uri.length > 0 && artifact.uri.length <= OUTCOME_LIMITS.maxRefChars)
		.slice(0, OUTCOME_LIMITS.maxArtifacts)
		.map((artifact) => ({ kind: ARTIFACT_KINDS[artifact.kind], ref: artifact.uri }));
}

function changedFilesFromArtifacts(artifacts: readonly ArtifactContract[]): string[] {
	return artifacts.flatMap((artifact) => {
		if (!artifact.artifactId.startsWith("changed-file-") || !artifact.uri.startsWith("file:")) return [];
		try {
			return [fileURLToPath(artifact.uri)];
		} catch {
			return [];
		}
	});
}

function outcomeCost(attempt: AttemptRuntimeState): Outcome["cost"] {
	const total = attempt.usageAccounting?.total;
	const usd = total?.costUsd ?? attempt.result?.usage.costUsd;
	return {
		usd: usd !== undefined && Number.isFinite(usd) && usd > 0 ? usd : 0,
		metered: usd !== undefined,
		inputTokens: Math.max(0, Math.round(total?.inputTokens ?? attempt.result?.usage.inputTokens ?? 0)),
		outputTokens: Math.max(0, Math.round(total?.outputTokens ?? attempt.result?.usage.outputTokens ?? 0)),
	};
}

function outcomeAttempts(
	previous: Outcome | undefined,
	attempt: AttemptRuntimeState,
	lane: { modelRef?: string; thinkingLevel?: string; completedAt?: string },
	laneStatus: string,
	rung: number,
): OutcomeAttempt[] {
	const current: OutcomeAttempt = {
		attemptId: attempt.attemptId,
		...(attempt.result ? { resultId: attempt.result.resultId } : {}),
		modelRef: lane.modelRef ?? "unknown",
		thinking: lane.thinkingLevel ?? "default",
		rung,
		laneStatus,
		startedAt: attempt.executionStartedAt ?? attempt.createdAt,
		...(lane.completedAt ? { endedAt: lane.completedAt } : {}),
	};
	const earlier = (previous?.attempts ?? []).filter((entry) => entry.attemptId !== attempt.attemptId);
	return [...earlier, current].slice(-OUTCOME_LIMITS.maxAttempts);
}

/** Drop the least load-bearing lists until the record fits its serialized bound. */
function withinSerializedBound(outcome: Outcome): Outcome {
	const size = (value: Outcome): number => Buffer.byteLength(JSON.stringify(value), "utf8");
	let bounded = outcome;
	while (size(bounded) > OUTCOME_LIMITS.maxSerializedBytes) {
		if (bounded.changedFiles.length > 0) bounded = { ...bounded, changedFiles: bounded.changedFiles.slice(0, -1) };
		else if (bounded.artifacts.length > 0) bounded = { ...bounded, artifacts: bounded.artifacts.slice(0, -1) };
		else if (bounded.attempts.length > 1) bounded = { ...bounded, attempts: bounded.attempts.slice(1) };
		else break;
	}
	return bounded;
}

/** Whether two outcomes say the same thing; identity, generation, time and the digest pointer are not content. */
export function sameOutcomeContent(left: Outcome, right: Outcome): boolean {
	const content = ({ outcomeId: _id, generation: _g, recordedAt: _r, digestRef: _d, ...rest }: Outcome) => rest;
	return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

// ---------------------------------------------------------------------------------------------------------------------
// Aggregation (joins and leaders)
// ---------------------------------------------------------------------------------------------------------------------

const STATUS_SEVERITY: Readonly<Record<OutcomeStatus, number>> = {
	succeeded: 0,
	partial: 1,
	cancelled: 2,
	failed: 3,
	blocked: 4,
};

/** The outcome of a join or leader scope from its children's outcomes; the identity is the caller's. */
export function aggregateOutcomes(
	children: readonly Outcome[],
	policy: "all" | "any" | { quorum: number },
	scope: "join" | "leader",
	identity: { outcomeId: string; nodeId: string; objectiveId: string; generation: number; recordedAt: string },
): Outcome {
	const succeeded = children.filter((child) => child.status === "succeeded");
	const needed = policy === "all" ? children.length : policy === "any" ? 1 : Math.max(1, policy.quorum);
	const worst = children
		.filter((child) => child.status !== "succeeded")
		.sort((left, right) => STATUS_SEVERITY[right.status] - STATUS_SEVERITY[left.status])[0];
	const status: OutcomeStatus =
		children.length > 0 && succeeded.length >= needed
			? "succeeded"
			: succeeded.length > 0 || children.some((child) => child.status === "partial")
				? "partial"
				: (worst?.status ?? "failed");
	const blocker: BlockerCode = status === "succeeded" ? "none" : (worst?.blocker ?? "unclassified");
	const required = [...new Set(children.flatMap((child) => child.coverage.required))].slice(
		0,
		OUTCOME_LIMITS.maxRequirementIds,
	);
	const covered = new Map(
		children.flatMap((child) => child.coverage.covered.map((entry) => [entry.id, entry] as const)),
	);
	const uncovered = new Map(
		children.flatMap((child) => child.coverage.uncovered.map((entry) => [entry.id, entry] as const)),
	);
	const assurances = succeeded.map((child) => child.assurance);
	return withinSerializedBound({
		v: OUTCOME_VERSION,
		...identity,
		scope,
		status,
		blocker,
		attribution: blocker === "none" ? "none" : BLOCKER_ATTRIBUTION[blocker],
		sourceCodes: [...new Set(children.flatMap((child) => child.sourceCodes))].slice(0, OUTCOME_LIMITS.maxSourceCodes),
		coverage: {
			required,
			covered: required.filter((id) => covered.has(id)).map((id) => covered.get(id)!),
			uncovered: required
				.filter((id) => !covered.has(id))
				.map((id) => uncovered.get(id) ?? { id, reason: "not_attempted" }),
		},
		assurance:
			status === "succeeded" && assurances.length > 0 && assurances.every((value) => value === assurances[0])
				? assurances[0]!
				: "unverified",
		artifacts: children.flatMap((child) => child.artifacts).slice(0, OUTCOME_LIMITS.maxArtifacts),
		changedFiles: [...new Set(children.flatMap((child) => child.changedFiles))].slice(
			0,
			OUTCOME_LIMITS.maxChangedFiles,
		),
		cost: {
			usd: children.reduce((sum, child) => sum + child.cost.usd, 0),
			metered: children.every((child) => child.cost.metered),
			inputTokens: children.reduce((sum, child) => sum + child.cost.inputTokens, 0),
			outputTokens: children.reduce((sum, child) => sum + child.cost.outputTokens, 0),
		},
		durationMs: children.reduce((longest, child) => Math.max(longest, child.durationMs), 0),
		attempts: [],
		nextAction: status === "succeeded" ? { kind: "accept" } : (worst?.nextAction ?? { kind: "accept" }),
		ladder: { rung: 0, exit: `aggregate_${typeof policy === "string" ? policy : "quorum"}` },
		children: children.map((child) => child.outcomeId).slice(0, OUTCOME_LIMITS.maxChildren),
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Subscribers: notified after an outcome is durably recorded.
// ---------------------------------------------------------------------------------------------------------------------

const outcomeListeners = new Set<(outcome: Outcome) => void>();

export function subscribeOutcomes(listener: (outcome: Outcome) => void): () => void {
	outcomeListeners.add(listener);
	return () => {
		outcomeListeners.delete(listener);
	};
}

/** Called by the recorder after the outcome is committed; a listener's failure never reaches the writer. */
export function publishOutcome(outcome: Outcome): void {
	for (const listener of [...outcomeListeners]) {
		try {
			listener(outcome);
		} catch (error) {
			harnessLog.warn("outcomes", "an outcome subscriber failed", () => ({
				outcomeId: outcome.outcomeId,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}
}
