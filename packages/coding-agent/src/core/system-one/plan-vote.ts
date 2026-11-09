/**
 * The vote join's one judgment (design PG 6.5): when two or more candidates of a vote were accepted, System One
 * answers one Choice, "which candidate's result best meets the criterion", over the eligible candidates' outcome
 * lines. Code decides: a `consequential` reading (P >= 0.90 with a 0.15 lead over the runner-up) names the winner;
 * anything else, an outage included, names none, and the join settles on every eligible candidate for the root to
 * read in full. The question is unmeasured: it ships without a measured question set.
 */

import { choiceAct } from "../decision/thresholds.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { noteDecisionTrace } from "./semantic-evaluation-ledger.ts";

const VOTE_LEAD = 0.15;

export interface PlanVoteCandidate {
	readonly nodeId: string;
	/** Code-built outcome line and digest pointer; worker words stay in the digest file. */
	readonly summary: string;
}

/** The winning node id, or undefined when System One is absent, fails or is not decisive. */
export async function chooseVoteWinner(
	engine: OperationEffectEngine | undefined,
	input: {
		readonly criterion: string;
		readonly candidates: readonly PlanVoteCandidate[];
		readonly signal?: AbortSignal;
	},
): Promise<string | undefined> {
	if (!engine || input.candidates.length < 2) return undefined;
	const program = {
		schema_version: "2.0" as const,
		program_id: "JEV-PLAN-VOTE",
		description: "Which accepted candidate of a plan vote best meets the vote's criterion.",
		decisions: [
			{
				kind: "choice",
				id: "best_candidate",
				instruction:
					"Which item of `candidates` best meets `criterion`? Preserve uncertainty when they are equally good.",
				options: Object.fromEntries(
					input.candidates.map((candidate) => [candidate.nodeId, { description: candidate.summary }]),
				),
			},
		],
	};
	let evaluation: OperationEvaluation;
	try {
		evaluation = await engine.evaluate(
			program,
			{ criterion: input.criterion, candidates: input.candidates.map((candidate) => candidate.summary) },
			{ consequence: "medium", signal: input.signal },
		);
	} catch {
		input.signal?.throwIfAborted();
		return undefined;
	}
	const answer = evaluation.answers?.best_candidate;
	const reading = choiceAct(answer, undefined, "consequential", { minMargin: VOTE_LEAD });
	const selected =
		answer && typeof answer === "object" && "choice" in answer && typeof answer.choice === "string"
			? answer.choice
			: undefined;
	const winner =
		reading === "act" && input.candidates.some((candidate) => candidate.nodeId === selected) ? selected : undefined;
	noteDecisionTrace(engine, evaluation, {
		decision: winner ? `plan vote: ${winner} wins` : "plan vote: no decisive winner",
		drove: ["best_candidate"],
		exit: winner ? "winner" : "open",
		read: () => undefined,
	});
	return winner;
}
