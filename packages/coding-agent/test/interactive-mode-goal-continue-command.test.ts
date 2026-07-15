import { describe, expect, it } from "vitest";
import type { GoalContinuationLoopOptions, GoalContinuationLoopResult } from "../src/core/agent-session.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ParsedGoalContinueCommand = { ok: true; maxTurns: number; maxStallTurns: number } | { ok: false; error: string };

type InteractiveModePrototype = {
	parseGoalContinueCommand(this: unknown, text: string): ParsedGoalContinueCommand;
	handleGoalCommand(this: GoalCommandContext, text: string): Promise<void>;
	handleGoalContinueCommand(this: GoalContinueCommandContext, text: string): Promise<void>;
};

type GoalCommandContext = {
	session: {
		getGoalStateSnapshot: () => GoalState | undefined;
		saveGoalStateSnapshot: (state: GoalState) => string;
		sendUserMessage: (content: string) => Promise<void>;
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
		getGoalRuntimeSnapshot: (settings: { maxStallTurns: number }) => GoalContinuationLoopResult["finalSnapshot"];
	};
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	refreshAutonomyFooterStatus: () => void;
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

function createGoalCommandContext(initialState?: GoalState) {
	let state = initialState;
	const saved: GoalState[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const prompts: string[] = [];
	let continuationCalls = 0;
	let refreshCount = 0;
	const context: GoalCommandContext = {
		session: {
			getGoalStateSnapshot: () => state,
			saveGoalStateSnapshot: (next) => {
				state = next;
				saved.push(next);
				return "entry";
			},
			sendUserMessage: async (content) => {
				prompts.push(content);
			},
			continueGoalLoop: async () => {
				continuationCalls++;
				return createLoopResult();
			},
			getGoalRuntimeSnapshot: () => {
				const snapshot = createLoopResult().finalSnapshot;
				return {
					...snapshot,
					goalState: state,
					continuation: {
						...snapshot.continuation,
						openRequirementIds:
							state?.requirements
								.filter((requirement) => requirement.status === "open")
								.map((requirement) => requirement.id) ?? [],
						blockedRequirementIds:
							state?.requirements
								.filter((requirement) => requirement.status === "blocked")
								.map((requirement) => requirement.id) ?? [],
						satisfiedRequirementIds:
							state?.requirements
								.filter((requirement) => requirement.status === "satisfied")
								.map((requirement) => requirement.id) ?? [],
					},
				};
			},
		},
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		refreshAutonomyFooterStatus: () => {
			refreshCount++;
		},
	};
	return {
		context,
		saved,
		statuses,
		errors,
		prompts,
		getState: () => state,
		getContinuationCalls: () => continuationCalls,
		getRefreshCount: () => refreshCount,
	};
}

describe("InteractiveMode /goal-continue command", () => {
	it("is listed as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "goal")).toBe(true);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "goal-continue")).toBe(true);
	});

	it("renders empty goal status for /goal", async () => {
		const statuses: string[] = [];
		const context: GoalCommandContext = {
			session: {
				getGoalStateSnapshot: () => undefined,
				saveGoalStateSnapshot: () => "entry",
				sendUserMessage: async () => {},
				continueGoalLoop: async () => createLoopResult(),
				getGoalRuntimeSnapshot: () =>
					createLoopResult({
						turnsSubmitted: 0,
						finalSnapshot: {
							workerResults: [],
							learningDecisions: [],
							continuation: {
								action: "ask-user",
								reasonCode: "missing_goal_state",
								message: "No goal state is present.",
								openRequirementIds: [],
								blockedRequirementIds: [],
								satisfiedRequirementIds: [],
							},
						},
					}).finalSnapshot,
			},
			showStatus: (message) => statuses.push(message),
			showError: () => {},
			refreshAutonomyFooterStatus: () => {},
		};

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal");

		expect(statuses[0]).toContain("Goal: none (ask-user/missing_goal_state)");
	});

	it("starts a goal, deterministically seeds one requirement, then asks the model to decompose", async () => {
		const { context, saved, prompts, statuses } = createGoalCommandContext();

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal ship the thing");

		expect(saved[0].userGoal).toBe("ship the thing");
		// The deterministic seed makes the continuation loop drivable even when the model skips
		// decomposition (field incident: goal wedged at finalize/no_open_requirements).
		expect(saved[1]?.requirements).toHaveLength(1);
		expect(saved[1]?.requirements[0]?.text).toBe("ship the thing");
		expect(saved[1]?.requirements[0]?.status).toBe("open");
		expect(prompts[0]).toContain("Use the goal tool this turn to decompose this goal");
		expect(prompts[0]).toContain("satisfy_requirement");
		expect(statuses.at(-1)).toContain("Goal started");
	});

	it("shows lifecycle controls and requirement ids in goal status", async () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "r1", text: "Get access", now: "T1" });
		state = applyGoalEvent(state, { type: "block_requirement", id: "r1", blockedReason: "waiting", now: "T2" });
		const { context, statuses } = createGoalCommandContext(state);

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal status");

		expect(statuses[0]).toContain("r1: blocked — waiting");
		expect(statuses[0]).toContain("/goal complete");
		expect(statuses[0]).toContain("/goal override <text>");
	});

	it("reopens a blocked requirement and resumes its blocked goal in one command", async () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "r1", text: "Get access", now: "T1" });
		state = applyGoalEvent(state, { type: "block_requirement", id: "r1", blockedReason: "waiting", now: "T2" });
		state = applyGoalEvent(state, { type: "block_goal", reason: "waiting", now: "T3" });
		const { context, getState, saved, statuses } = createGoalCommandContext(state);

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal reopen r1");

		expect(saved).toHaveLength(2);
		expect(getState()?.status).toBe("active");
		expect(getState()?.requirements[0].status).toBe("open");
		expect(statuses[0]).toContain("goal resumed");
	});

	it("lets the user manually complete or close a goal without running the model", async () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "r1", text: "Do work", now: "T1" });
		const completion = createGoalCommandContext(state);

		await interactiveModePrototype.handleGoalCommand.call(completion.context, "/goal complete");

		expect(completion.getState()?.status).toBe("completed");
		expect(completion.getState()?.requirements[0].status).toBe("open");
		expect(completion.getContinuationCalls()).toBe(0);

		state = applyGoalEvent(state, { type: "block_goal", reason: "waiting", now: "T2" });
		const closure = createGoalCommandContext(state);
		await interactiveModePrototype.handleGoalCommand.call(closure.context, "/goal close");
		expect(closure.getState()?.status).toBe("cancelled");
		expect(closure.getContinuationCalls()).toBe(0);
	});

	it("lets the user override an active goal explicitly", async () => {
		const state = createGoalState({ goalId: "old", userGoal: "Old goal", now: "T0" });
		const { context, saved, getState, prompts, statuses } = createGoalCommandContext(state);

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal override New goal");

		expect(saved[0].status).toBe("cancelled");
		expect(getState()?.status).toBe("active");
		expect(getState()?.userGoal).toBe("New goal");
		expect(getState()?.requirements).toHaveLength(1);
		expect(prompts).toHaveLength(1);
		expect(statuses.at(-1)).toContain("Goal overridden");
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
