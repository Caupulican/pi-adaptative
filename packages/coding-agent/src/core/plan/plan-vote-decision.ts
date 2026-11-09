/**
 * The plan vote's ordered exits (S6): code decides from each candidate's rubric readings (`system-one/plan-vote-rubric.ts`)
 * and the record's facts. Pure: the executor gathers the readings and the Choice (V5), then asks this module which exit
 * fired and what that exit does. Nothing here asks System One.
 *
 * Exits, first match wins:
 * - too_many: more candidates than VOTE_CANDIDATE_LIMIT; read all.
 * - V1_divergent: two or more candidates, every one a writing step, whose changed files are pairwise disjoint: the vote
 *   compared different work, so nothing is chosen and the lead reads all (nothing is held). It reads only the record's
 *   facts, so it runs before V0 and spares the automatic checks a comparison that has no common ground.
 * - V0_unjudged: no readings (System One absent, failed or out of bound).
 * - V2_evidence_open: a candidate's evidence sufficiency reading is not a pass.
 * - V3 (a filter): a candidate with a failed criterion is not eligible.
 * - V6_none_eligible: no eligible candidate, or an eligible candidate has an open criterion.
 * - V4_winner: exactly one eligible candidate, every criterion met.
 * - V5_choose: two or more eligible candidates, every criterion met; System One's Choice names the winner among them.
 *
 * The exits that do not name a winner (V0, V2, V6, and V5 without a Choice winner) try an automatic verify of the two top
 * candidates, once per vote (`voteCheckNodes`), and read all when there is no room or fewer than two candidates. After both
 * checks settle, the vote re-decides from their verdicts (`verifiedVote`): one accepted names that candidate, otherwise read all.
 */

import type { NoulReading } from "../decision/noul.ts";
import type { Outcome } from "../delegation/worker-outcome-contract.ts";
import type { PlanNodeSpec, PlanRecord } from "./plan-graph.ts";
import { voteCheckNodes, voteCriteria } from "./plan-revision.ts";

/** Most candidates a vote judges; a vote with more reads all. */
export const VOTE_CANDIDATE_LIMIT = 8;

/** One criterion's reading: met (the Score mass at level 2 or above reaches the meet cut), failed, or open. */
export type RubricReading = "meets" | "fails" | "open";

/** One candidate's readings: its evidence sufficiency, and one reading per criterion in the vote's criterion order. */
export interface CandidateReading {
	readonly memberId: string;
	readonly sufficient: NoulReading;
	readonly criteria: readonly RubricReading[];
}

/** A candidate's code facts, read from the record and its outcome. */
export interface VoteCandidateFacts {
	readonly memberId: string;
	/** The step is a writing step: its write scope is not empty. */
	readonly writes: boolean;
	readonly changedFiles: readonly string[];
}

export interface VoteFacts {
	readonly criteria: readonly string[];
	readonly candidates: readonly VoteCandidateFacts[];
}

export type VoteExit =
	| { readonly kind: "too_many" }
	| { readonly kind: "V0_unjudged" }
	| { readonly kind: "V1_divergent" }
	| { readonly kind: "V2_evidence_open"; readonly members: readonly string[] }
	| { readonly kind: "V4_winner"; readonly memberId: string }
	| { readonly kind: "V5_choose"; readonly eligible: readonly string[] }
	| { readonly kind: "V6_none_eligible"; readonly gaps: readonly string[] };

/** The verdict of a vote whose two automatic checks settled: one accepted names its candidate, otherwise neither decides. */
export type VerifiedVote =
	| { readonly kind: "V7_verified"; readonly memberId: string }
	| { readonly kind: "V8_verify_unsettled" };

/** What the executor does next: name the winner, hold the step for re-planning, add the automatic checks, or read all. */
export type VoteStep =
	| { readonly kind: "winner"; readonly memberId: string; readonly exit: string }
	| { readonly kind: "hold"; readonly detail: string }
	| { readonly kind: "auto_verify"; readonly top: readonly [string, string]; readonly exit: string }
	| { readonly kind: "read_all"; readonly exit: string; readonly gaps: readonly string[] };

export interface VoteStepInput {
	readonly record: PlanRecord;
	readonly vote: PlanNodeSpec;
	readonly facts: VoteFacts;
	readonly readings: readonly CandidateReading[] | undefined;
	readonly exit: VoteExit;
	/** V5's Choice: the winner System One named among the eligible candidates, or undefined when it named none. */
	readonly choice?: string | undefined;
}

/** A vote's facts: its criteria, and each candidate's writing step and the files it changed. */
export function voteFacts(
	record: PlanRecord,
	vote: PlanNodeSpec,
	candidates: readonly { readonly nodeId: string; readonly outcome: Outcome }[],
): VoteFacts {
	return {
		criteria: voteCriteria(vote),
		candidates: candidates.map((candidate) => {
			const node = record.nodes.find((entry) => entry.id === candidate.nodeId);
			if (!node) throw new Error(`plan ${record.planId} has no step ${candidate.nodeId}`);
			return {
				memberId: candidate.nodeId,
				writes: node.writeScope.length > 0,
				changedFiles: candidate.outcome.changedFiles,
			};
		}),
	};
}

