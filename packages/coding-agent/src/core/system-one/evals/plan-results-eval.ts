/**
 * Plan result measurement (S5, R3): does System One's reading of a settled step's result agree with labelled results?
 *
 * Each labelled answer is one question of `S1-PLAN-RESULTS` (`plan-result-review.ts`): whether a result changes a dependent
 * step's work, whether the result states enough to say so, whether two findings about one place contradict, and whether
 * they say enough to tell. The review is the production `reviewDependents`/`reviewFindingPairs`, and finding pairs come
 * from the production `findingPairs`, so the readings measured are the ones a plan meets. A question ships when its
 * agreement reaches the accept cut (`PLAN_GRAPH_EVAL_THRESHOLDS`); a reading that is neither accepted nor refused, or no
 * reading at all, counts as a miss, because it settles nothing.
 */

import type { NoulReading } from "../../decision/noul.ts";
import { type FindingPair, findingPairs, type ResultPacket } from "../../plan/plan-evidence.ts";
import type { PlanNodeSpec } from "../../plan/plan-graph.ts";
import type { OperationEffectEngine } from "../operation-classifier.ts";
import { reviewDependents, reviewFindingPairs } from "../plan-result-review.ts";
import { PLAN_GRAPH_EVAL_THRESHOLDS } from "./plan-graph-eval.ts";
import {
	PLAN_RESULTS_EVAL_CASES,
	type PlanResultsEvalCase,
	type PlanResultsEvalLanguage,
} from "./plan-results-eval-cases.ts";

export const PLAN_RESULTS_QUESTIONS = [
	"changes_dependent_work",
	"result_evidence_sufficient",
	"findings_contradict",
	"finding_evidence_sufficient",
] as const;
export type PlanResultsQuestion = (typeof PLAN_RESULTS_QUESTIONS)[number];

/** One labelled answer and the reading the production review gave it. */
interface LabelledAnswer {
	readonly question: PlanResultsQuestion;
	readonly label: boolean;
	readonly reading: NoulReading;
}

export interface PlanResultsCaseScore {
	readonly id: string;
	readonly language: PlanResultsEvalLanguage;
	readonly answers: readonly LabelledAnswer[];
}

export interface PlanResultsEvalSummary {
	readonly cases: readonly PlanResultsCaseScore[];
	/** Agreement per question: the share of its labelled answers that match the label, misses counted. */
	readonly agreement: Readonly<Record<PlanResultsQuestion, number>>;
	/** Labelled answers whose reading settled neither way (open, soft or unasked). */
	readonly open: number;
}

/** A reading agrees with its label only when it reached the end the label names; an unsettled reading is a miss. */
function agrees(answer: LabelledAnswer): boolean {
	if (answer.reading === "hard_pass") return answer.label;
	if (answer.reading === "hard_fail") return !answer.label;
	return false;
}

function settles(answer: LabelledAnswer): boolean {
	return answer.reading === "hard_pass" || answer.reading === "hard_fail";
}

/** A step the labels describe: its id and text only (the review reads nothing else of it). */
function evalStep(id: string, intent: string): PlanNodeSpec {
	return {
		id,
		kind: "work",
		intent,
		inputs: [],
		after: [],
		writeScope: [],
		requirementIds: [],
		effort: "normal",
		since: 1,
	};
}

/** The packet of one step that reported one finding citing `cite`. */
function findingPacket(nodeId: string, summary: string, cite: string): ResultPacket {
	return {
		nodeId,
		status: "succeeded",
		changedFiles: [],
		uncovered: [],
		remaining: [],
		findings: [{ summary, cites: [cite] }],
		receipts: [],
		assurance: "host_check",
		excerpt: "",
	};
}

async function answersOf(engine: OperationEffectEngine, testCase: PlanResultsEvalCase): Promise<LabelledAnswer[]> {
	const answers: LabelledAnswer[] = [];
	if (testCase.labels) {
		if (!testCase.result || !testCase.dependent)
			throw new Error(`case ${testCase.id} labels a dependent it does not state`);
		const dependent = evalStep(testCase.dependent.id, testCase.dependent.intent);
		const review = (await reviewDependents(engine, testCase.result, [dependent])).get(dependent.id);
		answers.push(
			{
				question: "changes_dependent_work",
				label: testCase.labels.changes_dependent_work,
				reading: review?.questions.changes_dependent_work ?? "unasked",
			},
			{
				question: "result_evidence_sufficient",
				label: testCase.labels.result_evidence_sufficient,
				reading: review?.questions.result_evidence_sufficient ?? "unasked",
			},
		);
	}
	if (testCase.findings) {
		const { a, b, cite, labels } = testCase.findings;
		const pairs: readonly FindingPair[] = findingPairs([findingPacket("a", a, cite), findingPacket("b", b, cite)]);
		const pair = pairs[0];
		const review = pair ? (await reviewFindingPairs(engine, pairs)).get(pair.key) : undefined;
		answers.push(
			{
				question: "findings_contradict",
				label: labels.findings_contradict,
				reading: review?.questions.findings_contradict ?? "unasked",
			},
			{
				question: "finding_evidence_sufficient",
				label: labels.finding_evidence_sufficient,
				reading: review?.questions.finding_evidence_sufficient ?? "unasked",
			},
		);
	}
	return answers;
}

/** Runs the production review over every case, one case at a time, against the engine the caller passes. */
export async function measurePlanResults(
	engine: OperationEffectEngine,
	cases: readonly PlanResultsEvalCase[] = PLAN_RESULTS_EVAL_CASES,
): Promise<PlanResultsEvalSummary> {
	const scores: PlanResultsCaseScore[] = [];
	for (const testCase of cases)
		scores.push({ id: testCase.id, language: testCase.language, answers: await answersOf(engine, testCase) });
	const answers = scores.flatMap((score) => score.answers);
	const agreement = Object.fromEntries(
		PLAN_RESULTS_QUESTIONS.map((question) => {
			const asked = answers.filter((answer) => answer.question === question);
			const agreeing = asked.filter(agrees).length;
			return [question, asked.length === 0 ? 1 : agreeing / asked.length];
		}),
	) as Record<PlanResultsQuestion, number>;
	return { cases: scores, agreement, open: answers.filter((answer) => !settles(answer)).length };
}

/** Whether every question clears the accept cut: the results judgments ship only when all four do. */
export function planResultsEvalPasses(summary: PlanResultsEvalSummary): boolean {
	return PLAN_RESULTS_QUESTIONS.every(
		(question) => summary.agreement[question] >= PLAN_GRAPH_EVAL_THRESHOLDS.agreement,
	);
}

function percent(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}

export function formatPlanResultsEval(summary: PlanResultsEvalSummary): string {
	const lines = summary.cases.map((score) => {
		const misses = score.answers
			.filter((answer) => !agrees(answer))
			.map((answer) => `${answer.question} (${answer.reading})`);
		return `${score.id.padEnd(28)} ${misses.length === 0 ? "all agree" : `differs: ${misses.join(", ")}`}`;
	});
	lines.push("");
	for (const question of PLAN_RESULTS_QUESTIONS) {
		lines.push(
			`${question.padEnd(30)} agreement ${percent(summary.agreement[question])} (need ${percent(PLAN_GRAPH_EVAL_THRESHOLDS.agreement)})`,
		);
	}
	lines.push(`open readings across the result set: ${summary.open}`);
	return lines.join("\n");
}
