/**
 * Bridges the session's own semantic decision engine into the evidence retention planner.
 *
 * The planner speaks a minimal batched question program; the session owns a `SemanticDecisionEngine`.
 * Retention questions are boolean by construction ("is this still useful?"), so the engine's
 * probability of true is the planner's keep probability — no judgment is invented in between.
 *
 * Every consumer of this shape (retention, the operation gate, plan review, project rules) gets the
 * evaluation's ledger id and its judgments back, and attaches the decision it made from them through
 * `noteTrace`, which reaches the session's evaluation recorder when one is given.
 */

import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { Consequence } from "../decision/primitives.ts";
import { createDecisionProgram } from "../decision/program.ts";
import { type SemanticDecisionTrace, traceJudgmentsFromEvaluation } from "../system-one/semantic-evaluation-ledger.ts";
import type { DecisionEngine, DecisionEngineProgram } from "./evidence-retention-planner.ts";

interface RetentionQuestion {
	readonly id?: string;
	readonly instruction?: string;
	/** What a true and a false answer mean, when the boundary is subtle; sent to the engine as is. */
	readonly criteria?: { readonly true?: string; readonly false?: string };
}

/** Where a consumer's decision trace goes: the session's evaluation recorder. */
export interface RetentionTraceObserver {
	noteTrace(evaluationId: string, trace: SemanticDecisionTrace): void;
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
				.map((decision) => ({
					kind: "boolean" as const,
					id: decision.id,
					instruction: decision.instruction,
					...(decision.criteria ? { criteria: decision.criteria } : {}),
				}));
			if (decisions.length === 0) return {};

			const evaluation = await engine.evaluate(
				createDecisionProgram({ id: program.program_id, decisions }),
				state ?? {},
				{
					consequence: (options?.consequence as Consequence | undefined) ?? "medium",
					signal: options?.signal,
				},
			);

			const answers: Record<string, { type?: string; noul?: number }> = {};
			for (const [id, result] of Object.entries(evaluation.results)) {
				if (result.kind !== "boolean") continue;
				answers[id] = { type: "noul", noul: result.probabilityTrue };
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
