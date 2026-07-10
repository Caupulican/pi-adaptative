import { describe, expect, it } from "vitest";
import { shouldQueryLongTermMemory } from "../src/core/context/long-term-memory-trigger.ts";
import { resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";

describe("shouldQueryLongTermMemory", () => {
	it("fires for explicit recall and durable identifiers", () => {
		expect(shouldQueryLongTermMemory({ latestUserText: "recall the prior package decision" })).toMatchObject({
			shouldQuery: true,
			reason: "explicit_recall",
		});
		expect(shouldQueryLongTermMemory({ latestUserText: "what happened with goal-mrdqec8i?" })).toMatchObject({
			shouldQuery: true,
			reason: "durable_identifier",
		});
	});

	it("fires for user or project preference questions", () => {
		expect(shouldQueryLongTermMemory({ latestUserText: "what are my project rules here?" })).toMatchObject({
			shouldQuery: true,
			reason: "user_or_project_preference",
		});
	});

	it("skips short grounded turns and compact turns already covered by current work", () => {
		expect(shouldQueryLongTermMemory({ latestUserText: "ok" })).toMatchObject({
			shouldQuery: false,
			reason: "short_or_grounded_turn",
		});
		expect(
			shouldQueryLongTermMemory({
				latestUserText: "continue implementing this narrow edit",
				budget: resolveMemoryPromptBudget({ contextWindow: 1024 }),
				currentWorkCandidateCount: 1,
			}),
		).toMatchObject({ shouldQuery: false });
	});

	it("fails closed on disabled budgets and secret-like queries", () => {
		expect(
			shouldQueryLongTermMemory({ latestUserText: "recall", budget: resolveMemoryPromptBudget({}) }),
		).toMatchObject({
			shouldQuery: false,
			reason: "budget_disabled",
		});
		expect(shouldQueryLongTermMemory({ latestUserText: "api_key=abc123 recall" })).toMatchObject({
			shouldQuery: false,
			reason: "secret_like_query",
		});
	});
});
