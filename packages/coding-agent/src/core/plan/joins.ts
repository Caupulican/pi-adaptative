/**
 * Joins: how a plan combines the outcomes of the nodes in `join.members` into one result (design PG 6.2, reconciled
 * section 2.4). Every decision here is code over member outcomes, never worker prose:
 *
 * - collect: `aggregateOutcomes(members, quorum ? {quorum} : "all")`; settles when the quorum succeeded or every
 *   member settled.
 * - race: settles on the first succeeded member (`any`); the other members still running are cancelled.
 * - vote: every member settled; no eligible (succeeded) candidate settles the vote as partial. Otherwise the executor judges
 *   the candidates on the vote's rubric and acts on the exit it reads (`plan-vote-decision.ts`). A vote whose automatic
 *   checks settled is decided by their verdicts here, in code.
 * - reduce and verify: run a worker task over the members (the reducer answers `criterion`, the verifier reviews the
 *   results the members ran). A reduce join's outcome is the reducer's alone; a verify join settles through its verifier
 *   alone (`verifyJoinResult`): the members only ever lift an accepted review, never a failed one.
 * - merge: every member settled, then the executor lands the members' lanes in order (`plan-merge.ts`); the landed join
 *   settles with `mergeResult`, collect semantics over the settled members.
 *
 * The full result is written by the executor as a bounded artifact (`plan/<planId>/<nodeId>-j<n>.json`); this module only
 * computes it. Every join names the files two or more members changed; a reduce join also names the findings its review
 * read as conflicting (`plan-result-gates.ts`).
 */

import { aggregateOutcomes } from "../delegation/worker-outcome.ts";
import { BLOCKER_ATTRIBUTION, type Outcome, type OutcomeStatus } from "../delegation/worker-outcome-contract.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { highestStakesLevel, type ProofStakesLevel } from "../proof/stakes-levels.ts";
import type { ConflictReading } from "../system-one/plan-result-review.ts";
import { boundedLine } from "../util/bounded-line.ts";
import type { FindingPair } from "./plan-evidence.ts";
import type { PlanNodeKind, PlanNodeSpec, PlanRecord, PlanRuntimeState } from "./plan-graph.ts";
import { voteChecksOf } from "./plan-revision.ts";
import { planNodeOutcome } from "./plan-view.ts";
import { verifiedVote } from "./plan-vote-decision.ts";

export const JOIN_RESULT_MAX_BYTES = 256 * 1024;
/** The most file conflicts one join names, in record order. */
const MAX_FILE_CONFLICTS = 16;
/** How much of each finding a conflict's detail quotes. */
const CONFLICT_SUMMARY_CHARS = 80;

export interface JoinMember {
	readonly nodeId: string;
	readonly status: OutcomeStatus;
	readonly outcomeId: string;
}

export interface JoinResult {
	readonly v: 1;
	readonly kind: PlanNodeKind;
	readonly outcome: Outcome;
	readonly members: readonly JoinMember[];
	readonly coverage: Readonly<Record<string, boolean>>;
	readonly winner?: string;
	readonly conflicts: readonly {
		readonly kind: "finding" | "file";
		readonly between: readonly string[];
		readonly detail: string;
	}[];
	readonly changedFiles: readonly string[];
	readonly gaps: readonly string[];
	readonly artifact: string;
	/** The highest stakes the members recorded at their settlement, and a reduce or verify step's own worker result. */
	readonly stakes?: ProofStakesLevel;
}

export interface JoinIdentity {
	readonly outcomeId: string;
	readonly generation: number;
	readonly recordedAt: string;
	readonly artifact: string;
}

export type JoinDecision =
	| { readonly kind: "wait" }
	| { readonly kind: "settle"; readonly result: JoinResult; readonly cancel: readonly string[] }
	/** merge with every member settled: the executor lands the members' lanes, then settles with `mergeResult`. */
	| { readonly kind: "merge" }
	/** vote with eligible candidates and no automatic check yet: the executor judges them on the rubric (S6). */
	| {
			readonly kind: "rubric";
			readonly candidates: readonly { readonly nodeId: string; readonly outcome: Outcome }[];
	  };

