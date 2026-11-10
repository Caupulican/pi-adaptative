/**
 * System One judges a plan vote's candidates on the vote's criteria (S6, D11). Program `S1-PLAN-VOTE-RUBRIC`: one request
 * per candidate, all in flight together, carrying one Score per criterion (levels 0-3) and one Noul for whether the
 * candidate's evidence is enough to judge it on every criterion. A criterion is met when the Score mass at level 2 or above
 * reaches RUBRIC_MEET_MASS, failed when that mass is at most RUBRIC_FAIL_MASS, and open between or unanswered. Evidence
 * sufficiency is read on the `orchestration` family (accept at 0.90, require absence at 0.10).
 *
 * A request that does not answer within its bound is unanswered: its criteria read open and its sufficiency unasked. A
 * System One failure never throws; an abort of the caller's signal propagates. The exits that act on the readings are code
 * (`plan/plan-vote-decision.ts`), and each answered request's trace records the exit it fed (`noteVoteTrace`).
 */

import type { WorkerReportChange } from "../autonomy/contracts.ts";
import { readNoul } from "../decision/noul.ts";
import { RUBRIC_FAIL_MASS, RUBRIC_MEET_MASS, scoreBoundaryMass } from "../decision/thresholds.ts";
import { OUTCOME_LIMITS, type Outcome } from "../delegation/worker-outcome-contract.ts";
import { describeOutcomeForHandoff } from "../delegation/worker-outcome-words.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import { type PacketReport, type ResultPacket, resultPacket } from "../plan/plan-evidence.ts";
import type { PlanNodeSpec, PlanRecord, PlanRuntimeState } from "../plan/plan-graph.ts";
import { voteCriteria } from "../plan/plan-revision.ts";
import {
	type CandidateReading,
	decideVote,
	type RubricReading,
	VOTE_CANDIDATE_LIMIT,
	type VoteExit,
	type VoteStep,
	voteFacts,
	voteStep,
} from "../plan/plan-vote-decision.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { boundedLine } from "../util/bounded-line.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { withinPlanRequestBound } from "./plan-request-bound.ts";
import { chooseVoteWinner } from "./plan-vote.ts";
import { noteDecisionTrace, type SemanticTraceReading } from "./semantic-evaluation-ledger.ts";

const SUFFICIENT_ID = "candidate_evidence_sufficient";
const MAX_CHANGES = 8;
const LINE_CHARS = OUTCOME_LIMITS.maxStringChars;
/** A vote's Choice names each candidate by its outcome line, bounded. */
const VOTE_SUMMARY_CHARS = 600;

const RUBRIC_LEVELS = [
	{ value: 0, description: "does not meet it" },
	{ value: 1, description: "partly, with a gap that matters" },
	{ value: 2, description: "meets it" },
	{ value: 3, description: "meets it with evidence (a passing check or a cited place)" },
] as const;

function criterionId(index: number): string {
	return `criterion_${index}`;
}

/** The rubric's program for one vote's criteria: a Score per criterion and the sufficiency Noul. */
export function rubricProgram(criteria: readonly string[]) {
	return {
		schema_version: "2.0" as const,
		program_id: "S1-PLAN-VOTE-RUBRIC",
		description:
			"How well a settled plan step's result meets each criterion of its vote, and whether its evidence is enough to judge it on all of them.",
		decisions: [
			...criteria.map((criterion, index) => ({
				kind: "score" as const,
				id: criterionId(index),
				instruction: `How well does \`candidate\` meet: ${criterion}?`,
				levels: RUBRIC_LEVELS,
			})),
			{
				kind: "boolean" as const,
				id: SUFFICIENT_ID,
				instruction:
					"Does `candidate`'s evidence (changes, checks, excerpt) show enough to judge it on every criterion?",
			},
		],
	};
}

/** One candidate's evidence: its result packet and the changes its claim report states. */
export interface VoteCandidateEvidence {
	readonly memberId: string;
	readonly packet: ResultPacket;
	readonly changes: readonly WorkerReportChange[];
}

/**
 * A candidate's evidence as the rubric reads it: its result packet, and the changes its claim report states (of the attempt
 * the step settled on).
 */
export function voteEvidence(
	snapshot: TaskRuntimeProjection,
	plan: PlanRuntimeState,
	candidate: { readonly nodeId: string; readonly outcome: Outcome },
	reportOf: PacketReport,
): VoteCandidateEvidence {
	const release = plan.nodes[candidate.nodeId]?.release;
	const taskId = release ? currentTaskOf(snapshot, release.taskId) : undefined;
	const report = taskId === undefined ? undefined : reportOf(taskId, candidate.outcome.attempts.at(-1)?.attemptId);
	return {
		memberId: candidate.nodeId,
		packet: resultPacket(candidate.nodeId, candidate.outcome, report),
		changes: report?.changes ?? [],
	};
}

/** One candidate's reading, with the answered request it came from (undefined when the request was unanswered). */
export interface RubricJudgment {
	readonly reading: CandidateReading;
	readonly evaluation?: OperationEvaluation;
}

/** The reading of one criterion from its Score answer: met or failed at the rubric's cuts, open between or unanswered. */
function criterionReading(answer: unknown): RubricReading {
	const mass = scoreBoundaryMass(answer, (level) => level >= 2);
	if (mass === undefined) return "open";
	if (mass >= RUBRIC_MEET_MASS) return "meets";
	return mass <= RUBRIC_FAIL_MASS ? "fails" : "open";
}

