/**
 * System One reads a settled plan step's result for the steps that depend on it (S5, R3). Program `S1-PLAN-RESULTS` asks
 * four atomic yes/no questions, each read on the `orchestration` family (accept at 0.90, require absence at 0.10; a
 * reading between the cuts, or no answer, is open or unasked). Code decides by ordered exits:
 *
 * - `changes_dependent_work` and `result_evidence_sufficient`, asked per dependent step in one request:
 *   R3a (both accepted) holds the dependent for re-planning, with the first open item as its reason;
 *   R3b (changes refused, evidence accepted) releases it; R3d (either unasked) releases it unjudged; R3c (anything else)
 *   releases it, and the open items still travel to it as a code fact.
 * - `findings_contradict` and `finding_evidence_sufficient`, asked per finding pair in one request: both accepted is a
 *   conflict; the contradiction refused with the evidence accepted is no conflict; anything else is open.
 *
 * Each request sees only its own state, so a request is one dependent or one pair. A request that does not answer within
 * its bound is unasked; a System One failure never throws (the exits read it as unasked). An abort of the caller's signal
 * propagates. Every answered request records its exit in the ledger (`noteDecisionTrace`).
 */

import { type NoulDirection, type NoulReading, readNoul } from "../decision/noul.ts";
import type { FindingPair, ResultPacket } from "../plan/plan-evidence.ts";
import type { PlanNodeSpec } from "../plan/plan-graph.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { boundedLine } from "../util/bounded-line.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { withinPlanRequestBound } from "./plan-request-bound.ts";
import { noteDecisionTrace } from "./semantic-evaluation-ledger.ts";

export const PLAN_RESULTS_PROGRAM = {
	schema_version: "2.0",
	program_id: "S1-PLAN-RESULTS",
	description:
		"Whether a settled plan step's result changes what a dependent step must do, and whether two findings about one place contradict.",
	decisions: [
		{
			id: "changes_dependent_work",
			instruction: "Does `result` change what `dependent` must do, beyond what its own text says?",
			criteria: {
				true: "The result reports something (an open item, a changed interface, a finding) that makes `dependent`'s stated task wrong, incomplete or unnecessary.",
				false: "`dependent` can be done as written with this result.",
			},
		},
		{
			id: "result_evidence_sufficient",
			instruction:
				"Does `result` state enough (changes, open items, findings) to tell whether `dependent` must change?",
			criteria: {
				true: "The result names what it changed and what it left open.",
				false: "The result's changes or open items are unstated.",
			},
		},
		{
			id: "findings_contradict",
			instruction: "Do finding `a` and finding `b` claim incompatible things about the same place?",
			criteria: {
				true: "Both cannot hold at once.",
				false: "They agree, or describe different things.",
			},
		},
		{
			id: "finding_evidence_sufficient",
			instruction: "Do `a` and `b` say enough about the cited place to tell whether they contradict?",
			criteria: {
				true: "Each states its claim about the cited place.",
				false: "One of the claims is vague about the place.",
			},
		},
	],
} as const;

type PlanResultsQuestionId = (typeof PLAN_RESULTS_PROGRAM.decisions)[number]["id"];

/** Every question needs an accepted answer for its yes, so each is read `required_true`. */
const DIRECTION: Readonly<Record<PlanResultsQuestionId, NoulDirection>> = {
	changes_dependent_work: "required_true",
	result_evidence_sufficient: "required_true",
	findings_contradict: "required_true",
	finding_evidence_sufficient: "required_true",
};

/** The dependent's exit: a hold, or a release that says why (R3b clean, R3c open, R3d unasked). */
export type DependentExit = "R3a_replan" | "R3b_release" | "R3c_open_release" | "R3d_unasked_release";

export interface DependentReview {
	readonly exit: DependentExit;
	/** R3a: the reason the step is held. R3d: why no answer was read. */
	readonly detail?: string;
	/** The two readings the exit read, for the evaluation's per-question agreement. */
	readonly questions: {
		readonly changes_dependent_work: NoulReading;
		readonly result_evidence_sufficient: NoulReading;
	};
}

export type ConflictReading = "conflict" | "no_conflict" | "open";

export interface PairReview {
	readonly reading: ConflictReading;
	readonly questions: {
		readonly findings_contradict: NoulReading;
		readonly finding_evidence_sufficient: NoulReading;
	};
}