type JoinProjection = Pick<TaskRuntimeProjection, "plans" | "tasks" | "attempts">;

/** `plan/<planId>/<nodeId>-j<n>.json`: where settlement `n` of a join is stored, relative to the session bundle. */
export function joinArtifactPath(planId: string, nodeId: string, n: number): string {
	return `plan/${planId}/${nodeId}-j${n}.json`;
}

/** The join outcome id: unique per plan, node and settlement sequence. */
export function joinOutcomeId(planId: string, nodeId: string, n: number): string {
	return `outcome-${planId}-${nodeId}-j${n}`;
}

/** A settled member: its outcome and the stakes it recorded when it settled (a join records its own). */
interface SettledMember {
	readonly nodeId: string;
	readonly outcome: Outcome;
	readonly stakes?: ProofStakesLevel;
}

function memberOutcomes(
	projection: JoinProjection,
	plan: PlanRuntimeState,
	node: PlanNodeSpec,
): { settled: SettledMember[]; pending: string[] } {
	const settled: SettledMember[] = [];
	const pending: string[] = [];
	for (const member of node.join?.members ?? []) {
		const runtime = plan.nodes[member];
		const outcome = runtime?.held ? undefined : planNodeOutcome(projection, plan, member);
		if (outcome) settled.push({ nodeId: member, outcome, stakes: runtime?.settled?.stakes ?? runtime?.join?.stakes });
		else pending.push(member);
	}
	return { settled, pending };
}

function coverageRecord(outcome: Outcome): Record<string, boolean> {
	return Object.fromEntries([
		...outcome.coverage.covered.map((entry) => [entry.id, true] as const),
		...outcome.coverage.uncovered.map((entry) => [entry.id, false] as const),
	]);
}

export type JoinConflict = JoinResult["conflicts"][number];

/** The files two or more members changed, each with the members that changed it, in record order. */
function fileConflicts(members: readonly SettledMember[]): JoinConflict[] {
	const changers = new Map<string, string[]>();
	for (const member of members)
		for (const file of new Set(member.outcome.changedFiles))
			changers.set(file, [...(changers.get(file) ?? []), member.nodeId]);
	return [...changers]
		.filter(([, nodes]) => nodes.length >= 2)
		.slice(0, MAX_FILE_CONFLICTS)
		.map(([path, nodes]) => ({ kind: "file", between: nodes, detail: path }));
}

/** The finding pairs the review read as conflicting; an open or agreeing pair names no conflict. */
export function findingConflicts(
	pairs: readonly FindingPair[],
	readings: ReadonlyMap<string, ConflictReading>,
): JoinConflict[] {
	return pairs
		.filter((pair) => readings.get(pair.key) === "conflict")
		.map((pair) => ({
			kind: "finding",
			between: [pair.a, pair.b],
			detail: `${pair.cite}: ${boundedLine(pair.summaryA, CONFLICT_SUMMARY_CHARS)} / ${boundedLine(pair.summaryB, CONFLICT_SUMMARY_CHARS)}`,
		}));
}

function buildResult(
	node: PlanNodeSpec,
	members: readonly SettledMember[],
	outcome: Outcome,
	identity: JoinIdentity,
	winner?: string,
	ownStakes?: ProofStakesLevel,
	findingNames: readonly JoinConflict[] = [],
): JoinResult {
	const stakes = highestStakesLevel([...members.map((member) => member.stakes), ownStakes]);
	const gaps = [
		...members
			.filter((member) => member.outcome.status !== "succeeded")
			.map((member) => `step ${member.nodeId} ended ${member.outcome.status}`),
		...outcome.coverage.uncovered.map((entry) => `requirement ${entry.id} not met (${entry.reason})`),
	];
	const changedFiles = [...new Set(members.flatMap((member) => member.outcome.changedFiles))];
	return {
		v: 1,
		kind: node.kind,
		outcome: { ...outcome, artifacts: [...outcome.artifacts, { kind: "join_result", ref: identity.artifact }] },
		members: members.map((member) => ({
			nodeId: member.nodeId,
			status: member.outcome.status,
			outcomeId: member.outcome.outcomeId,
		})),
		coverage: coverageRecord(outcome),
		...(winner ? { winner } : {}),
		conflicts: [...fileConflicts(members), ...findingNames],
		changedFiles,
		gaps,
		artifact: identity.artifact,
		...(stakes !== undefined ? { stakes } : {}),
	};
}

