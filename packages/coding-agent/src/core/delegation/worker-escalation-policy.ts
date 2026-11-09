import { createHash } from "node:crypto";
import { type PairedVerdict, readPairedJudgment } from "../decision/paired-judgment.ts";
import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import type {
	AbandonReason,
	BlockerCode,
	NextAction,
	OutcomeScope,
	OutcomeStatus,
	RequirementCoverage,
} from "./worker-outcome-contract.ts";

/**
 * The escalation ladder: the only producer of an outcome's `nextAction`. An ordered decision table over code facts
 * (E0-E18 of the worker-outcome design, with the merged additions E3b, E3c, E5b, E7b, E9b, E10b); the first matching
 * exit wins and every evaluated exit is traced. System One answers enter only as probabilities of one atomic question
 * and its evidence-sufficiency pair (Q1, Q1s), combined here at 0.90 / 0.10; an absent or unsettled pair is `open` and
 * the table continues. Split is not a next action: work too large for one worker asks the owner at E18.
 */

/** A judgment pair: the question's probability and its evidence-sufficiency probability. */
export interface JudgmentPair {
	readonly probability: number;
	readonly sufficiency: number;
}

export interface EscalationRecordFact {
	readonly rung: number;
	readonly signature: string;
}

export interface LadderCandidate {
	readonly modelRef: string;
	readonly thinking?: string;
}

export interface LadderFacts {
	readonly scope: OutcomeScope;
	readonly nodeId: string;
	readonly status: OutcomeStatus;
	readonly blocker: BlockerCode;
	readonly coverage: RequirementCoverage;
	/** The lane could change files: an unknown action outcome is never rerun automatically. */
	readonly writeCapable: boolean;
	/** `provider/modelId` of the attempt the outcome describes. */
	readonly modelRef: string;
	readonly thinking: OrchestrationThinkingLevel | undefined;
	/** The highest thinking level the model supports; undefined when unknown (the admission clamps the request). */
	readonly thinkingCeiling: OrchestrationThinkingLevel | undefined;
	/** The owner pinned the model, the caller named it, or a profile or reused contract bound it: never moved. */
	readonly modelBound: boolean;
	/** The ranked candidate order the attempt was admitted with (subscription-first, owner-named providers only). */
	readonly candidates: readonly LadderCandidate[];
	/** Models this task's outcome chain already ran on. */
	readonly triedModelRefs: readonly string[];
	/** Escalations already scheduled for this task's outcome chain. */
	readonly escalations: readonly EscalationRecordFact[];
	readonly settings: { readonly enabled: boolean; readonly maxRungs: number };
	/** A follow-up is installed that places rungs and runs host checks; without one no automatic step is offered. */
	readonly executor: boolean;
	/** When a transient failure's existing retry is scheduled. */
	readonly retryNotBefore?: string;
	/** Uncovered ids with a host requirement check that has not run since the attempt ended. */
	readonly hostCheckable: readonly string[];
	/** Remaining task budget: cost, active time and, for a non-completed task, its attempt ceiling. */
	readonly budgetLeft: boolean;
	/** A plan step released to a linked machine: that machine's id. Its re-placement is the plan's (`replace`). */
	readonly remoteMachineId?: string;
	/** A rerun the original authority could not be rebuilt into: the owner decides, the ladder does not retry it. */
	readonly rungRefusal?: string;
	/** A review run whose verdict rejected the result: the reason codes it named, bounded. Set only for such a run. */
	readonly reviewRejection?: string;
	/** Q1/Q1s for a worker-stated blocker: only the owner can supply what is missing. */
	readonly ownerOnly?: JudgmentPair;
}

export interface LadderDecision {
	readonly nextAction: NextAction;
	readonly exit: string;
	/** The rung the next action places (1 or 2), else the highest rung already used. */
	readonly rung: number;
	readonly trace: readonly string[];
}

