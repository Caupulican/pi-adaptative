import type { WorkerClaim, WorkerHostVerdict } from "../autonomy/contracts.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { CommsStateCode } from "../provider-prompt-contracts.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { NextAction } from "./worker-outcome-contract.ts";
import { sameOutcomeAttempt } from "./worker-outcome-words.ts";

/**
 * What the host recommends the root do with a worker whose task ended. It is advice printed for the
 * root, which owns the worker's lifecycle: nothing here blocks, refuses, retires or cancels anything,
 * and `retire` still needs the root's call and the existing preconditions (idle, clear mailbox).
 */
export type WorkerDisposition = "retire" | "idle" | "needs_follow_up";

export interface WorkerDispositionAdvice {
	readonly disposition: WorkerDisposition;
	/** Plain, single line, at most MAX_WORKER_DISPOSITION_REASON_CHARS. */
	readonly reason: string;
}

export const MAX_WORKER_DISPOSITION_REASON_CHARS = 160;

/** The claim fields the disposition reads; a legacy claim simply lacks `hostVerdict`. */
export type WorkerDispositionClaim = Pick<
	WorkerClaim,
	| "status"
	| "blockers"
	| "inconclusive"
	| "parentReviewRequired"
	| "parentReviewedAt"
	| "verification"
	| "hostVerdict"
	| "ownerFollowUp"
	| "systemOneSettled"
>;

/**
 * Host facts the disposition depends on. An absent field means the host could not read that fact
 * (no orchestration snapshot or goal state reachable); it is never read as "none", so a completed
 * claim with an unknown fact degrades to `idle` rather than `retire`.
 */
export interface WorkerDispositionFacts {
	/** Non-terminal OTHER tasks of the same objective that would be routed to this worker's profile. */
	readonly openTasksForSameProfile?: number;
	/** Goal requirements still open that this worker's task correlation can take. */
	readonly uncoveredRequirementIds?: readonly string[];
}

export interface WorkerDispositionInput extends WorkerDispositionFacts {
	readonly claim?: WorkerDispositionClaim;
	/** The worker's profile id, or its role when no profile id is known; named in the reason only. */
	readonly profileId?: string;
}

function plainReason(reason: string): string {
	return boundedText(reason.replace(/[\r\n]+/g, " "), MAX_WORKER_DISPOSITION_REASON_CHARS);
}

function advice(disposition: WorkerDisposition, reason: string): WorkerDispositionAdvice {
	return { disposition, reason: plainReason(reason) };
}

/**
 * The typed next step for one ended worker task, with the decision exit that chose it and the reason printed for the
 * root. `keepWorker` says whether an accepted result still leaves this worker reusable (open work for its profile, an
 * uncovered requirement, or a fact the host could not read).
 */
export interface WorkerNextStep {
	readonly nextAction: NextAction;
	readonly keepWorker: boolean;
	readonly exit: string;
	readonly reason: string;
}

function step(nextAction: NextAction, exit: string, reason: string, keepWorker = true): WorkerNextStep {
	return { nextAction, keepWorker, exit, reason };
}

const FOLLOW_UP: NextAction = { kind: "verify_in_lane" };
const ACCEPT: NextAction = { kind: "accept" };

/**
 * The next step for one ended worker task. In order: follow up in the same lane when the host verdict, the claim or the
 * owner route leaves something unresolved; abandon a cancelled task; check an unverifiable or missing claim before
 * relying on it; otherwise accept, keeping the worker when more work for its profile or an uncovered requirement
 * remains, or when a fact is unknown. The root decides; this never acts.
 */