function aggregate(
	record: PlanRecord,
	node: PlanNodeSpec,
	children: readonly Outcome[],
	policy: "all" | "any" | { quorum: number },
	identity: JoinIdentity,
): Outcome {
	return aggregateOutcomes(children, policy, "join", {
		outcomeId: identity.outcomeId,
		nodeId: node.id,
		objectiveId: record.objectiveId,
		generation: identity.generation,
		recordedAt: identity.recordedAt,
	});
}

/** The decision of a join the harness settles in code (collect, race, vote). */
export function decideCodeJoin(
	projection: JoinProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	identity: JoinIdentity,
): JoinDecision {
	const { settled, pending } = memberOutcomes(projection, plan, node);
	const succeeded = settled.filter((member) => member.outcome.status === "succeeded");
	const settle = (
		policy: "all" | "any" | { quorum: number },
		members = settled,
		winner?: string,
		cancel: string[] = [],
	) => {
		const outcome = aggregate(
			record,
			node,
			members.map((member) => member.outcome),
			policy,
			identity,
		);
		return { kind: "settle" as const, result: buildResult(node, members, outcome, identity, winner), cancel };
	};
	switch (node.kind) {
		case "collect": {
			const quorum = node.join?.quorum;
			if (quorum !== undefined && succeeded.length >= quorum) return settle({ quorum }, settled, undefined, pending);
			return pending.length === 0 ? settle(quorum !== undefined ? { quorum } : "all") : { kind: "wait" };
		}
		case "race": {
			const first = succeeded[0];
			if (first) return settle("any", [first], first.nodeId, [...pending]);
			return pending.length === 0 ? settle("any") : { kind: "wait" };
		}
		case "merge":
			return pending.length === 0 ? { kind: "merge" } : { kind: "wait" };
		case "vote": {
			if (pending.length > 0) return { kind: "wait" };
			if (succeeded.length === 0) return settle("all");
			const checks = voteChecksOf(record, node);
			if (checks.length > 0) {
				// The checks gate this join in the reconcile, so a settled vote has settled checks; a missing one waits.
				if (checks.some((check) => plan.nodes[check.id]?.join === undefined)) return { kind: "wait" };
				const verdict = verifiedVote(
					checks.map((check) => ({
						memberId: check.memberId,
						accepted: planNodeOutcome(projection, plan, check.id)?.status === "succeeded",
					})),
				);
				const winner = verdict.kind === "V7_verified" ? verdict.memberId : undefined;
				return { kind: "settle", result: settleVote(projection, plan, record, node, identity, winner), cancel: [] };
			}
			return { kind: "rubric", candidates: succeeded };
		}
		default:
			return { kind: "wait" };
	}
}

/**
 * Settles a vote with its winner: a winner settles on that candidate; without one (`undefined`) the join settles on every
 * eligible candidate as partial, so the root reads them all (READ_ALL).
 */
export function settleVote(
	projection: JoinProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	identity: JoinIdentity,
	winner: string | undefined,
): JoinResult {
	const { settled } = memberOutcomes(projection, plan, node);
	const chosen = winner ? settled.find((member) => member.nodeId === winner) : undefined;
	if (chosen)
		return buildResult(
			node,
			[chosen],
			aggregate(record, node, [chosen.outcome], "any", identity),
			identity,
			chosen.nodeId,
		);
	const eligible = settled.filter((member) => member.outcome.status === "succeeded");
	const outcome = aggregate(
		record,
		node,
		eligible.map((member) => member.outcome),
		"all",
		identity,
	);
	return buildResult(node, eligible, { ...outcome, status: "partial" }, identity);
}

/**
 * A merge join's result once its members' lanes landed (or none needed to): collect semantics over the settled members, so a
 * member that did not succeed reads as a gap and its lane stays where it is.
 */
