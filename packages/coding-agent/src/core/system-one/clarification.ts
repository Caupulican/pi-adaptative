/**
 * Sufficiency arbitration for owner clarifications.
 *
 * Asking the owner is the most expensive thing an objective can do: it stops autonomous execution
 * until a human replies. System One owns that decision, not the model. This module answers one
 * question -- does this objective genuinely need the owner right now? -- from two sources and
 * nothing else: the objective's own durable clarification ledger (deterministic), and one JEV-001
 * evaluation (semantic). It never invents a verdict; with no semantic engine bound it says so and
 * lets the ask through.
 *
 * Clarification is INFORMATION. No verdict here grants, widens, or records authority: the execution
 * charter stays `interaction_mode: "start_only"` and an owner answer is evidence, never permission.
 */

import type { GoalClarification, GoalClarificationCategory } from "../goals/goal-state.ts";
import type { HumanInputQuestion } from "../human-input.ts";
import { compileDecisionProgramForCheckpoint } from "../steering/programs.ts";

/**
 * The batched decision-program shape the session's recorded semantic engine consumes. Declared here
 * rather than imported so this module depends on the port, not on the compaction planner that also
 * happens to speak it (same local-port convention as the project-rule and supervision controllers).
 */
export interface ClarificationDecisionProgram {
	readonly schema_version: "1.0";
	readonly program_id: string;
	readonly description: string;
	readonly decisions: readonly unknown[];
}

