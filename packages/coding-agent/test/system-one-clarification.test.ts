import { describe, expect, it, vi } from "vitest";
import type { GoalClarification } from "../src/core/goals/goal-state.ts";
import type { HumanInputQuestion } from "../src/core/human-input.ts";
import {
	type ClarificationDecisionEngine,
	type ClarificationDecisionProgram,
	clarificationQuestionIdentity,
	evaluateClarificationNeed,
	formatClarificationQuestion,
} from "../src/core/system-one/clarification.ts";

const questions: HumanInputQuestion[] = [
	{
		id: "scope",
		header: "Scope",
		question: "Should the rewrite cover the archived importer too?",
		options: [
			{ label: "Only active", description: "Leave the archived importer untouched." },
			{ label: "Both", description: "Rewrite the archived importer as well." },
		],
	},
];

const askedQuestion = formatClarificationQuestion(questions);

function priorClarification(overrides: Partial<GoalClarification> = {}): GoalClarification {
	return {
		requestId: "human-input:call-1",
		category: "information",
		question: askedQuestion,
		status: "answered",
		requestedAt: "2026-09-20T00:00:00.000Z",
		answeredAt: "2026-09-20T00:01:00.000Z",
		answerSummary: "Scope: user answered: Only active",
		...overrides,
	};
}

function engineAnswering(answers: Record<string, { noul?: number; value?: boolean }>): {
	engine: ClarificationDecisionEngine;
	programs: ClarificationDecisionProgram[];
} {
	const programs: ClarificationDecisionProgram[] = [];
	return {
		programs,
		engine: {
			evaluate: async (program) => {
				programs.push(program);
				return { answers };
			},
		},
	};
}

function input(overrides: Partial<Parameters<typeof evaluateClarificationNeed>[0]> = {}) {
	return {
		objectiveId: "goal-1",
		questions,
		category: "information" as const,
		clarifications: [] as readonly GoalClarification[],
		userGoal: "tidy the settings screen",
		...overrides,
	};
}

describe("clarification sufficiency arbitration", () => {
	it("refuses a question the owner already answered for this objective", async () => {
		const verdict = await evaluateClarificationNeed(input({ clarifications: [priorClarification()] }));
		expect(verdict).toEqual({
			decision: "duplicate",
			reasonCode: "already_answered",
			detail: "Owner already answered this: Scope: user answered: Only active",
		});
	});

	it("refuses a question that is still waiting on the owner", async () => {
		const verdict = await evaluateClarificationNeed(
			input({
				clarifications: [
					priorClarification({ status: "pending", answerSummary: undefined, answeredAt: undefined }),
				],
			}),
		);
		expect(verdict.decision).toBe("duplicate");
		expect(verdict.reasonCode).toBe("asked_recently");
	});

	it("matches a prior ask on normalized text, not exact formatting", async () => {
		const reformatted = priorClarification({ question: `  ${askedQuestion.toUpperCase()}  ` });
		const verdict = await evaluateClarificationNeed(input({ clarifications: [reformatted] }));
		expect(verdict.reasonCode).toBe("already_answered");
		expect(clarificationQuestionIdentity(reformatted.question)).toBe(clarificationQuestionIdentity(askedQuestion));
	});

	it("does not treat an ask the owner declined as a duplicate", async () => {
		const { engine } = engineAnswering({ missing_information: { noul: 0.9 } });
		const verdict = await evaluateClarificationNeed(
			input({
				clarifications: [priorClarification({ status: "cancelled", answerSummary: undefined })],
				semantic: engine,
			}),
		);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reasonCode).toBe("semantic_missing_information");
	});

	it("records that no semantic engine was bound instead of inventing a verdict", async () => {
		const verdict = await evaluateClarificationNeed(input());
		expect(verdict.decision).toBe("ask");
		expect(verdict.reasonCode).toBe("semantic_unavailable");
		expect(verdict.detail).toContain("No semantic decision engine is bound");
	});

	it("asks when JEV-001 reports critical information missing", async () => {
		const { engine, programs } = engineAnswering({
			missing_information: { noul: 0.92 },
			objective_coherent: { noul: 0.95 },
		});
		const verdict = await evaluateClarificationNeed(input({ semantic: engine }));
		expect(verdict.decision).toBe("ask");
		expect(verdict.reasonCode).toBe("semantic_missing_information");
		expect(programs).toHaveLength(1);
		expect(programs[0]?.program_id).toContain("JEV-001");
	});

	it("resolves autonomously when JEV-001 reports nothing missing", async () => {
		const { engine } = engineAnswering({
			missing_information: { noul: 0.05 },
			objective_coherent: { noul: 0.97 },
		});
		const verdict = await evaluateClarificationNeed(input({ semantic: engine }));
		expect(verdict.decision).toBe("resolve_autonomously");
		expect(verdict.reasonCode).toBe("semantic_sufficient");
	});

	it("asks when nothing is missing but the objective itself is incoherent", async () => {
		const { engine } = engineAnswering({
			missing_information: { noul: 0.05 },
			objective_coherent: { noul: 0.1 },
		});
		const verdict = await evaluateClarificationNeed(input({ semantic: engine }));
		expect(verdict.decision).toBe("ask");
		expect(verdict.reasonCode).toBe("semantic_missing_information");
		expect(verdict.detail).toContain("objective_coherent=false");
	});

	it("asks, and says why, when the evaluation fails or answers nothing", async () => {
		const throwing: ClarificationDecisionEngine = {
			evaluate: async () => {
				throw new Error("engine offline");
			},
		};
		const failed = await evaluateClarificationNeed(input({ semantic: throwing }));
		expect(failed).toEqual({
			decision: "ask",
			reasonCode: "no_prior",
			detail: "Sufficiency evaluation failed: engine offline",
		});

		const { engine } = engineAnswering({ objective_coherent: { noul: 0.9 } });
		const unanswered = await evaluateClarificationNeed(input({ semantic: engine }));
		expect(unanswered.decision).toBe("ask");
		expect(unanswered.reasonCode).toBe("no_prior");
		expect(unanswered.detail).toContain("missing_information");
	});

	it("evaluates at most once per ask, with boolean decisions only", async () => {
		const evaluate = vi.fn(async (program: ClarificationDecisionProgram, _state?: Record<string, unknown>) => {
			expect(program.decisions.every((decision) => (decision as { kind?: string }).kind === "boolean")).toBe(true);
			expect(program.decisions.length).toBeGreaterThan(0);
			return { answers: { missing_information: { noul: 0.05 }, objective_coherent: { noul: 0.9 } } };
		});
		await evaluateClarificationNeed(input({ semantic: { evaluate } }));
		expect(evaluate).toHaveBeenCalledTimes(1);
		const state = evaluate.mock.calls[0]?.[1];
		expect(state?.objectiveId).toBe("goal-1");
		expect(state?.request).toBe("tidy the settings screen");
		expect(state?.proposedQuestion).toBe(askedQuestion);
	});
});
