/**
 * The authority line: where a System One doubt or a System One outage may stop work.
 *
 * Every consumer of a semantic judgment declares what the judgment decides. Reversible work never
 * waits on, or is refused by, a doubt or an outage: it proceeds and the doubt stays visible. An
 * objective transition (complete, deliver) never closes on a doubt and holds on an outage. An
 * irreversible or outward operation asks the operator (root) or is refused (worker).
 *
 * This is the one table; the steering plane and the decision graph read it, nothing re-derives it.
 */

export type AuthorityKind = "reversible_work" | "objective_transition" | "irreversible";

/** What the judgment settled, already reduced from its band or confidence. */
export type JudgmentReading = "pass" | "doubt" | "ambiguous" | "fail" | "unavailable";

export type AuthorityAction =
	| "proceed"
	| "proceed_with_doubt"
	| "gather_more"
	| "owner_question"
	| "replan"
	| "hold"
	| "ask_operator"
	| "refuse";

export interface AuthorityDecision {
	readonly action: AuthorityAction;
	/** Present when the work goes on, or waits, with something unsettled that the operator must see. */
	readonly doubt?: string;
}

/** Evidence gathering an ambiguous judgment may cost before it stops blocking reversible work. */
export const GATHER_MORE_LIMIT = 2;

/** Checkpoints that close or deliver an objective. Everything else steers reversible work. */
const OBJECTIVE_TRANSITION_CHECKPOINTS: ReadonlySet<string> = new Set([
	"JEV-024",
	"JEV-025",
	"JEV-026",
	"JEV-027",
	"JEV-028",
]);

/** Checkpoints that authorize an operation which may not be undone or which leaves the machine. */
const IRREVERSIBLE_CHECKPOINTS: ReadonlySet<string> = new Set(["external_capability_acquisition"]);

export function authorityForCheckpoint(checkpointId: string): AuthorityKind {
	if (OBJECTIVE_TRANSITION_CHECKPOINTS.has(checkpointId)) return "objective_transition";
	if (IRREVERSIBLE_CHECKPOINTS.has(checkpointId)) return "irreversible";
	return "reversible_work";
}

export function decideByAuthority(
	kind: AuthorityKind,
	reading: JudgmentReading,
	gatherCount: number,
	actor: "root" | "worker" = "root",
): AuthorityDecision {
	if (reading === "pass") return { action: "proceed" };
	const exhausted = gatherCount >= GATHER_MORE_LIMIT;
	switch (kind) {
		case "reversible_work":
			if (reading === "doubt") return { action: "proceed_with_doubt", doubt: "provisional judgment" };
			if (reading === "ambiguous")
				return exhausted
					? { action: "proceed_with_doubt", doubt: `still unsettled after ${gatherCount} evidence passes` }
					: { action: "gather_more" };
			if (reading === "fail") return { action: "replan" };
			return { action: "proceed_with_doubt", doubt: "System One unavailable: this step was not judged" };
		case "objective_transition":
			if (reading === "doubt") return { action: "hold", doubt: "provisional judgment cannot close the objective" };
			if (reading === "ambiguous")
				return exhausted
					? { action: "owner_question", doubt: `still unsettled after ${gatherCount} evidence passes` }
					: { action: "gather_more" };
			if (reading === "fail") return { action: "replan" };
			return { action: "hold", doubt: "System One unavailable: the objective stays open until it is judged" };
		case "irreversible":
			if (reading === "fail") return { action: "refuse" };
			if (actor === "worker") return { action: "refuse", doubt: "a worker cannot ask the operator" };
			return {
				action: "ask_operator",
				doubt: reading === "unavailable" ? "System One unavailable: the operator decides" : "unsettled judgment",
			};
	}
}

/** A Choice or Score answer at or above this confidence decides. */
export const DECIDING_CONFIDENCE = 0.9;
/** Between this and {@link DECIDING_CONFIDENCE} the answer asks a narrower follow-up first. */
export const FOLLOW_UP_CONFIDENCE = 0.8;

/**
 * What a Choice or Score confidence allows: `decide` at 0.90 and above; `ask_more` from 0.80, where
 * a narrower follow-up question settles it or, for reversible work, the answer may stand with its
 * doubt visible; `undecided` below 0.80, where the answer decides nothing.
 */
export function confidenceGate(confidence: unknown): "decide" | "ask_more" | "undecided" {
	if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "undecided";
	if (confidence >= DECIDING_CONFIDENCE) return "decide";
	return confidence >= FOLLOW_UP_CONFIDENCE ? "ask_more" : "undecided";
}