export interface PlanResultsReviewOptions {
	readonly signal?: AbortSignal;
	/** Facts recorded in each answered request's trace (the cap that released dependents without review). */
	readonly facts?: readonly string[];
}

/** Bounds of the open-item text a hold names (the spec's S5 detail). */
const HOLD_ITEM_CHARS = 160;

/** The exit a dependent's two readings reach; the order is the spec's: a hold first, then unasked, then the rest. */
export function dependentExit(changes: NoulReading, sufficient: NoulReading): DependentExit {
	if (changes === "hard_pass" && sufficient === "hard_pass") return "R3a_replan";
	if (changes === "hard_fail" && sufficient === "hard_pass") return "R3b_release";
	if (changes === "unasked" || sufficient === "unasked") return "R3d_unasked_release";
	return "R3c_open_release";
}

/** The reading a finding pair reaches from its two readings. */
export function pairReading(contradict: NoulReading, sufficient: NoulReading): ConflictReading {
	if (contradict === "hard_pass" && sufficient === "hard_pass") return "conflict";
	if (contradict === "hard_fail" && sufficient === "hard_pass") return "no_conflict";
	return "open";
}

/** The release a dependent takes when System One gave no answer for it. */
export function unaskedDependentReview(detail: string): DependentReview {
	return {
		exit: "R3d_unasked_release",
		detail,
		questions: { changes_dependent_work: "unasked", result_evidence_sufficient: "unasked" },
	};
}

/** The reading of a finding pair System One gave no answer for: open. */
export function unaskedPairReview(): PairReview {
	return {
		reading: "open",
		questions: { findings_contradict: "unasked", finding_evidence_sufficient: "unasked" },
	};
}

/** The hold's reason: the first open item the result names, or its first finding. */
function holdDetail(packet: ResultPacket): string {
	const first = [
		...packet.uncovered.map((id) => `requirement ${id} is not met`),
		...packet.remaining,
		...packet.findings.map((finding) => finding.summary),
	][0];
	const item = first === undefined ? "the result it depends on" : boundedLine(first, HOLD_ITEM_CHARS);
	return `step ${packet.nodeId}'s result changes what this step must do: ${item}`;
}

/**
 * The result as the questions read it: its changes and open items as plain data, its worker words fenced as untrusted.
 * The packet's text is plain; fencing happens here, once, for every question that reads it.
 */
function resultState(packet: ResultPacket): Record<string, unknown> {
	const fence = (text: string) => wrapUntrustedText(text, `plan-result:${packet.nodeId}`);
	return {
		status: packet.status,
		changed_files: packet.changedFiles,
		uncovered: packet.uncovered,
		open_items: packet.remaining.map(fence),
		findings: packet.findings.map((finding) => ({ summary: fence(finding.summary), cites: finding.cites })),
		excerpt: packet.excerpt === "" ? "" : fence(packet.excerpt),
	};
}

function ask(
	engine: OperationEffectEngine,
	decisions: readonly (typeof PLAN_RESULTS_PROGRAM.decisions)[number][],
	state: Record<string, unknown>,
	signal: AbortSignal,
): Promise<OperationEvaluation> {
	return engine.evaluate({ ...PLAN_RESULTS_PROGRAM, decisions }, state, { consequence: "medium", signal });
}

function readOf(evaluation: OperationEvaluation | undefined, id: PlanResultsQuestionId): NoulReading {
	return readNoul(evaluation?.answers?.[id], DIRECTION[id], "orchestration");
}

function traceRead(id: string) {
	return id in DIRECTION
		? { family: "orchestration" as const, direction: DIRECTION[id as PlanResultsQuestionId] }
		: undefined;
}