const FIX_REQUEST_REMEDIES: Partial<Record<BlockerCode, string>> = {
	scope_denied: "widen the worker's path or tool grant, or narrow the task to the granted scope",
	request_rejected: "correct the request fields the refusal names and start again",
	preflight_failed: "fix the check that failed before the worker started",
	missing_input: "supply the input the worker reported missing",
	dependency_wrong: "correct the dependency the worker reported wrong",
};

const ABANDON_BY_BLOCKER: Partial<Record<BlockerCode, AbandonReason>> = {
	dependency_failed: "dependency",
	superseded: "superseded",
};

const MOVE_MODEL_BLOCKERS: ReadonlySet<BlockerCode> = new Set(["provider_quota", "provider_auth", "model_unavailable"]);

/** The E10b question: the task's cost or attempt budget is spent, so no further try may start. */
const BUDGET_SPENT_QUESTION = "another try would pass the task's budget; raise it or accept";

/** The E18 question for a time stop the ladder could not answer: the wall-clock cap is the owner's setting to raise. */
const TIME_STOP_QUESTION =
	"the task ran out of time before its requirements were met (cap: workerDelegation.maxWallClockMs); raise the cap or narrow the task";

/** The settled reading of a judgment pair; `open` covers every combination the two cuts do not settle. */
export function judgmentPairVerdict(pair: JudgmentPair | undefined): PairedVerdict {
	return pair ? readPairedJudgment(pair.probability, pair.sufficiency).verdict : "open";
}