export function mergeResult(
	projection: JoinProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	identity: JoinIdentity,
): JoinResult {
	const { settled } = memberOutcomes(projection, plan, node);
	return buildResult(
		node,
		settled,
		aggregate(
			record,
			node,
			settled.map((member) => member.outcome),
			"all",
			identity,
		),
		identity,
	);
}

/**
 * The result of a reduce or verify join once its worker task's outcome settled. `findings` is a reduce step's review of its
 * members' findings; a verify join has none.
 */
export function workerJoinResult(
	projection: JoinProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	worker: Outcome,
	identity: JoinIdentity,
	workerStakes?: ProofStakesLevel,
	findings?: { readonly pairs: readonly FindingPair[]; readonly readings: ReadonlyMap<string, ConflictReading> },
): JoinResult {
	const { settled } = memberOutcomes(projection, plan, node);
	if (node.kind === "verify")
		return verifyJoinResult(
			record,
			node,
			settled,
			worker,
			identity,
			findings ? findingConflicts(findings.pairs, findings.readings) : [],
			workerStakes,
		);
	// The reducer's answer is the join's; the verifier's verdict gates every subject.
	const children = node.kind === "reduce" ? [worker] : [...settled.map((member) => member.outcome), worker];
	return buildResult(
		node,
		settled,
		aggregate(record, node, children, "all", identity),
		identity,
		undefined,
		workerStakes,
		findings ? findingConflicts(findings.pairs, findings.readings) : [],
	);
}

/**
 * A verify join settles through its verifier (R6). A verifier that did not succeed fails the step with its blocker and next action,
 * whatever its members did. An independently verified verifier counts each member whose only shortfall is an unverified result as
 * verified, the way an accepted verification settles a subject: succeeded, every required requirement covered by the verification.
 */
function verifyJoinResult(
	record: PlanRecord,
	node: PlanNodeSpec,
	settled: readonly SettledMember[],
	worker: Outcome,
	identity: JoinIdentity,
	conflicts: readonly JoinConflict[],
	workerStakes?: ProofStakesLevel,
): JoinResult {
	// Only an accepted review (independently verified) settles the step. A review that finished with no verdict leaves it unverified.
	if (worker.status !== "succeeded" || worker.assurance !== "independently_verified") {
		const aggregated = aggregate(record, node, [...settled.map((member) => member.outcome), worker], "all", identity);
		const unverified = worker.status === "succeeded";
		const blocker = unverified ? "unverified_result" : worker.blocker;
		const failed: Outcome = {
			...aggregated,
			status: "failed",
			blocker,
			attribution: BLOCKER_ATTRIBUTION[blocker],
			nextAction: unverified
				? { kind: "ask_root", question: "The verifier finished without a verdict; the step is not verified." }
				: worker.nextAction,
		};
		return buildResult(node, settled, failed, identity, undefined, workerStakes, conflicts);
	}
	const counted = settled.map((member) =>
		member.outcome.status !== "succeeded" && member.outcome.blocker === "unverified_result"
			? { ...member, outcome: verifiedOutcome(member.outcome) }
			: member,
	);
	const children = [...counted.map((member) => member.outcome), worker];
	return buildResult(
		node,
		counted,
		aggregate(record, node, children, "all", identity),
		identity,
		undefined,
		workerStakes,
		conflicts,
	);
}

/** A member's outcome once an accepted independent verification covers its requirements (the verification is its evidence). */
function verifiedOutcome(outcome: Outcome): Outcome {
	const required = outcome.coverage.required;
	return {
		...outcome,
		status: "succeeded",
		blocker: "none",
		attribution: "none",
		assurance: "independently_verified",
		coverage: { required, covered: required.map((id) => ({ id, by: "verification" as const })), uncovered: [] },
		nextAction: { kind: "accept" },
	};
}

/** Whether a join's result lets the root read the report alone: accepted, every cited requirement met, nothing open. */
export function joinReadsAsReport(result: JoinResult): boolean {
	return (
		result.outcome.status === "succeeded" && Object.values(result.coverage).every(Boolean) && result.gaps.length === 0
	);
}