export function deriveWorkerNextStep(input: WorkerDispositionInput): WorkerNextStep {
	const claim = input.claim;
	if (!claim) {
		return step(
			{ kind: "verify_independently", requirementIds: [] },
			"disposition_no_claim",
			"No claim was recorded; inspect the transcript before deciding.",
		);
	}
	const verdict = claim.hostVerdict?.verdict;
	if (verdict === "needs_more")
		return step(FOLLOW_UP, "disposition_verdict_needs_more", "Host verdict needs_more: named proof is missing.");
	if (verdict === "rejected")
		return step(FOLLOW_UP, "disposition_verdict_rejected", "Host verdict rejected: a stated claim is contradicted.");
	if (verdict === "blocked")
		return step(FOLLOW_UP, "disposition_verdict_blocked", "Host verdict blocked: the worker reported a blocker.");
	if (claim.blockers && claim.blockers.length > 0) {
		return step(FOLLOW_UP, "disposition_blockers", `The claim carries ${claim.blockers.length} blocker(s).`);
	}
	if (claim.inconclusive && claim.inconclusive.length > 0) {
		return step(
			FOLLOW_UP,
			"disposition_inconclusive",
			`The claim carries ${claim.inconclusive.length} inconclusive finding(s).`,
		);
	}
	// A change flagged for review holds no problem with the work itself: the root acknowledges it with
	// `delegate review`, and the advice that follows is about what to do with the worker afterwards.
	const reviewPending = claim.parentReviewRequired === true && claim.parentReviewedAt === undefined;
	const settled = ((): WorkerNextStep => {
		if (claim.verification?.verdict === "rejected") {
			return step(FOLLOW_UP, "disposition_verification_rejected", "Independent verification rejected the claim.");
		}
		if (claim.ownerFollowUp)
			return step(FOLLOW_UP, "disposition_owner_follow_up", "An owner follow-up was recorded for open findings.");
		if (claim.status === "partial" || claim.status === "blocked" || claim.status === "failed") {
			return step(FOLLOW_UP, `disposition_claim_${claim.status}`, `The claim status is ${claim.status}.`);
		}
		if (claim.status === "cancelled")
			return step(
				{ kind: "abandon", reason: "cancelled" },
				"disposition_cancelled",
				"The task was cancelled; the worker keeps its transcript.",
			);
		if (verdict === "unverified") {
			return step(
				{ kind: "verify_independently", requirementIds: [] },
				"disposition_unverified",
				"The host could not check this claim; verify it before retiring the worker.",
			);
		}
		const open = input.openTasksForSameProfile;
		if (open !== undefined && open > 0) {
			return step(
				ACCEPT,
				"disposition_open_tasks",
				`${open} open task(s) would route to ${input.profileId ?? "this profile"}.`,
			);
		}
		const uncovered = input.uncoveredRequirementIds;
		if (uncovered !== undefined && uncovered.length > 0) {
			return step(
				ACCEPT,
				"disposition_uncovered_requirements",
				`${uncovered.length} goal requirement(s) remain uncovered: ${uncovered.slice(0, 3).join(", ")}.`,
			);
		}
		if (open === undefined || uncovered === undefined) {
			return step(
				ACCEPT,
				"disposition_facts_unknown",
				"Remaining work for this profile is unknown; keep it reusable until you decide.",
			);
		}
		return step(
			ACCEPT,
			"disposition_no_remaining_work",
			"No open task or uncovered requirement remains for this profile.",
			false,
		);
	})();
	return reviewPending
		? { ...settled, reason: `Acknowledge the change with delegate review first. ${plainReason(settled.reason)}` }
		: settled;
}

/**
 * The lifecycle advice a next action implies. Following up in the lane needs the worker; an accepted result retires it
 * only when nothing keeps it reusable; every other action leaves it idle while the root decides.
 */
export function dispositionFromNextAction(nextAction: NextAction, keepWorker: boolean): WorkerDisposition {
	switch (nextAction.kind) {
		case "verify_in_lane":
			return "needs_follow_up";
		case "accept":
			return keepWorker ? "idle" : "retire";
		default:
			return "idle";
	}
}

/** The lifecycle advice of one next step: the disposition its action implies, with its bounded reason. */
export function workerDispositionAdviceFromStep(next: WorkerNextStep): WorkerDispositionAdvice {
	return advice(dispositionFromNextAction(next.nextAction, next.keepWorker), next.reason);
}

/** Advice for the root on one ended worker task, chosen from its next action. */
export function deriveWorkerDisposition(input: WorkerDispositionInput): WorkerDispositionAdvice {
	return workerDispositionAdviceFromStep(deriveWorkerNextStep(input));
}

/**
 * Advice computed from the claim alone, for a delivery that is stored and replayed byte-for-byte
 * (a worker-to-worker handoff): live host facts and the root's later review acknowledgement would
 * change the text between a delivery and its replay. A clean claim reads `idle`; `retire` is the
 * root's call and needs the live facts.
 */
