import type { WorkerClaim, WorkerHostVerdict } from "../autonomy/contracts.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";

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

function bounded(reason: string): string {
	const line = reason.replace(/[\r\n]+/g, " ");
	return line.length <= MAX_WORKER_DISPOSITION_REASON_CHARS
		? line
		: `${line.slice(0, MAX_WORKER_DISPOSITION_REASON_CHARS - 3)}...`;
}

function advice(disposition: WorkerDisposition, reason: string): WorkerDispositionAdvice {
	return { disposition, reason: bounded(reason) };
}

/**
 * Advice for the root on one ended worker task. In order: `needs_follow_up` when the host verdict,
 * the claim or the owner route leaves something unresolved; `idle` when more work for this profile
 * or an uncovered requirement remains, or when a fact is unknown; otherwise `retire`. The root
 * decides; this never acts.
 */
export function deriveWorkerDisposition(input: WorkerDispositionInput): WorkerDispositionAdvice {
	const claim = input.claim;
	if (!claim) return advice("idle", "No claim was recorded; inspect the transcript before deciding.");
	const verdict = claim.hostVerdict?.verdict;
	if (verdict === "needs_more") return advice("needs_follow_up", "Host verdict needs_more: named proof is missing.");
	if (verdict === "rejected")
		return advice("needs_follow_up", "Host verdict rejected: a stated claim is contradicted.");
	if (verdict === "blocked") return advice("needs_follow_up", "Host verdict blocked: the worker reported a blocker.");
	if (claim.blockers && claim.blockers.length > 0) {
		return advice("needs_follow_up", `The claim carries ${claim.blockers.length} blocker(s).`);
	}
	if (claim.inconclusive && claim.inconclusive.length > 0) {
		return advice("needs_follow_up", `The claim carries ${claim.inconclusive.length} inconclusive finding(s).`);
	}
	if (claim.parentReviewRequired === true && claim.parentReviewedAt === undefined) {
		return advice("needs_follow_up", "The claim awaits your review acknowledgement.");
	}
	if (claim.verification?.verdict === "rejected") {
		return advice("needs_follow_up", "Independent verification rejected the claim.");
	}
	if (claim.ownerFollowUp) return advice("needs_follow_up", "An owner follow-up was recorded for open findings.");
	if (claim.status === "partial" || claim.status === "blocked" || claim.status === "failed") {
		return advice("needs_follow_up", `The claim status is ${claim.status}.`);
	}
	if (claim.status === "cancelled") return advice("idle", "The task was cancelled; the worker keeps its transcript.");
	if (verdict === "unverified") {
		return advice("idle", "The host could not check this claim; verify it before retiring the worker.");
	}
	const open = input.openTasksForSameProfile;
	if (open !== undefined && open > 0) {
		return advice("idle", `${open} open task(s) would route to ${input.profileId ?? "this profile"}.`);
	}
	const uncovered = input.uncoveredRequirementIds;
	if (uncovered !== undefined && uncovered.length > 0) {
		return advice(
			"idle",
			`${uncovered.length} goal requirement(s) remain uncovered: ${uncovered.slice(0, 3).join(", ")}.`,
		);
	}
	if (open === undefined || uncovered === undefined) {
		return advice("idle", "Remaining work for this profile is unknown; keep it reusable until you decide.");
	}
	return advice("retire", "No open task or uncovered requirement remains for this profile.");
}

/**
 * Advice computed from the claim alone, for a delivery that is stored and replayed byte-for-byte
 * (a worker-to-worker handoff): live host facts and the root's later review acknowledgement would
 * change the text between a delivery and its replay. A clean claim reads `idle`; `retire` is the
 * root's call and needs the live facts.
 */
export function deriveClaimOnlyWorkerDisposition(claim: WorkerDispositionClaim | undefined): WorkerDispositionAdvice {
	return deriveWorkerDisposition({ claim: claim ? { ...claim, parentReviewedAt: undefined } : undefined });
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

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
	const attempt = snapshot
		? args.attemptId !== undefined
			? snapshot.attempts[args.attemptId]
			: Object.values(snapshot.attempts)
					.filter((candidate) => candidate.taskId === laneId || candidate.dispatch.logicalLaneId === laneId)
					.at(-1)
		: undefined;
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

/** Advice for one claim given the host facts; requirements the host verdict already covers are not uncovered. */
export function deriveWorkerDispositionForClaim(args: {
	claim: WorkerDispositionClaim | undefined;
	facts: (WorkerDispositionFacts & { profileId?: string }) | undefined;
	profileId?: string;
}): WorkerDispositionAdvice {
	const { claim, facts } = args;
	const covered = new Set(claim?.hostVerdict?.coveredRequirementIds ?? []);
	const profileId = facts?.profileId ?? args.profileId;
	return deriveWorkerDisposition({
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

/** Derive advice for one claim from the host's projections; absent sources degrade to unknown facts. */
export function deriveWorkerDispositionFromProjections(args: {
	claim: WorkerDispositionClaim | undefined;
	snapshot: TaskRuntimeProjection | undefined;
	goal: Pick<GoalState, "requirements"> | undefined;
	laneId: string;
	attemptId?: string;
}): WorkerDispositionAdvice {
	return deriveWorkerDispositionForClaim({ claim: args.claim, facts: deriveWorkerDispositionFacts(args) });
}

const MAX_VERDICT_LIST_ITEMS = 8;
const MAX_VERDICT_ITEM_CHARS = 120;

function verdictList(values: readonly string[]): string {
	const shown = values
		.slice(0, MAX_VERDICT_LIST_ITEMS)
		.map((value) => value.replace(/[\r\n]+/g, " ").slice(0, MAX_VERDICT_ITEM_CHARS));
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
			return "leave it idle for the next task";
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
			.map((value) => value.slice(0, MAX_VERDICT_ITEM_CHARS)),
	};
}
