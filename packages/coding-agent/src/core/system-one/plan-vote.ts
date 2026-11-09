/**
 * The vote join's one judgment (design PG 6.5): when two or more candidates of a vote were accepted, System One
 * answers one Choice, "which candidate's result best meets the criterion", over the eligible candidates' outcome
 * lines. Code decides: a `consequential` reading (P >= 0.90 with a 0.15 lead over the runner-up) names the winner;
 * anything else, an outage included, names none, and the join settles on every eligible candidate for the root to
 * read in full. The question is unmeasured: it ships without a measured question set.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { choiceAct } from "../decision/thresholds.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { withinPlanRequestBound } from "./plan-request-bound.ts";
import { noteDecisionTrace } from "./semantic-evaluation-ledger.ts";

const VOTE_LEAD = 0.15;

export interface PlanVoteCandidate {
	readonly nodeId: string;
	/** Code-built outcome line and digest pointer; worker words stay in the digest file. */
	readonly summary: string;
}

/**
 * The winning node id, or undefined when System One is absent, expired, fails or is not decisive. A failure is logged at
 * warn with its error class and a bounded, redacted message; the caller reads undefined as no winner. The Choice is offered
 * over the `eligible` candidates only (the vote's exit V5 names the ones that met every criterion); fewer than two offers
 * no Choice.
 */
export async function chooseVoteWinner(
	engine: OperationEffectEngine | undefined,
	input: {
		readonly criterion: string;
		readonly candidates: readonly PlanVoteCandidate[];
		readonly eligible: readonly string[];
		readonly signal?: AbortSignal;
	},
): Promise<string | undefined> {
	const offered = input.candidates.filter((candidate) => input.eligible.includes(candidate.nodeId));
	if (!engine || offered.length < 2) return undefined;
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
					offered.map((candidate) => [candidate.nodeId, { description: candidate.summary }]),
				),
			},
		],
	};
	let evaluation: OperationEvaluation | undefined;
	try {
		evaluation = await withinPlanRequestBound(
			(signal) =>
				engine.evaluate(
					program,
					{ criterion: input.criterion, candidates: offered.map((candidate) => candidate.summary) },
					{ consequence: "medium", signal },
				),
			{ caller: input.signal },
		);
	} catch (error) {
		input.signal?.throwIfAborted();
		// A failed judgment is not an expired one: it is reported, and the vote reads every eligible candidate all the same.
		harnessLog.warn("plan", "system one could not judge a plan vote; the vote reads every candidate", () => ({
			error: error instanceof Error ? error.name : typeof error,
			message: boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)),
		}));
		return undefined;
	}
	// An expired request is unjudged: no winner, and the join settles on every eligible candidate.
	if (!evaluation) return undefined;
	const answer = evaluation.answers?.best_candidate;
	const reading = choiceAct(answer, undefined, "consequential", { minMargin: VOTE_LEAD });
	const selected =
		answer && typeof answer === "object" && "choice" in answer && typeof answer.choice === "string"
			? answer.choice
			: undefined;
	const winner =
		reading === "act" && offered.some((candidate) => candidate.nodeId === selected) ? selected : undefined;
	noteDecisionTrace(engine, evaluation, {
		decision: winner ? `plan vote: ${winner} wins` : "plan vote: no decisive winner",
		drove: ["best_candidate"],
		exit: winner ? "winner" : "open",
		read: () => undefined,
	});
	return winner;
}