export function deriveClaimOnlyWorkerDisposition(claim: WorkerDispositionClaim | undefined): WorkerDispositionAdvice {
	// A worker parent cannot acknowledge a review, and the review state changes between delivery and replay.
	return deriveWorkerDisposition({ claim: claim ? { ...claim, parentReviewRequired: false } : undefined });
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** The attempt a lane's disposition describes: the named one, else the lane's latest. */
function dispositionAttempt(args: {
	snapshot: TaskRuntimeProjection | undefined;
	laneId: string;
	attemptId?: string;
}): AttemptRuntimeState | undefined {
	const { snapshot, laneId } = args;
	if (!snapshot) return undefined;
	if (args.attemptId !== undefined) return snapshot.attempts[args.attemptId];
	return Object.values(snapshot.attempts)
		.filter((candidate) => candidate.taskId === laneId || candidate.dispatch.logicalLaneId === laneId)
		.at(-1);
}

/**
 * Derive the host facts from the orchestration snapshot and the goal state. Either source may be
 * absent; the matching fact is then left undefined (unknown), never zero.
 */
export function deriveWorkerDispositionFacts(args: {
	snapshot: TaskRuntimeProjection | undefined;
	goal: Pick<GoalState, "requirements"> | undefined;
	laneId: string;
	attemptId?: string;
}): WorkerDispositionFacts & { profileId?: string } {
	const { snapshot, goal, laneId } = args;
	const attempt = dispositionAttempt(args);
	const profileId = attempt?.dispatch.profileId;
	const taskState = attempt ? snapshot?.tasks[attempt.taskId] : undefined;

	let openTasksForSameProfile: number | undefined;
	if (snapshot && attempt && taskState) {
		openTasksForSameProfile = 0;
		for (const other of Object.values(snapshot.tasks)) {
			if (other.task.taskId === taskState.task.taskId) continue;
			if (other.task.objectiveId !== taskState.task.objectiveId) continue;
			if (TERMINAL_TASK_STATUSES.has(other.task.status)) continue;
			// A task already dispatched names its profile; one not yet dispatched routes by role.
			const dispatched = other.attemptIds
				.map((attemptId) => snapshot.attempts[attemptId]?.dispatch.profileId)
				.filter((id): id is string => id !== undefined);
			const matches =
				dispatched.length > 0
					? dispatched.includes(attempt.dispatch.profileId)
					: other.task.role === taskState.task.role;
			if (matches) openTasksForSameProfile++;
		}
	}

	let uncoveredRequirementIds: readonly string[] | undefined;
	if (goal) {
		const correlated = new Set(attempt?.dispatch.requirementIds ?? []);
		uncoveredRequirementIds = goal.requirements
			.filter(
				(requirement) =>
					requirement.status === "open" &&
					(requirement.boundLaneId === undefined ||
						requirement.boundLaneId === laneId ||
						correlated.has(requirement.id)),
			)
			.map((requirement) => requirement.id);
	}

	return {
		...(profileId !== undefined ? { profileId } : {}),
		...(openTasksForSameProfile !== undefined ? { openTasksForSameProfile } : {}),
		...(uncoveredRequirementIds !== undefined ? { uncoveredRequirementIds } : {}),
	};
}

/** The next step for one claim given the host facts; requirements the host verdict already covers are not uncovered. */
function deriveWorkerNextStepForClaim(args: {
	claim: WorkerDispositionClaim | undefined;
	facts: (WorkerDispositionFacts & { profileId?: string }) | undefined;
	profileId?: string;
}): WorkerNextStep {
	const { claim, facts } = args;
	const covered = new Set(claim?.hostVerdict?.coveredRequirementIds ?? []);
	const profileId = facts?.profileId ?? args.profileId;
	return deriveWorkerNextStep({
		claim,
		...(profileId !== undefined ? { profileId } : {}),
		...(facts?.openTasksForSameProfile !== undefined
			? { openTasksForSameProfile: facts.openTasksForSameProfile }
			: {}),
		...(facts?.uncoveredRequirementIds !== undefined
			? { uncoveredRequirementIds: facts.uncoveredRequirementIds.filter((id) => !covered.has(id)) }
			: {}),
	});
}

/** Advice for one claim given the host facts; requirements the host verdict already covers are not uncovered. */
export function deriveWorkerDispositionForClaim(args: {
	claim: WorkerDispositionClaim | undefined;
	facts: (WorkerDispositionFacts & { profileId?: string }) | undefined;
	profileId?: string;
}): WorkerDispositionAdvice {
	return workerDispositionAdviceFromStep(deriveWorkerNextStepForClaim(args));
}

/**
 * The next step for one claim from the host's projections; absent sources degrade to unknown facts. When the attempt has
 * a recorded outcome, its action and ladder exit are the step (the ladder is the one producer of next actions); the
 * claim rules still supply the reason and whether an accepted worker stays reusable.
 */
export function deriveWorkerNextStepFromProjections(args: {
	claim: WorkerDispositionClaim | undefined;
	snapshot: TaskRuntimeProjection | undefined;
	goal: Pick<GoalState, "requirements"> | undefined;
	laneId: string;
	attemptId?: string;
}): WorkerNextStep {
	const claimStep = deriveWorkerNextStepForClaim({ claim: args.claim, facts: deriveWorkerDispositionFacts(args) });
	const attempt = dispositionAttempt(args);
	const outcome = attempt
		? sameOutcomeAttempt(args.snapshot?.tasks[attempt.taskId]?.outcome, attempt.attemptId)
		: undefined;
	return outcome
		? { ...claimStep, nextAction: outcome.nextAction, exit: outcome.ladder?.exit ?? claimStep.exit }
		: claimStep;
}

/** Derive advice for one claim from the host's projections; absent sources degrade to unknown facts. */
export function deriveWorkerDispositionFromProjections(
	args: Parameters<typeof deriveWorkerNextStepFromProjections>[0],
): WorkerDispositionAdvice {
	return workerDispositionAdviceFromStep(deriveWorkerNextStepFromProjections(args));
}

const MAX_VERDICT_LIST_ITEMS = 8;
const MAX_VERDICT_ITEM_CHARS = 120;

function verdictList(values: readonly string[]): string {
	const shown = values
		.slice(0, MAX_VERDICT_LIST_ITEMS)
		.map((value) => boundedText(value.replace(/[\r\n]+/g, " "), MAX_VERDICT_ITEM_CHARS));
	const more = values.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/** One plain line: `Host verdict: needs_more (covered: a, b; missing: x)`. */
export function describeWorkerHostVerdict(hostVerdict: WorkerHostVerdict): string {
	const parts = [
		hostVerdict.coveredRequirementIds.length > 0
			? `covered: ${verdictList(hostVerdict.coveredRequirementIds)}`
			: undefined,
		hostVerdict.missing.length > 0 ? `missing: ${verdictList(hostVerdict.missing)}` : undefined,
	].filter((part): part is string => part !== undefined);
	return `Host verdict: ${hostVerdict.verdict}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

/**
 * Whether the host's own check lets the root read a worker's report and the transcript on demand. Only an
 * accepted verdict, judged by code against the host's receipts, that names nothing missing and carries the judge's
 * `allRequirementsCovered` fact (the task named required ids and every one has passing evidence; a requirement waived
 * as not applicable is not covered), on a claim no parent review is asked for. Any other verdict, a task with no
 * required ids, or a legacy verdict without the fact, leaves something the report alone does not settle, so the
 * root reads the whole transcript.
 */
export function workerReportSufficesForAcceptance(
	claim: Pick<WorkerDispositionClaim, "hostVerdict" | "parentReviewRequired"> | undefined,
): boolean {
	return (
		claim?.hostVerdict?.verdict === "accepted" &&
		claim.hostVerdict.judgedBy === "code" &&
		claim.hostVerdict.allRequirementsCovered === true &&
		claim.hostVerdict.missing.length === 0 &&
		claim.parentReviewRequired !== true
	);
}

/**
 * The host state codes of one ended lane, as a handoff or status record states them: why the lane ended
 * (`BLOCKED`, `BUDGET`, `FAILED`) and how much of the worker the root reads before judging it.
 */
export function workerLaneStateCodes(
	lane: { status: string; reasonCode?: string },
	claim?: Pick<WorkerDispositionClaim, "hostVerdict" | "parentReviewRequired">,
): CommsStateCode[] {
	return [
		...(lane.reasonCode === "worker_blocked" ? (["BLOCKED"] as const) : []),
		...(lane.status === "budget_exhausted" ? (["BUDGET"] as const) : []),
		...(lane.reasonCode === "completion_error" ? (["FAILED"] as const) : []),
		workerReportSufficesForAcceptance(claim) ? "READ_REPORT" : "READ_ALL",
	];
}

export const WORKER_DISPOSITION_ADVICE_NOTE = "The disposition is advice; you decide.";

/** The sentence that follows the disposition; `retire` still needs an idle worker and a clear mailbox. */
export function workerDispositionGuidance(
	advised: WorkerDispositionAdvice,
	hostVerdict: WorkerHostVerdict | undefined,
): string {
	switch (advised.disposition) {
		case "retire":
			return "retire it";
		case "idle":
			return "leave it idle; a delegate start with its agentId gives it the next task (a follow_up continues the same task)";
		case "needs_follow_up":
			return hostVerdict && hostVerdict.missing.length > 0
				? `follow_up with the missing proof (${verdictList(hostVerdict.missing)})`
				: "follow_up on the same agentId to resolve what is open";
	}
}

/** `Recommended disposition: idle - <reason>` */
export function describeWorkerDisposition(advised: WorkerDispositionAdvice): string {
	return `Recommended disposition: ${advised.disposition} - ${advised.reason}`;
}

/** The model-facing projection of a host verdict for a list or status view: bounded, no free text beyond `missing`. */
export interface WorkerHostVerdictView {
	readonly verdict: WorkerHostVerdict["verdict"];
	readonly covered: readonly string[];
	readonly missing: readonly string[];
}

export function workerHostVerdictView(hostVerdict: WorkerHostVerdict): WorkerHostVerdictView {
	return {
		verdict: hostVerdict.verdict,
		covered: hostVerdict.coveredRequirementIds.slice(0, MAX_VERDICT_LIST_ITEMS),
		missing: hostVerdict.missing
			.slice(0, MAX_VERDICT_LIST_ITEMS)
			.map((value) => boundedText(value, MAX_VERDICT_ITEM_CHARS)),
	};
}
