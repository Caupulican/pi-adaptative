import { describe, expect, it } from "vitest";
import { parseExplicitChatGoal } from "../src/core/goals/natural-language-goal.ts";

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
});