/** The candidate's evidence as the rubric reads it: plain worker words are fenced here, once, for each question. */
function candidateState(evidence: VoteCandidateEvidence): Record<string, unknown> {
	const fence = (text: string) => wrapUntrustedText(text, `plan-vote:${evidence.memberId}`);
	const { packet } = evidence;
	return {
		candidate: {
			status: packet.status,
			changed_files: packet.changedFiles,
			changes: evidence.changes
				.slice(0, MAX_CHANGES)
				.map((change) => ({ file: change.file, what: fence(boundedLine(change.what, LINE_CHARS)) })),
			uncovered: packet.uncovered,
			open_items: packet.remaining.map(fence),
			findings: packet.findings.map((finding) => ({ summary: fence(finding.summary), cites: finding.cites })),
			checks: packet.receipts.map((receipt) => ({ command: receipt.command, exit_code: receipt.exitCode })),
			excerpt: packet.excerpt === "" ? "" : fence(packet.excerpt),
		},
	};
}

/**
 * Judges each candidate on each criterion (one request per candidate, all in flight together). Returns undefined when no
 * request was answered, or when there are no candidates or more than VOTE_CANDIDATE_LIMIT of them (the vote then reads all).
 */
export async function judgeCandidates(
	engine: OperationEffectEngine | undefined,
	criteria: readonly string[],
	candidates: readonly VoteCandidateEvidence[],
	options: { readonly signal?: AbortSignal } = {},
): Promise<readonly RubricJudgment[] | undefined> {
	options.signal?.throwIfAborted();
	if (!engine || candidates.length === 0 || candidates.length > VOTE_CANDIDATE_LIMIT) return undefined;
	const program = rubricProgram(criteria);
	const settled = await Promise.allSettled(
		candidates.map((candidate) =>
			withinPlanRequestBound(
				(signal) => engine.evaluate(program, candidateState(candidate), { consequence: "medium", signal }),
				{ caller: options.signal },
			),
		),
	);
	options.signal?.throwIfAborted();
	const judgments = candidates.map((candidate, index): RubricJudgment => {
		const outcome = settled[index];
		const evaluation = outcome?.status === "fulfilled" ? outcome.value : undefined;
		return {
			reading: {
				memberId: candidate.memberId,
				sufficient: readNoul(evaluation?.answers?.[SUFFICIENT_ID], "required_true", "orchestration"),
				criteria: criteria.map((_, position) => criterionReading(evaluation?.answers?.[criterionId(position)])),
			},
			...(evaluation ? { evaluation } : {}),
		};
	});
	return judgments.some((judgment) => judgment.evaluation !== undefined) ? judgments : undefined;
}

/** A vote's whole judgment: the readings, the exit the code read from them, and the step that exit takes. */
export interface VoteJudgement {
	readonly judgments: readonly RubricJudgment[] | undefined;
	readonly exit: VoteExit;
	readonly step: VoteStep;
}

/**
 * The vote's judgment in order (S6): one rubric judgment per candidate, the exit the code reads, V5's Choice when that exit asks
 * for one, the trace of each answered request, and the step the exit takes. Every request is bounded; a failure reads as unasked.
 */
export async function judgeVoteStep(
	engine: OperationEffectEngine | undefined,
	input: {
		readonly snapshot: TaskRuntimeProjection;
		readonly plan: PlanRuntimeState;
		readonly record: PlanRecord;
		readonly vote: PlanNodeSpec;
		readonly candidates: readonly { readonly nodeId: string; readonly outcome: Outcome }[];
		readonly reportOf: PacketReport;
		readonly signal: AbortSignal;
	},
): Promise<VoteJudgement> {
	const judgments = await judgeCandidates(
		engine,
		voteCriteria(input.vote),
		input.candidates.map((candidate) => voteEvidence(input.snapshot, input.plan, candidate, input.reportOf)),
		{ signal: input.signal },
	);
	const facts = voteFacts(input.record, input.vote, input.candidates);
	const readings = judgments?.map((judgment) => judgment.reading);
	const exit = decideVote(facts, readings);
	const choice =
		exit.kind === "V5_choose"
			? await chooseVoteWinner(engine, {
					criterion: input.vote.join?.criterion ?? input.vote.intent,
					candidates: input.candidates.map((candidate) => ({
						nodeId: candidate.nodeId,
						summary:
							`${describeOutcomeForHandoff(candidate.outcome)}${candidate.outcome.digestRef ? ` Report: ${candidate.outcome.digestRef}` : ""}`.slice(
								0,
								VOTE_SUMMARY_CHARS,
							),
					})),
					eligible: exit.eligible,
					signal: input.signal,
				})
			: undefined;
	noteVoteTrace(engine, judgments, exit.kind);
	const step = voteStep({ record: input.record, vote: input.vote, facts, readings, exit, choice });
	return { judgments, exit, step };
}

const RUBRIC_READS = (judgmentId: string): SemanticTraceReading | undefined =>
	judgmentId === SUFFICIENT_ID ? { family: "orchestration", direction: "required_true" } : undefined;

/** Records, for each answered request, the exit the vote took from its readings. */
export function noteVoteTrace(
	engine: OperationEffectEngine | undefined,
	judgments: readonly RubricJudgment[] | undefined,
	exit: string,
): void {
	for (const judgment of judgments ?? []) {
		if (!engine || !judgment.evaluation) continue;
		noteDecisionTrace(engine, judgment.evaluation, {
			decision: `plan vote: candidate ${judgment.reading.memberId}: ${exit}`,
			drove: [SUFFICIENT_ID, ...judgment.reading.criteria.map((_, index) => criterionId(index))],
			exit,
			read: RUBRIC_READS,
		});
	}
}
