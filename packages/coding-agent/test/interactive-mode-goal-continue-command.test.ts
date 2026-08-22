import { describe, expect, it } from "vitest";
import type {
	AgentSession,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
} from "../src/core/agent-session.ts";
import { SessionReplacementCallbackError, SessionReplacementRuntimeError } from "../src/core/agent-session-runtime.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { handleResumeSession, type SessionFlowHost } from "../src/modes/interactive/session-flow-commands.ts";

type ParsedGoalContinueCommand = { ok: true; maxTurns: number; maxStallTurns: number } | { ok: false; error: string };

type InteractiveModePrototype = {
	parseGoalContinueCommand(this: unknown, text: string): ParsedGoalContinueCommand;
	handleGoalCommand(this: GoalCommandContext, text: string): Promise<void>;
	handleGoalContinueCommand(this: GoalContinueCommandContext, text: string): Promise<void>;
};

type GoalCommandContext = {
	session: {
		getGoalStateSnapshot: () => GoalState | undefined;
		saveGoalStateSnapshot: (state: GoalState, expected?: { goalId: string; revision: number }) => string;
		clearGoalStateSnapshot: (state: GoalState, now: string) => string;
		restoreGoalRuntimeAfterResume: () => void;
		sendUserMessage: (content: string) => Promise<void>;
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
		getGoalRuntimeSnapshot: (settings: { maxStallTurns: number }) => GoalContinuationLoopResult["finalSnapshot"];
	};
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	refreshAutonomyFooterStatus: () => void;
	refreshActivityLane?: () => void;
	activityLane?: { announce: (message: string, status?: "success" | "failure" | "neutral") => void };
};

