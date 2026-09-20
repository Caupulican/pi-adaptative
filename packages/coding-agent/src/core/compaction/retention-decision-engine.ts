/**
 * Bridges the session's own semantic decision engine into the evidence retention planner.
 *
 * The planner speaks a minimal batched question program; the session owns a `SemanticDecisionEngine`.
 * Retention questions are boolean by construction ("is this still useful?"), so the engine's
 * probability of true is the planner's keep probability — no judgment is invented in between.
 */

import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { Consequence } from "../decision/primitives.ts";
import { createDecisionProgram } from "../decision/program.ts";
import type { DecisionEngine, DecisionEngineProgram } from "./evidence-retention-planner.ts";

interface RetentionQuestion {
	readonly id?: string;
	readonly instruction?: string;
}

export function createRetentionDecisionEngine(engine: SemanticDecisionEngine): DecisionEngine {
	return {
		async evaluate(program: DecisionEngineProgram, state, options) {
			const decisions = (program.decisions as readonly RetentionQuestion[])
				.filter((decision): decision is Required<RetentionQuestion> =>
					Boolean(decision?.id && decision?.instruction),
				)
				.map((decision) => ({
					kind: "boolean" as const,
					id: decision.id,
					instruction: decision.instruction,
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
			return { answers };
		},
	};
}