function failureText(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Reviews one settled step's result against each dependent (one request per dependent, all in flight together). Returns
 * a review per dependent, keyed by its id. Never throws on System One: an absent engine, a failed request or an expired
 * one reads as unasked.
 */
export async function reviewDependents(
	engine: OperationEffectEngine | undefined,
	packet: ResultPacket,
	dependents: readonly PlanNodeSpec[],
	options: PlanResultsReviewOptions = {},
): Promise<ReadonlyMap<string, DependentReview>> {
	options.signal?.throwIfAborted();
	if (!engine)
		return new Map(
			dependents.map((dependent) => [
				dependent.id,
				unaskedDependentReview("System One is not configured for this session"),
			]),
		);
	const decisions = PLAN_RESULTS_PROGRAM.decisions.filter(
		(decision) => decision.id === "changes_dependent_work" || decision.id === "result_evidence_sufficient",
	);
	const settled = await Promise.allSettled(
		dependents.map((dependent) =>
			withinPlanRequestBound(
				(signal) =>
					ask(
						engine,
						decisions,
						{ result: resultState(packet), dependent: { id: dependent.id, does: dependent.intent } },
						signal,
					),
				{ caller: options.signal },
			),
		),
	);
	options.signal?.throwIfAborted();
	const reviews = new Map<string, DependentReview>();
	dependents.forEach((dependent, index) => {
		const outcome = settled[index];
		if (outcome?.status === "rejected") {
			reviews.set(dependent.id, unaskedDependentReview(failureText(outcome.reason)));
			return;
		}
		// An expired request has no evaluation: both readings are unasked and the exit releases the dependent.
		const evaluation = outcome?.status === "fulfilled" ? outcome.value : undefined;
		const questions = {
			changes_dependent_work: readOf(evaluation, "changes_dependent_work"),
			result_evidence_sufficient: readOf(evaluation, "result_evidence_sufficient"),
		};
		const exit = dependentExit(questions.changes_dependent_work, questions.result_evidence_sufficient);
		if (evaluation)
			noteDecisionTrace(engine, evaluation, {
				decision: `plan results: step ${packet.nodeId} to step ${dependent.id}: ${exit}`,
				drove: decisions.map((decision) => decision.id),
				exit,
				read: traceRead,
				...(options.facts?.length ? { facts: options.facts } : {}),
			});
		reviews.set(dependent.id, {
			exit,
			questions,
			...(exit === "R3a_replan" ? { detail: holdDetail(packet) } : {}),
			...(exit === "R3d_unasked_release" ? { detail: "System One gave no answer in time" } : {}),
		});
	});
	return reviews;
}

/**
 * Reviews each finding pair (one request per pair, all in flight together). Returns the reading per pair key. Never throws
 * on System One: a failed or expired request reads as open.
 */
export async function reviewFindingPairs(
	engine: OperationEffectEngine | undefined,
	pairs: readonly FindingPair[],
	options: PlanResultsReviewOptions = {},
): Promise<ReadonlyMap<string, PairReview>> {
	options.signal?.throwIfAborted();
	if (!engine) return new Map(pairs.map((pair) => [pair.key, unaskedPairReview()]));
	const decisions = PLAN_RESULTS_PROGRAM.decisions.filter(
		(decision) => decision.id === "findings_contradict" || decision.id === "finding_evidence_sufficient",
	);
	const settled = await Promise.allSettled(
		pairs.map((pair) => {
			const fence = (text: string) => wrapUntrustedText(text, `plan-finding:${pair.a}`);
			const state = {
				a: { summary: fence(pair.summaryA), step: pair.a },
				b: { summary: fence(pair.summaryB), step: pair.b },
				cite: pair.cite,
			};
			return withinPlanRequestBound((signal) => ask(engine, decisions, state, signal), { caller: options.signal });
		}),
	);
	options.signal?.throwIfAborted();
	const reviews = new Map<string, PairReview>();
	pairs.forEach((pair, index) => {
		const outcome = settled[index];
		if (outcome?.status === "rejected") {
			reviews.set(pair.key, unaskedPairReview());
			return;
		}
		const evaluation = outcome?.status === "fulfilled" ? outcome.value : undefined;
		const questions = {
			findings_contradict: readOf(evaluation, "findings_contradict"),
			finding_evidence_sufficient: readOf(evaluation, "finding_evidence_sufficient"),
		};
		const reading = pairReading(questions.findings_contradict, questions.finding_evidence_sufficient);
		if (evaluation)
			noteDecisionTrace(engine, evaluation, {
				decision: `plan results: findings of step ${pair.a} and step ${pair.b} at ${pair.cite}: ${reading}`,
				drove: decisions.map((decision) => decision.id),
				exit: reading,
				read: traceRead,
			});
		reviews.set(pair.key, { reading, questions });
	});
	return reviews;
}