type GoalContinueCommandContext = {
	session: {
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
	};
	parseGoalContinueCommand: (text: string) => ParsedGoalContinueCommand;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	refreshAutonomyFooterStatus: () => void;
	refreshActivityLane?: () => void;
	activityLane?: { announce: (message: string, status?: "success" | "failure" | "neutral") => void };
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createLoopResult(overrides?: Partial<GoalContinuationLoopResult>): GoalContinuationLoopResult {
	return {
		turnsSubmitted: 1,
		stopReason: "max_turns_reached",
		finalSnapshot: {
			workerClaims: [],
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
		activityLane: { announce: (message) => statuses.push(message) },
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
	let runtimeRestoreCalls = 0;
	let refreshCount = 0;
	const context: GoalCommandContext = {
		session: {
			getGoalStateSnapshot: () => state,
			saveGoalStateSnapshot: (next) => {
				state = next;
				saved.push(next);
				return "entry";
			},
			clearGoalStateSnapshot: () => {
				state = undefined;
				return "cleared";
			},
			restoreGoalRuntimeAfterResume: () => {
				runtimeRestoreCalls++;
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
		activityLane: { announce: (message) => statuses.push(message) },
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
		getRuntimeRestoreCalls: () => runtimeRestoreCalls,
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
				clearGoalStateSnapshot: () => "cleared",
				restoreGoalRuntimeAfterResume: () => {},
				sendUserMessage: async () => {},
				continueGoalLoop: async () => createLoopResult(),
				getGoalRuntimeSnapshot: () =>
					createLoopResult({
						turnsSubmitted: 0,
						finalSnapshot: {
							workerClaims: [],
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
			activityLane: { announce: (message) => statuses.push(message) },
			refreshAutonomyFooterStatus: () => {},
		};

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal");

		expect(statuses[0]).toContain("Goal: none (ask-user/missing_goal_state)");
	});

	it("starts one compact goal record and continues it through the hidden runtime lane", async () => {
		const { context, saved, prompts, statuses } = createGoalCommandContext();

		await interactiveModePrototype.handleGoalCommand.call(context, "/goal ship the thing");

		expect(saved[0].userGoal).toBe("ship the thing");
		expect(saved).toHaveLength(1);
		expect(saved[0]?.requirements).toEqual([]);
		expect(prompts).toEqual([]);
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

		expect(saved).toHaveLength(1);
		expect(getState()?.status).toBe("active");
		expect(getState()?.requirements[0].status).toBe("open");
		expect(statuses[0]).toContain("goal resumed");
	});

	it("uses the canonical persisted transition for /goal resume", async () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = applyGoalEvent(state, { type: "block_goal", reason: "waiting", now: "T1" });
		const resumed = createGoalCommandContext(state);

		await interactiveModePrototype.handleGoalCommand.call(resumed.context, "/goal resume");

		expect(resumed.saved).toHaveLength(1);
		expect(resumed.getState()?.status).toBe("active");
		expect(resumed.statuses).toEqual(["Goal resumed."]);
		expect(resumed.getRefreshCount()).toBe(1);
		expect(resumed.getRuntimeRestoreCalls()).toBe(1);
	});

	it("automatically resumes a selected session goal stopped by a bounded system guard", async () => {
		let state = applyGoalEvent(createGoalState({ goalId: "g-system", userGoal: "Ship", now: "T0" }), {
			type: "system_stop_goal",
			status: "blocked",
			reason: "runaway_tool_loop: repeated call",
			now: "T1",
		});
		let selectorCalls = 0;
		let refreshCount = 0;
		const statuses: string[] = [];
		const session = {
			getGoalStateSnapshot: () => state,
			saveGoalStateSnapshot: (next: GoalState) => {
				state = next;
				return "entry";
			},
			restoreGoalRuntimeAfterResume: () => {
				state = applyGoalEvent(state, { type: "resume_goal", now: "T2" });
				return true;
			},
		} as unknown as AgentSession;
		const host = {
			session,
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: { switchSession: async () => ({ cancelled: false }) },
			renderCurrentSessionState() {},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => {
				throw new Error(message);
			},
			refreshAutonomyFooterStatus: () => {
				refreshCount++;
			},
			extensionUiHost: {
				showExtensionSelector: async () => {
					selectorCalls++;
					return "Leave stopped";
				},
			},
		} as unknown as SessionFlowHost;

		await handleResumeSession(host, "/tmp/system-stopped-session.jsonl");

		expect(state.status).toBe("active");
		expect(selectorCalls).toBe(0);
		expect(refreshCount).toBe(1);
		expect(statuses).toEqual(["Resumed session and goal"]);
	});

	it("falls back to the owner resume choice when automatic system-block recovery loses a revision race", async () => {
		const state = applyGoalEvent(createGoalState({ goalId: "g-system-race", userGoal: "Ship", now: "T0" }), {
			type: "system_stop_goal",
			status: "blocked",
			reason: "provider_turn_limit: interrupted before recovery",
			now: "T1",
		});
		let selectorCalls = 0;
		let fatalCalls = 0;
		const statuses: string[] = [];
		const session = {
			getGoalStateSnapshot: () => state,
			restoreGoalRuntimeAfterResume: () => false,
		} as unknown as AgentSession;
		const host = {
			session,
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: { switchSession: async () => ({ cancelled: false }) },
			renderCurrentSessionState() {},
			showStatus: (message: string) => statuses.push(message),
			refreshAutonomyFooterStatus() {},
			extensionUiHost: {
				showExtensionSelector: async () => {
					selectorCalls++;
					return "Leave stopped";
				},
			},
			handleFatalRuntimeError: async () => {
				fatalCalls++;
				return { cancelled: true };
			},
		} as unknown as SessionFlowHost;

		const result = await handleResumeSession(host, "/tmp/system-stopped-race-session.jsonl");

		expect(result).toEqual({ cancelled: false });
		expect(state.status).toBe("blocked");
		expect(selectorCalls).toBe(1);
		expect(fatalCalls).toBe(0);
		expect(statuses).toEqual(["Resumed session; goal state preserved"]);
	});

	it("offers an explicit owner choice before resuming a selected session's stopped goal", async () => {
		let previousState = createGoalState({ goalId: "old", userGoal: "Old", now: "T0" });
		previousState = applyGoalEvent(previousState, { type: "block_goal", reason: "old", now: "T1" });
		let replacementState = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		replacementState = applyGoalEvent(replacementState, {
			type: "block_goal",
			reason: "interrupted",
			now: "T1",
		});
		const saved: GoalState[] = [];
		const statuses: string[] = [];
		const phases: string[] = [];
		let refreshCount = 0;
		let runtimeRestoreCount = 0;
		const previousSession = {
			getGoalStateSnapshot: () => previousState,
			saveGoalStateSnapshot: (next: GoalState) => {
				previousState = next;
				return "entry";
			},
			restoreGoalRuntimeAfterResume: () => {},
		} as unknown as AgentSession;
		const replacementSession = {
			getGoalStateSnapshot: () => replacementState,
			saveGoalStateSnapshot: (next: GoalState) => {
				replacementState = next;
				saved.push(next);
				return "entry";
			},
			restoreGoalRuntimeAfterResume: () => {
				runtimeRestoreCount++;
			},
		} as unknown as AgentSession;
		let activeSession = previousSession;
		const switchSession: SessionFlowHost["runtimeHost"]["switchSession"] = async (_path, options) => {
			await options?.beforeSessionResourcesStart?.(replacementSession);
			phases.push(`resources:${replacementState.status}`);
			activeSession = replacementSession;
			await options?.withSession?.({} as never);
			return { cancelled: false };
		};
		const host = {
			get session() {
				return activeSession;
			},
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: { switchSession },
			renderCurrentSessionState() {},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => {
				throw new Error(message);
			},
			refreshAutonomyFooterStatus: () => {
				refreshCount++;
			},
			extensionUiHost: {
				showExtensionSelector: async () => "Resume goal",
			},
		} as unknown as SessionFlowHost;

		await handleResumeSession(host, "/tmp/resumed-session.jsonl", {
			withSession: async () => {
				phases.push("withSession");
			},
		});

		expect(saved).toHaveLength(1);
		expect(previousState.status).toBe("blocked");
		expect(replacementState.status).toBe("active");
		expect(phases).toEqual(["resources:blocked", "withSession"]);
		expect(statuses).toEqual(["Resumed session and goal"]);
		expect(refreshCount).toBe(1);
		expect(runtimeRestoreCount).toBe(1);
	});

	it("leaves a selected session's stopped goal untouched when the owner declines resume", async () => {
		let state = applyGoalEvent(createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" }), {
			type: "pause_goal",
			now: "T1",
		});
		let restoreCalls = 0;
		const session = {
			getGoalStateSnapshot: () => state,
			saveGoalStateSnapshot: (next: GoalState) => {
				state = next;
				return "entry";
			},
			restoreGoalRuntimeAfterResume: () => {
				restoreCalls++;
			},
		} as unknown as AgentSession;
		const statuses: string[] = [];
		const host = {
			session,
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: { switchSession: async () => ({ cancelled: false }) },
			renderCurrentSessionState() {},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => {
				throw new Error(message);
			},
			refreshAutonomyFooterStatus() {},
			extensionUiHost: { showExtensionSelector: async () => "Leave stopped" },
		} as unknown as SessionFlowHost;

		await handleResumeSession(host, "/tmp/resumed-session.jsonl");

		expect(state.status).toBe("paused");
		expect(restoreCalls).toBe(0);
		expect(statuses).toEqual(["Resumed session; goal state preserved"]);
	});

	it("keeps a restored previous session alive when selected-session activation fails", async () => {
		const errors: string[] = [];
		let renderCount = 0;
		let fatalCount = 0;
		const host = {
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: {
				switchSession: async () => {
					throw new SessionReplacementRuntimeError("activation", new Error("supervisor failed"), true);
				},
			},
			renderCurrentSessionState: () => {
				renderCount++;
			},
			showStatus() {},
			showError: (message: string) => errors.push(message),
			refreshAutonomyFooterStatus() {},
			handleFatalRuntimeError: async () => {
				fatalCount++;
				throw new Error("unexpected fatal replacement failure");
			},
		} as unknown as SessionFlowHost;

		await expect(handleResumeSession(host, "/tmp/failed-session.jsonl")).resolves.toEqual({ cancelled: true });
		expect(renderCount).toBe(1);
		expect(fatalCount).toBe(0);
		expect(errors).toEqual([
			"Session replacement activation failed; the previous session was restored: supervisor failed",
		]);
	});

	it("keeps the replacement selected when its extension continuation fails", async () => {
		const errors: string[] = [];
		let renderCount = 0;
		let fatalCount = 0;
		const host = {
			loadingAnimation: undefined,
			statusContainer: { clear() {} },
			runtimeHost: {
				switchSession: async () => {
					throw new SessionReplacementCallbackError(new Error("continuation failed"));
				},
			},
			renderCurrentSessionState: () => {
				renderCount++;
			},
			showStatus() {},
			showError: (message: string) => errors.push(message),
			refreshAutonomyFooterStatus() {},
			handleFatalRuntimeError: async () => {
				fatalCount++;
				throw new Error("unexpected fatal callback failure");
			},
		} as unknown as SessionFlowHost;

		await expect(handleResumeSession(host, "/tmp/selected-session.jsonl")).resolves.toEqual({ cancelled: false });
		expect(renderCount).toBe(1);
		expect(fatalCount).toBe(0);
		expect(errors).toEqual([
			"Session replacement completed, but its withSession callback failed: continuation failed",
		]);
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

		expect(saved).toHaveLength(1);
		expect(saved[0].status).toBe("active");
		expect(getState()?.status).toBe("active");
		expect(getState()?.userGoal).toBe("New goal");
		expect(getState()?.requirements).toHaveLength(0);
		expect(prompts).toHaveLength(0);
		expect(statuses.at(-1)).toContain("Goal overridden");
	});

	it("defaults to unbounded and preserves explicit safe-integer limits", () => {
		expect(interactiveModePrototype.parseGoalContinueCommand("/goal-continue")).toEqual({
			ok: true,
			maxTurns: 0,
			maxStallTurns: 20,
			maxWallClockMinutes: 0,
		});
		expect(interactiveModePrototype.parseGoalContinueCommand("/goal-continue 7 0")).toEqual({
			ok: true,
			maxTurns: 7,
			maxStallTurns: 0,
			maxWallClockMinutes: 0,
		});
		expect(interactiveModePrototype.parseGoalContinueCommand("/goal-continue 1000 0")).toEqual({
			ok: true,
			maxTurns: 1000,
			maxStallTurns: 0,
			maxWallClockMinutes: 0,
		});
	});

	it("rejects invalid arguments", () => {
		const invalid = [
			"/goal-continue -1",
			"/goal-continue 9007199254740992",
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
			createLoopResult({ stopReason: "max_turns_reached", turnsSubmitted: 2 }),
		);

		await interactiveModePrototype.handleGoalContinueCommand.call(context, "/goal-continue 2 10");

		expect(calls).toEqual([{ maxTurns: 2, maxStallTurns: 10, maxWallClockMinutes: 0 }]);
		expect(statuses[0]).toContain("Goal continuation started");
		expect(statuses[1]).toContain("max_turns_reached");
		expect(statuses[1]).toContain("submitted 2 turn(s)");
		expect(errors).toEqual([]);
		expect(getRefreshCount()).toBe(1);
	});

	it("shows an error and does not run for invalid arguments", async () => {
		const { context, calls, errors, getRefreshCount } = createContext();

		await interactiveModePrototype.handleGoalContinueCommand.call(context, "/goal-continue -1");

		expect(calls).toEqual([]);
		expect(errors).toEqual([
			"Usage: /goal-continue [maxTurns 0=unbounded] [maxStallTurns 0-100] [maxMinutes 0-1440]",
		]);
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