/** The no-repeat key of one placement: node, sorted remaining ids, model and thinking. */
export function escalationSignature(
	nodeId: string,
	requirementIds: readonly string[],
	modelRef: string,
	thinking: string,
): string {
	const material = JSON.stringify([nodeId, [...requirementIds].sort(), modelRef, thinking]);
	return `sig-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

/** One thinking step above `level`, bounded by the model's ceiling; undefined when the ceiling is reached. */
export function nextThinkingLevel(
	level: OrchestrationThinkingLevel | undefined,
	ceiling: OrchestrationThinkingLevel | undefined,
): OrchestrationThinkingLevel | undefined {
	const current = ORCHESTRATION_THINKING_LEVELS.indexOf(level ?? "off");
	const top = ceiling ? ORCHESTRATION_THINKING_LEVELS.indexOf(ceiling) : ORCHESTRATION_THINKING_LEVELS.length - 1;
	return current < top ? ORCHESTRATION_THINKING_LEVELS[current + 1] : undefined;
}

function askSignature(nodeId: string, blocker: BlockerCode): string {
	return `ask-${createHash("sha256").update(`${nodeId}\u0000${blocker}`).digest("hex").slice(0, 24)}`;
}

function remainingCount(coverage: RequirementCoverage): string {
	const count = coverage.uncovered.length;
	return count > 0 ? `${count} requirement${count === 1 ? "" : "s"}` : "the task";
}

/** Run the ordered table over the facts; the first matching exit wins. */
export function decideNextAction(facts: LadderFacts): LadderDecision {
	const trace: string[] = [];
	const usedRung = facts.escalations.reduce((highest, entry) => Math.max(highest, entry.rung), 0);
	const done = (exit: string, nextAction: NextAction, rung = usedRung): LadderDecision => {
		trace.push(exit);
		return { nextAction, exit, rung, trace };
	};
	const skip = (exit: string, why: string): void => {
		trace.push(`${exit}:${why}`);
	};
	const askOwner = (exit: string, question: string): LadderDecision =>
		done(exit, { kind: "ask_owner", question, signature: askSignature(facts.nodeId, facts.blocker) });
	const { blocker, coverage } = facts;

	if (facts.status === "succeeded") return done("E0", { kind: "accept" });
	if (facts.status === "cancelled")
		return done("E1", { kind: "abandon", reason: ABANDON_BY_BLOCKER[blocker] ?? "cancelled" });
	const remedy = FIX_REQUEST_REMEDIES[blocker];
	// A rejected review names the step to change; the ladder never reruns a verifier because it rejected.
	if (facts.reviewRejection !== undefined)
		return done("E2r", {
			kind: "fix_request",
			remedy: `independent verification rejected the result (${facts.reviewRejection}); change the step it checked, then it is verified again`,
		});
	if (remedy) return done("E2", { kind: "fix_request", remedy });
	if (blocker === "owner_authority_required" || blocker === "needs_owner_decision")
		return askOwner("E3", "the worker needs an authority or a decision only you can give");
	if (blocker === "needs_root_answer") {
		return facts.scope === "leader"
			? done("E3b", { kind: "ask_root", question: "the worker needs an answer from the lead agent" })
			: askOwner("E3b", "the worker needs an answer only you can give");
	}
	if (blocker === "deadline_reached") {
		return facts.scope === "leader"
			? done("E3c", { kind: "abandon", reason: "superseded" })
			: askOwner("E3c", "the task reached its deadline before its requirements were met; extend it or accept it");
	}
	if (blocker === "action_outcome_unknown" && facts.writeCapable)
		return askOwner("E4", "whether a write took effect is unknown; check the changed files before anything reruns");
	if (blocker === "provider_transient") {
		if (facts.retryNotBefore) return done("E5", { kind: "retry_after", notBefore: facts.retryNotBefore });
		skip("E5", "retries_spent");
	}
	// A model move would propose the same refused rerun again: a refusal records no escalation, so the move's exit asks the
	// owner first. Every other blocker keeps the owner-ask exit E14r below.
	if (facts.rungRefusal !== undefined && (blocker === "provider_transient" || MOVE_MODEL_BLOCKERS.has(blocker)))
		return askOwner("E14r", refusedRungQuestion(facts.rungRefusal));
	if (blocker === "provider_transient" || MOVE_MODEL_BLOCKERS.has(blocker)) {
		// A spent budget or attempt ceiling is the real cause of a refused move, whatever the model's state: it is asked first.
		if (rungRoom(facts) === "budget") return askOwner("E10b", BUDGET_SPENT_QUESTION);
		const exit = blocker === "provider_transient" ? "E5b" : "E6";
		if (facts.modelBound)
			return askOwner(exit, "the bound model cannot run now; restore its access or choose another");
		const move = nextModelRung(facts, skip, exit);
		if (move) return done(exit, move, 2);
		return askOwner(exit, "no other allowed model can take the task; restore the model's access or name another");
	}
	// Only an action an executor performs is named. An interrupted attempt is suspended and the restart recovery resumes it
	// (wait_capacity). A plan step released to a linked machine that could not take it or could not be reached is re-placed
	// by the plan on this machine (replace); any other refused start is not re-placed by an executor, and goes to the owner.
	if (blocker === "interrupted") return done("E7", { kind: "wait_capacity", reason: "runtime_generation" });
	if (
		(blocker === "capacity_unavailable" || blocker === "placement_unreachable") &&
		facts.remoteMachineId !== undefined
	)
		return done(blocker === "capacity_unavailable" ? "E7" : "E7b", {
			kind: "replace",
			excludePlacement: `machine:${facts.remoteMachineId}`,
		});
	if (blocker === "capacity_unavailable")
		return askOwner(
			"E7",
			"the work was refused for capacity and no automatic retry places it; start it again when room is free",
		);
	if (blocker === "placement_unreachable")
		return askOwner("E7b", "the placement could not be reached and no other placement can take the work");
	if (blocker === "dependency_failed") return done("E8", { kind: "abandon", reason: "dependency" });
	if (blocker === "verification_pending") return done("E9", { kind: "verify_in_lane" });
	// No executor places an independent verifier from the ladder yet, so the unverified result goes to the owner.
	if (blocker === "unverified_result")
		return askOwner(
			"E9b",
			"the result is unverified and no independent verifier is placed automatically; verify it or accept it",
		);
	if (blocker === "budget_exhausted")
		return askOwner("E10", "the task's budget is spent; raise it or accept the partial result");
	if (coverage.uncovered.some((entry) => entry.reason === "inconclusive")) skip("E11", "inconclusive_uncovered");
	if (facts.hostCheckable.length > 0) return done("E12", { kind: "host_check", requirementIds: facts.hostCheckable });
	if (blocker === "worker_reported_blocker") {
		const verdict = judgmentPairVerdict(facts.ownerOnly);
		if (verdict === "yes") return askOwner("E13", "the worker needs information or a decision only you hold");
		skip("E13", verdict);
	}
	// A refused rerun is never retried by the ladder: the owner is asked what to do with the refused rung.
	if (facts.rungRefusal !== undefined) return askOwner("E14r", refusedRungQuestion(facts.rungRefusal));
	const remaining = coverage.uncovered.map((entry) => entry.id);
	const workRemains = remaining.length > 0 || coverage.required.length === 0;
	if (workRemains) {
		const room = rungRoom(facts);
		if (room !== undefined) {
			skip("E14", room);
			if (room === "budget") return askOwner("E10b", BUDGET_SPENT_QUESTION);
		} else {
			// A time stop is never answered with more thinking: its rerun keeps the attempt's level (the fallback the model
			// move uses), and it is placed only when the stopped attempt covered something, so the rest is a narrower task.
			const timeStop = blocker === "time_exhausted";
			const thinking = timeStop
				? (facts.thinking ?? "off")
				: nextThinkingLevel(facts.thinking, facts.thinkingCeiling);
			const rung1Used = facts.escalations.some((entry) => entry.rung === 1);
			const signature = thinking ? escalationSignature(facts.nodeId, remaining, facts.modelRef, thinking) : "";
			if (timeStop && coverage.covered.length === 0) skip("E14", "time_stop_no_progress");
			else if (rung1Used) skip("E14", "rung1_used");
			else if (!thinking) skip("E14", "thinking_ceiling");
			else if (facts.escalations.some((entry) => entry.signature === signature)) skip("E14", "signature_placed");
			else
				return done(
					"E14",
					{ kind: "rerun_uncovered", requirementIds: remaining, rung: 1, modelRef: facts.modelRef, thinking },
					1,
				);
			if (facts.modelBound) skip("E15", "model_bound");
			else {
				const move = nextModelRung(facts, skip, "E15");
				if (move) return done("E15", move, 2);
			}
		}
	}
	// Open work after a time stop is the cap's to raise or the task's to narrow. A stop that covered every requirement is not.
	if (blocker === "time_exhausted" && workRemains) return askOwner("E18", TIME_STOP_QUESTION);
	return askOwner("E18", `${remainingCount(coverage)} still not met (${blocker}); decide how to continue`);
}

/** The owner's question for a refused rung: the plain reason the next try could not be started. */
function refusedRungQuestion(reason: string): string {
	return `the next try could not be started because ${reason}; decide how to continue`;
}

/** Why no rung may be placed now; undefined when one may. */
function rungRoom(facts: LadderFacts): "no_executor" | "disabled" | "max_rungs" | "budget" | undefined {
	if (!facts.executor) return "no_executor";
	if (!facts.settings.enabled) return "disabled";
	if (facts.escalations.length >= facts.settings.maxRungs) return "max_rungs";
	if (!facts.budgetLeft) return "budget";
	return undefined;
}

/** Rung 2: the next ranked candidate the chain has not run on and whose placement was never made. */
function nextModelRung(
	facts: LadderFacts,
	skip: (exit: string, why: string) => void,
	exit: string,
): Extract<NextAction, { kind: "rerun_uncovered" }> | undefined {
	const room = rungRoom(facts);
	if (room !== undefined) {
		skip(exit, room);
		return undefined;
	}
	const remaining = facts.coverage.uncovered.map((entry) => entry.id);
	const tried = new Set([facts.modelRef, ...facts.triedModelRefs]);
	for (const candidate of facts.candidates) {
		if (tried.has(candidate.modelRef)) continue;
		const thinking = candidate.thinking ?? facts.thinking ?? "off";
		const signature = escalationSignature(facts.nodeId, remaining, candidate.modelRef, thinking);
		if (facts.escalations.some((entry) => entry.signature === signature)) continue;
		return { kind: "rerun_uncovered", requirementIds: remaining, rung: 2, modelRef: candidate.modelRef, thinking };
	}
	skip(exit, "no_candidate");
	return undefined;
}