/** The first exit that fires for a vote, in the order the module header states. */
export function decideVote(facts: VoteFacts, readings: readonly CandidateReading[] | undefined): VoteExit {
	if (facts.candidates.length > VOTE_CANDIDATE_LIMIT) return { kind: "too_many" };
	// V1 reads only the record's facts, so it precedes V0: divergent candidates have no common ground whether or not System One ran.
	if (divergent(facts.candidates)) return { kind: "V1_divergent" };
	if (readings === undefined) return { kind: "V0_unjudged" };
	const insufficient = readings
		.filter((reading) => reading.sufficient !== "hard_pass")
		.map((reading) => reading.memberId);
	if (insufficient.length > 0) return { kind: "V2_evidence_open", members: insufficient };
	const eligible = readings.filter((reading) => !reading.criteria.includes("fails"));
	if (eligible.length === 0 || eligible.some((reading) => reading.criteria.includes("open")))
		return { kind: "V6_none_eligible", gaps: gapsOf(facts.criteria, readings) };
	const only = eligible.length === 1 ? eligible[0] : undefined;
	if (only) return { kind: "V4_winner", memberId: only.memberId };
	return { kind: "V5_choose", eligible: eligible.map((reading) => reading.memberId) };
}

/** The step an exit takes. The automatic check is offered only when the record has room for it; otherwise the vote reads all. */
export function voteStep(input: VoteStepInput): VoteStep {
	const { exit } = input;
	switch (exit.kind) {
		case "too_many":
			return readAll(exit.kind, []);
		case "V1_divergent":
			return readAll(exit.kind, []);
		case "V4_winner":
			return { kind: "winner", memberId: exit.memberId, exit: exit.kind };
		case "V5_choose":
			return input.choice !== undefined && exit.eligible.includes(input.choice)
				? { kind: "winner", memberId: input.choice, exit: exit.kind }
				: checkOrReadAll(input, exit.kind, []);
		case "V6_none_eligible":
			return checkOrReadAll(input, exit.kind, exit.gaps);
		case "V0_unjudged":
		case "V2_evidence_open":
			return checkOrReadAll(input, exit.kind, []);
	}
}

/** The verdict of a vote whose checks settled: exactly one accepted check names its candidate; both or neither reads all. */
export function verifiedVote(
	checks: readonly { readonly memberId: string; readonly accepted: boolean }[],
): VerifiedVote {
	const accepted = checks.filter((check) => check.accepted);
	const only = accepted.length === 1 ? accepted[0] : undefined;
	return only ? { kind: "V7_verified", memberId: only.memberId } : { kind: "V8_verify_unsettled" };
}

function readAll(exit: string, gaps: readonly string[]): VoteStep {
	return { kind: "read_all", exit, gaps };
}

function checkOrReadAll(input: VoteStepInput, exit: string, gaps: readonly string[]): VoteStep {
	const top = topTwo(input);
	if (top === undefined) return readAll(exit, gaps);
	return voteCheckNodes(input.record, input.vote.id, top, input.record.version + 1) === undefined
		? readAll("V9_no_room", gaps)
		: { kind: "auto_verify", top, exit };
}

/** The two candidates with the most met criteria, ties in record order; undefined with fewer than two candidates. */
function topTwo(input: VoteStepInput): readonly [string, string] | undefined {
	const { record, facts, readings } = input;
	if (facts.candidates.length < 2) return undefined;
	const met = (memberId: string) =>
		readings?.find((reading) => reading.memberId === memberId)?.criteria.filter((value) => value === "meets")
			.length ?? 0;
	const position = (memberId: string) => record.nodes.findIndex((node) => node.id === memberId);
	const ranked = [...facts.candidates].sort(
		(a, b) => met(b.memberId) - met(a.memberId) || position(a.memberId) - position(b.memberId),
	);
	const [first, second] = ranked;
	return first && second ? [first.memberId, second.memberId] : undefined;
}

/** Two or more writing candidates whose changed files share no path: they did different work. */
function divergent(candidates: readonly VoteCandidateFacts[]): boolean {
	if (
		candidates.length < 2 ||
		candidates.some((candidate) => !candidate.writes || candidate.changedFiles.length === 0)
	)
		return false;
	const owner = new Map<string, string>();
	for (const candidate of candidates)
		for (const file of candidate.changedFiles) {
			const prior = owner.get(file);
			if (prior !== undefined && prior !== candidate.memberId) return false;
			owner.set(file, candidate.memberId);
		}
	return true;
}

/** One line per criterion a candidate did not meet: unmet when it failed, open when it could not be read. */
function gapsOf(criteria: readonly string[], readings: readonly CandidateReading[]): string[] {
	return readings.flatMap((reading) =>
		reading.criteria.flatMap((value, index) =>
			value === "meets"
				? []
				: [
						`${reading.memberId}: ${criteria[index] ?? `criterion ${index + 1}`} ${value === "fails" ? "unmet" : "open"}`,
					],
		),
	);
}
