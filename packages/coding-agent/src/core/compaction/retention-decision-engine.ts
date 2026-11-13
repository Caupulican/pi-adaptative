/**
 * Bridges the session's own semantic decision engine into the batched-question shape its consumers speak.
 *
 * The consumers (retention, the operation gate, plan review, project rules, the plan executor) send one program of
 * questions and read one answer per question id. A question with no `kind`, or `kind: "boolean"`, is a noul question
 * (the probability of true, read against its direction): retention and plan questions are boolean by construction, and
 * their probability is passed through unchanged. A Choice, Score or Set question is passed to the engine as its consumer
 * defined it, and its answer carries the engine's selected option, value or distribution, so the consumer reads the
 * shape it asked for (a dropped kind would be asked as a yes/no and answered with a meaningless probability).
 *
 * Every consumer of this shape gets the evaluation's ledger id and its judgments back, and attaches the decision it made
 * from them through `noteTrace`, which reaches the session's evaluation recorder when one is given.
 */

import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { DecisionResult } from "../decision/evaluation.ts";
import type { NoulDirection } from "../decision/noul.ts";
import type { Consequence, DecisionDefinition } from "../decision/primitives.ts";
import { createDecisionProgram } from "../decision/program.ts";
import { type SemanticDecisionTrace, traceJudgmentsFromEvaluation } from "../system-one/semantic-evaluation-ledger.ts";
import type { DecisionEngine, DecisionEngineProgram, RetentionAnswer } from "./evidence-retention-planner.ts";

interface RetentionQuestion {
	readonly id?: string;
	readonly instruction?: string;
	/** The question's shape. Absent means boolean. */
	readonly kind?: DecisionDefinition["kind"];
	/** What a true and a false answer mean, when the boundary is subtle; sent to the engine as is. */
	readonly criteria?: { readonly true?: string; readonly false?: string };
	/** Which end of the probability the asker needs; a boolean question's direction, sent to the engine when present. */
	readonly direction?: NoulDirection;
}

/** Where a consumer's decision trace goes: the session's evaluation recorder. */
export interface RetentionTraceObserver {
	noteTrace(evaluationId: string, trace: SemanticDecisionTrace): void;
}

/** A question's definition for the engine: a noul question as before, any other shape as the consumer defined it. */
function definitionOf(question: RetentionQuestion & { id: string; instruction: string }): DecisionDefinition {
	if (question.kind === undefined || question.kind === "boolean")
		return {
			kind: "boolean",
			id: question.id,
			instruction: question.instruction,
			...(question.criteria ? { criteria: question.criteria } : {}),
			...(question.direction ? { direction: question.direction } : {}),
		};
	// The definition passes through as the consumer wrote it: the engine reads the options, levels or members it carries and
	// does not validate them, so a malformed one fails the evaluation and the caller's handling of a failed evaluation applies.
	return question as DecisionDefinition;
}

/** A result as the consumer reads it. An unsupported result answers nothing. */
function answerOf(result: DecisionResult): RetentionAnswer | undefined {
	switch (result.kind) {
		case "boolean":
			return { type: "noul", noul: result.probabilityTrue };
		case "choice":
			return {
				choice: result.selected,
				probabilities: { ...result.distribution },
				confidence: result.confidence.value,
			};
		case "score":
			return {
				score: result.value,
				probabilities: Object.fromEntries(Object.entries(result.distribution)),
				confidence: result.confidence.value,
			};
		case "set":
			return {
				selected: result.selected,
				memberships: { ...result.memberships },
				...(result.unsettled !== undefined ? { unsettled: result.unsettled } : {}),
				confidence: result.confidence.value,
			};
		case "unsupported":
			return undefined;
	}
}

export function createRetentionDecisionEngine(
	engine: SemanticDecisionEngine,
	observer?: RetentionTraceObserver,
): DecisionEngine {
	return {
		model: engine.model,
		...(observer ? { noteTrace: (evaluationId, trace) => observer.noteTrace(evaluationId, trace) } : {}),
		async evaluate(program: DecisionEngineProgram, state, options) {
			const decisions = (program.decisions as readonly RetentionQuestion[])
				.filter((decision): decision is RetentionQuestion & { id: string; instruction: string } =>
					Boolean(decision?.id && decision?.instruction),
				)
				.map(definitionOf);
			if (decisions.length === 0) return {};

			const evaluation = await engine.evaluate(
				createDecisionProgram({ id: program.program_id, decisions }),
				state ?? {},
				{
					consequence: (options?.consequence as Consequence | undefined) ?? "medium",
					signal: options?.signal,
					...(options?.occupancy === undefined ? {} : { occupancy: options.occupancy }),
				},
			);

			const answers: Record<string, RetentionAnswer> = {};
			for (const [id, result] of Object.entries(evaluation.results)) {
				const answer = answerOf(result);
				if (answer !== undefined) answers[id] = answer;
			}
			const evaluationId = evaluation.audit?.evaluationId;
			return {
				answers,
				model: evaluation.engine.model,
				...(evaluationId !== undefined
					? { evaluationId, judgments: traceJudgmentsFromEvaluation(evaluation) }
					: {}),
			};
		},
	};
}
