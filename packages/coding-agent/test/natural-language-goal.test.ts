import { describe, expect, it } from "vitest";
import {
	GoalTokenBudgetParseError,
	parseExplicitChatGoal,
	parseExplicitGoalStartAuthority,
	parseRequestedTokenBudget,
	priorUserPromptText,
} from "../src/core/goals/natural-language-goal.ts";

describe("natural-language persistent goal admission", () => {
	it.each([
		[
			"Set a persistent goal: finish Windows parity and keep working until the focused tests pass.",
			"finish Windows parity and keep working until the focused tests pass.",
		],
		[
			"My persistent goal is to make compaction efficient and preserve goal continuation.",
			"make compaction efficient and preserve goal continuation.",
		],
		["The goal is to preserve active work across compaction.", "preserve active work across compaction."],
		[
			"Treat this as my goal: migrate USER.md into indexed memory shards without losing facts.",
			"migrate USER.md into indexed memory shards without losing facts.",
		],
		[
			"Keep working until this is complete: fix the Windows harness and prove the regression.",
			"fix the Windows harness and prove the regression.",
		],
		["instead of trace and fix, i want to refactor what is in place", "refactor what is in place"],
		["I want to refactor the generator pipeline into one owner.", "refactor the generator pipeline into one owner."],
	])("admits explicit durable chat intent", (text, objective) => {
		expect(parseExplicitChatGoal(text)).toEqual({ objective });
	});

	it.each([
		"Fix the Windows tests and report back.",
		"How does the goal continuation command work?",
		"The goal parser should recognize explicit phrasing.",
		"it's an issue to notice if the goal has been set via the text chat without using the goal slash command and we lose time on this",
		"Do not infer a goal from an ordinary multi-step task.",
	])("rejects ordinary tasks and meta-discussion", (text) => {
		expect(parseExplicitChatGoal(text)).toBeUndefined();
	});

	it("rejects empty and oversized objectives", () => {
		expect(parseExplicitChatGoal("Set a persistent goal:   ")).toBeUndefined();
		expect(parseExplicitChatGoal(`Set a persistent goal: ${"x".repeat(4001)}`)).toBeUndefined();
	});

	it("reads an explicit numeric token ceiling without inventing one", () => {
		expect(parseExplicitChatGoal("Set a persistent goal: fix the harness with a 40k token budget.")).toEqual({
			objective: "fix the harness with a 40k token budget.",
			tokenBudget: 40_000,
		});
		expect(parseExplicitGoalStartAuthority("this is a goal")).toEqual({});
		expect(parseExplicitGoalStartAuthority("this is a goal, use it")).toEqual({});
		expect(parseExplicitGoalStartAuthority("this is a goal. implement it now")).toEqual({});
		expect(parseExplicitGoalStartAuthority("make this a goal and implement it")).toEqual({});
		expect(parseExplicitGoalStartAuthority("this is a goal with a 40k token budget")).toEqual({
			tokenBudget: 40_000,
		});
		expect(parseExplicitGoalStartAuthority("Investigate and fix the bug")).toBeUndefined();
		expect(parseExplicitGoalStartAuthority("this is a goal-oriented design")).toBeUndefined();
		expect(parseExplicitChatGoal("this is a goal. implement the inspect wording.")).toEqual({
			objective: "implement the inspect wording.",
		});
		expect(parseExplicitChatGoal("this is a goal, use it", "Ship the inspect wording so workers can start.")).toEqual(
			{
				objective: "Ship the inspect wording so workers can start.",
			},
		);
		expect(parseExplicitChatGoal("the task is a goal", "Fix worker start without a profile.")).toEqual({
			objective: "Fix worker start without a profile.",
		});
		expect(parseExplicitChatGoal("treat this task as a goal", "Keep workers starting without a base.")).toEqual({
			objective: "Keep workers starting without a base.",
		});
		expect(
			parseExplicitChatGoal(
				"this is a goal by the way, i'm handing over to you, use max 2 sub agents to help you deliver. You are the orchestrator and also reviewer and team lead",
				"finish the mixed-surface generator so water and mountain stay present",
			),
		).toEqual({
			objective: "finish the mixed-surface generator so water and mountain stay present",
		});
		expect(
			parseExplicitChatGoal(
				"this is a goal by the way, i'm handing over to you, use max 2 sub agents to help you deliver. You are the orchestrator and also reviewer and team lead",
			),
		).toBeUndefined();
		expect(
			parseExplicitGoalStartAuthority(
				"this is a goal by the way, i'm handing over to you, use max 2 sub agents to help you deliver. You are the orchestrator and also reviewer and team lead",
			),
		).toEqual({});
		expect(parseExplicitChatGoal("this is a goal")).toBeUndefined();
		expect(parseExplicitChatGoal("this is a goal with a 40k token budget")).toBeUndefined();
		expect(
			parseExplicitChatGoal("this is a goal with a 40k token budget", "Keep working the inspect wording."),
		).toEqual({
			objective: "Keep working the inspect wording.",
			tokenBudget: 40_000,
		});
		expect(parseExplicitChatGoal("Set a persistent goal: process 40k tokens of archived logs.")).toEqual({
			objective: "process 40k tokens of archived logs.",
		});
	});

	it.each([
		["Token budget of 5 million.", 5_000_000],
		["Token budget of 2 M.", 2_000_000],
		["Token budget of 500 k.", 500_000],
		["Token budget of 1.000.000.", 1_000_000],
	])("parses %s into an exact token ceiling instead of the truncated legacy result", (text, expected) => {
		// Previously: the unit suffix regex was glued to the digits with no whitespace and only knew
		// single letters k/m, so "5 million." parsed as 5, "2 M." as 2, "500 k." as 500, and the dotted
		// thousands separator "1.000.000" produced NaN (silently unbounded, undefined).
		expect(parseRequestedTokenBudget(text)).toBe(expected);
	});

	it("walks back past the current classification phrase when it is already in history", () => {
		const prior = "Implement the inspect wording so workers can start without a profile.";
		expect(
			priorUserPromptText(
				[
					{ role: "user", content: prior },
					{ role: "assistant", content: "noted" },
					{ role: "user", content: "this is a goal" },
				],
				"this is a goal",
			),
		).toBe(prior);
		expect(priorUserPromptText([{ role: "user", content: prior }], "this is a goal")).toBe(prior);
	});

	it("fails closed instead of silently going unbounded when a token budget is clearly stated but unparseable", () => {
		expect(() => parseRequestedTokenBudget("Token budget of 12,34,567.")).toThrow(GoalTokenBudgetParseError);
	});

	it("scopes token-budget parsing to text outside the captured objective, never the objective's own subject matter", () => {
		// The objective describes raising a CODE constant named "token budget" from 4096 to 8192; that
		// is the task's subject matter, not a directive about the agent's own execution ceiling, so no
		// tokenBudget must be adopted from it.
		expect(parseExplicitChatGoal("Set a goal: raise the model token budget of 4096 in config.ts to 8192")).toEqual({
			objective: "raise the model token budget of 4096 in config.ts to 8192",
		});
		// A budget phrase that is the objective's own TRAILING clause (nothing else follows it) is
		// still a real directive and must keep working (regression guard for the case above).
		expect(parseExplicitChatGoal("Set a persistent goal: fix the harness with a 40k token budget.")).toEqual({
			objective: "fix the harness with a 40k token budget.",
			tokenBudget: 40_000,
		});
	});
});