export interface ClarificationDecisionEngine {
	evaluate(
		program: ClarificationDecisionProgram,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{
		answers?: Record<string, { type?: string; noul?: number; choice?: string; value?: boolean | number }>;
		results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
	}>;
}

export type ClarificationDecision = "ask" | "duplicate" | "resolve_autonomously";

export type ClarificationReasonCode =
	| "no_prior"
	| "already_answered"
	| "asked_recently"
	| "semantic_missing_information"
	| "semantic_sufficient"
	| "semantic_unavailable";

export interface ClarificationVerdict {
	readonly decision: ClarificationDecision;
	readonly reasonCode: ClarificationReasonCode;
	readonly detail?: string;
}

export interface ClarificationNeedInput {
	readonly objectiveId: string;
	readonly questions: readonly HumanInputQuestion[];
	readonly category: GoalClarificationCategory;
	readonly clarifications: readonly GoalClarification[];
	readonly userGoal: string;
	readonly semantic?: ClarificationDecisionEngine;
	readonly signal?: AbortSignal;
}

/** Bound on the proposed-question text recorded on the ledger and handed to the semantic program. */
export const MAX_CLARIFICATION_QUESTION_LENGTH = 300;

/** A boolean answer is trusted only above this probability; below it the answer is not an answer. */
const SEMANTIC_TRUE_THRESHOLD = 0.6;

/** Display text for a batch of questions: what the ledger records and what the owner was asked. */
export function formatClarificationQuestion(questions: readonly HumanInputQuestion[]): string {
	const text = questions
		.map((question) => `${question.header.trim()}: ${question.question.trim()}`)
		.join(" | ")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length <= MAX_CLARIFICATION_QUESTION_LENGTH
		? text
		: `${text.slice(0, MAX_CLARIFICATION_QUESTION_LENGTH)}…`;
}

/** Identity of an ask: the same headers and prompts, whitespace- and case-insensitive. */
export function clarificationQuestionIdentity(text: string): string {
	return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

function readBoolean(
	answers: Record<string, { type?: string; noul?: number; choice?: string; value?: boolean | number }> | undefined,
	id: string,
): boolean | undefined {
	const answer = answers?.[id];
	if (!answer) return undefined;
	if (typeof answer.value === "boolean") return answer.value;
	if (typeof answer.noul === "number") return answer.noul >= SEMANTIC_TRUE_THRESHOLD;
	return undefined;
}

/**
 * Builds the JEV-001 question set for this ask. The boolean decisions are taken verbatim from the
 * checkpoint's compiled program, so the ids and instructions are the checkpoint's own. Its score and
 * choice decisions are left out because the batched engine port answers booleans only -- passing
 * them through would turn "how severe is remaining ambiguity (0-3)?" into a yes/no question, which
 * is a worse answer than not asking it. Nothing this arbitration reads is among them.
 */
function buildClarificationProgram(state: Record<string, unknown>): ClarificationDecisionProgram {
	const compiled = compileDecisionProgramForCheckpoint("JEV-001", state);
	return {
		schema_version: "1.0",
		program_id: compiled.id,
		description: "Objective clarification sufficiency (JEV-001 admission questions).",
		decisions: compiled.decisions.filter((decision) => decision.kind === "boolean"),
	};
}

/**
 * Decision table:
 *
 * | condition                                              | decision             | reasonCode                   |
 * | ------------------------------------------------------ | -------------------- | ---------------------------- |
 * | identical ask already answered on this objective        | duplicate            | already_answered             |
 * | identical ask still pending on this objective           | duplicate            | asked_recently               |
 * | no semantic engine bound                                | ask                  | semantic_unavailable         |
 * | JEV-001: critical information missing                   | ask                  | semantic_missing_information |
 * | JEV-001: objective incoherent                           | ask                  | semantic_missing_information |
 * | JEV-001: nothing missing and objective coherent         | resolve_autonomously | semantic_sufficient          |
 * | JEV-001 produced no usable answer (or threw)            | ask                  | no_prior                     |
 *
 * A prior ask the owner explicitly declined is deliberately NOT a duplicate: a decline is owner
 * intent about that moment, and the semantic stage decides whether the objective can now proceed
 * without them. At most one semantic evaluation runs per ask.
 */
export async function evaluateClarificationNeed(input: ClarificationNeedInput): Promise<ClarificationVerdict> {
	const proposed = formatClarificationQuestion(input.questions);
	const identity = clarificationQuestionIdentity(proposed);

	for (const clarification of [...input.clarifications].reverse()) {
		if (clarificationQuestionIdentity(clarification.question) !== identity) continue;
		if (clarification.status === "answered") {
			return {
				decision: "duplicate",
				reasonCode: "already_answered",
				detail: clarification.answerSummary
					? `Owner already answered this: ${clarification.answerSummary}`
					: "Owner already answered this question for the active objective.",
			};
		}
		if (clarification.status === "pending") {
			return {
				decision: "duplicate",
				reasonCode: "asked_recently",
				detail: `This question is already waiting on the owner (request ${clarification.requestId}).`,
			};
		}
	}

	if (!input.semantic) {
		return {
			decision: "ask",
			reasonCode: "semantic_unavailable",
			detail: "No semantic decision engine is bound; sufficiency was not evaluated.",
		};
	}

	const state: Record<string, unknown> = {
		objectiveId: input.objectiveId,
		request: input.userGoal,
		clarifications: input.clarifications.map((clarification) => ({
			question: clarification.question,
			status: clarification.status,
			answerSummary: clarification.answerSummary,
		})),
		proposedQuestion: proposed,
		proposedQuestionCategory: input.category,
	};

	let answers: Awaited<ReturnType<ClarificationDecisionEngine["evaluate"]>>["answers"];
	try {
		const evaluation = await input.semantic.evaluate(buildClarificationProgram(state), state, {
			consequence: "high",
			signal: input.signal,
		});
		answers = evaluation.answers;
	} catch (error) {
		return {
			decision: "ask",
			reasonCode: "no_prior",
			detail: `Sufficiency evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const missingInformation = readBoolean(answers, "missing_information");
	const objectiveCoherent = readBoolean(answers, "objective_coherent");
	if (missingInformation === undefined) {
		return {
			decision: "ask",
			reasonCode: "no_prior",
			detail: "Sufficiency evaluation returned no answer for missing_information.",
		};
	}
	if (missingInformation) {
		return {
			decision: "ask",
			reasonCode: "semantic_missing_information",
			detail: "JEV-001 reports critical information missing for this objective.",
		};
	}
	if (objectiveCoherent === false) {
		return {
			decision: "ask",
			reasonCode: "semantic_missing_information",
			detail: "JEV-001 reports the objective is not coherent (objective_coherent=false).",
		};
	}
	return {
		decision: "resolve_autonomously",
		reasonCode: "semantic_sufficient",
		detail: "JEV-001 reports no missing information for this objective.",
	};
}
