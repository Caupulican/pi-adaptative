import { describe, expect, it } from "vitest";
import type { GoalContinuationLoopOptions, GoalContinuationLoopResult } from "../src/core/agent-session.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ParsedGoalContinueCommand = { ok: true; maxTurns: number; maxStallTurns: number } | { ok: false; error: string };

type InteractiveModePrototype = {
	parseGoalContinueCommand(this: unknown, text: string): ParsedGoalContinueCommand;
	handleGoalContinueCommand(this: GoalContinueCommandContext, text: string): Promise<void>;
};

type GoalContinueCommandContext = {
	session: {
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
	};
	parseGoalContinueCommand: (text: string) => ParsedGoalContinueCommand;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	refreshAutonomyFooterStatus: () => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createLoopResult(overrides?: Partial<GoalContinuationLoopResult>): GoalContinuationLoopResult {
	return {
		turnsSubmitted: 1,
		stopReason: "max_turns_reached",
		finalSnapshot: {
			workerResults: [],
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Goal remains active.",
				openRequirementIds: ["req-1"],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		},
		...overrides,
	};
}

function createContext(result: GoalContinuationLoopResult = createLoopResult()) {
	const calls: GoalContinuationLoopOptions[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	let refreshCount = 0;
	const context: GoalContinueCommandContext = {
		session: {
			continueGoalLoop: async (options) => {
				calls.push(options);
				return result;
			},
		},
		parseGoalContinueCommand: interactiveModePrototype.parseGoalContinueCommand,
		showStatus: (message) => {
			statuses.push(message);
		},
		showError: (message) => {
			errors.push(message);
		},
		refreshAutonomyFooterStatus: () => {
			refreshCount++;
		},
	};
	return { context, calls, statuses, errors, getRefreshCount: () => refreshCount };
}

describe("InteractiveMode /goal-continue command", () => {
	it("is listed as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "goal-continue")).toBe(true);
	});

	it("parses default and explicit bounded arguments", () => {
		expect(interactiveModePrototype.parseGoalContinueCommand("/goal-continue")).toEqual({
			ok: true,
			maxTurns: 20,
			maxStallTurns: 20,
			maxWallClockMinutes: 0,
		});
		expect(interactiveModePrototype.parseGoalContinueCommand("/goal-continue 7 0")).toEqual({
			ok: true,
			maxTurns: 7,
			maxStallTurns: 0,
			maxWallClockMinutes: 0,
		});
	});

	it("rejects invalid arguments", () => {
		const invalid = [
			"/goal-continue 0",
			"/goal-continue 21",
			"/goal-continue 1 101",
			"/goal-continue 1.5",
			"/goal-continue one",
			"/goal-continue 1 2 3 4",
		];
		for (const text of invalid) {
			const result = interactiveModePrototype.parseGoalContinueCommand(text);
			expect(result.ok).toBe(false);
		}
	});

	it("runs the bounded goal loop with parsed options and reports status", async () => {
		const { context, calls, statuses, errors, getRefreshCount } = createContext(
			createLoopResult({ stopReason: "goal_state_not_advanced", turnsSubmitted: 2 }),
		);

		await interactiveModePrototype.handleGoalContinueCommand.call(context, "/goal-continue 2 10");

		expect(calls).toEqual([{ maxTurns: 2, maxStallTurns: 10, maxWallClockMinutes: 0 }]);
		expect(statuses[0]).toContain("Goal continuation started");
		expect(statuses[1]).toContain("goal_state_not_advanced");
		expect(statuses[1]).toContain("submitted 2 turn(s)");
		expect(errors).toEqual([]);
		expect(getRefreshCount()).toBe(1);
	});

	it("shows an error and does not run for invalid arguments", async () => {
		const { context, calls, errors, getRefreshCount } = createContext();

		await interactiveModePrototype.handleGoalContinueCommand.call(context, "/goal-continue 1000");

		expect(calls).toEqual([]);
		expect(errors).toEqual(["Usage: /goal-continue [maxTurns 1-20] [maxStallTurns 0-100] [maxMinutes 0-1440]"]);
		expect(getRefreshCount()).toBe(0);
	});

	it("reports loop failures and refreshes footer status", async () => {
		const calls: GoalContinuationLoopOptions[] = [];
		const errors: string[] = [];
		let refreshCount = 0;
		const context: GoalContinueCommandContext = {
			session: {
				continueGoalLoop: async (options) => {
					calls.push(options);
					throw new Error("loop failed");
				},
			},
			parseGoalContinueCommand: interactiveModePrototype.parseGoalContinueCommand,
			showStatus: () => {},
			showError: (message) => {
				errors.push(message);
			},
			refreshAutonomyFooterStatus: () => {
				refreshCount++;
			},
		};

		await interactiveModePrototype.handleGoalContinueCommand.call(context, "/goal-continue 1 20");

		expect(calls).toEqual([{ maxTurns: 1, maxStallTurns: 20, maxWallClockMinutes: 0 }]);
		expect(errors).toEqual(["Goal continuation failed: loop failed"]);
		expect(refreshCount).toBe(1);
	});
});
