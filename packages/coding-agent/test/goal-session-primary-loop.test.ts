import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import type { ObjectiveExecutionController } from "../src/core/objective-execution/index.ts";
import type { ObjectiveRoute, ObjectiveTerminalResult } from "../src/core/objective-execution/objective-route.ts";

/** A scripted objective controller: each cycle takes the next step of the script. */
function scriptedController(
	steps: readonly (
		| { kind: "root"; route: ObjectiveRoute["route"] }
		| { kind: "worker"; route: ObjectiveRoute["route"] }
		| { kind: "wait" }
		| { kind: "terminal"; terminal: ObjectiveTerminalResult }
	)[],
) {
	let index = 0;
	let rootExecutor: { execute(route: ObjectiveRoute, signal?: AbortSignal): Promise<void> } | undefined;
	let lastRoute: ObjectiveRoute | undefined;
	const routed: string[] = [];
	const route = (name: ObjectiveRoute["route"]): ObjectiveRoute => ({
		schema_version: "1.0",
		cycle_id: `c${index}`,
		objective_id: "goal:g1",
		route: name,
		reason_codes: ["scripted"],
		target_requirement_ids: ["r1"],
	});
	const controller = {
		getMode: () => "objective_primary" as const,
		bindSessionExecutors: (executors: { rootExecutor?: typeof rootExecutor }) => {
			rootExecutor = executors.rootExecutor ?? rootExecutor;
		},
		getLastRoute: () => lastRoute,
		runCycles: async (_objectiveId: string, _max: number): Promise<ObjectiveTerminalResult | undefined> => {
			const step = steps[index++];
			if (!step) throw new Error("script exhausted");
			if (step.kind === "terminal") return step.terminal;
			lastRoute = route(step.kind === "wait" ? "wait_for_worker" : step.route);
			routed.push(lastRoute.route);
			if (step.kind === "root") await rootExecutor?.execute(lastRoute);
			return undefined;
		},
	};
	return { controller: controller as unknown as ObjectiveExecutionController, routed };
}

/** An assistant turn as the session records it after a prompt; `errorMessage` names an abort. */
function assistantTurn(stopReason: "stop" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-responses",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	} as AssistantMessage;
}

function session(
	controller: ObjectiveExecutionController,
	prompts: string[],
	options: {
		afterPrompt?: (sessionManager: SessionManager, text: string) => void;
		warnings?: string[];
		ownerItems?: string[];
	} = {},
) {
	const sessionManager = SessionManager.inMemory();
	let ordinal = 0;
	const goals = new GoalSessionController({
		getSessionManager: () => sessionManager,
		getModelProvider: () => undefined,
		getLaneRecords: () => [],
		getTaskRuntimeSnapshot: () => ({ lastOrdinal: ordinal }) as never,
		getBackgroundToolTasks: () => [],
		synchronizeGoalState: () => {},
		scheduleGoalAutoContinueFromIdle: () => {},
		prompt: async (text) => {
			prompts.push(text);
			ordinal++;
			options.afterPrompt?.(sessionManager, text);
		},
		emitWarning: (message) => {
			options.warnings?.push(message);
		},
		deliverToOwner: (items) => {
			options.ownerItems?.push(...items);
		},
		getExecutionLoopMode: () => "objective_primary",
		getObjectiveExecutionController: () => controller,
	});
	let goal = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "2026-09-21T00:00:00.000Z" });
	goal = applyGoalEvent(goal, {
		type: "add_requirement",
		id: "r1",
		text: "tests pass",
		now: "2026-09-21T00:00:00.000Z",
	});
	goals.saveState(goal);
	return goals;
}

describe("System One primary loop", () => {
	it("runs routed root turns with the route brief, stops on a wait, and follows the objective's terminal", async () => {
		const prompts: string[] = [];
		const { controller, routed } = scriptedController([
			{ kind: "root", route: "implement" },
			{ kind: "root", route: "verify" },
			{ kind: "wait" },
		]);
		const goals = session(controller, prompts);
		const loop = await goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(routed).toEqual(["implement", "verify", "wait_for_worker"]);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toMatch(/^System One route: implement \(scripted\)\. Target requirements: r1\./);
		expect(prompts[1]).toContain("System One route: verify");
		expect(loop).toMatchObject({ turnsSubmitted: 2, stopReason: "worker_in_flight" });
		expect(goals.getState()?.status).toBe("active");
	});

	it("a System One cancel of the root turn re-routes at the next cycle; the operator's interruption stops the loop", async () => {
		const prompts: string[] = [];
		const warnings: string[] = [];
		const rerouted = scriptedController([
			{ kind: "root", route: "implement" },
			{ kind: "root", route: "verify" },
			{ kind: "wait" },
		]);
		const goals = session(rerouted.controller, prompts, {
			warnings,
			afterPrompt: (sessionManager) => {
				// The first root turn is cancelled by System One (a named abort); the second completes.
				sessionManager.appendMessage(
					prompts.length === 1
						? assistantTurn("aborted", "Operation aborted (system_one:replan: off the current step)")
						: assistantTurn("stop"),
				);
			},
		});
		const loop = await goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(rerouted.routed).toEqual(["implement", "verify", "wait_for_worker"]);
		expect(loop).toMatchObject({ turnsSubmitted: 2, stopReason: "worker_in_flight" });
		expect(warnings).toEqual(["System One re-routed the root turn: replan: off the current step"]);

		const interrupted = scriptedController([
			{ kind: "root", route: "implement" },
			{ kind: "root", route: "verify" },
		]);
		const stopped = session(interrupted.controller, [], {
			afterPrompt: (sessionManager) => {
				sessionManager.appendMessage(assistantTurn("aborted", "Operation aborted"));
			},
		});
		const halted = await stopped.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(interrupted.routed).toEqual(["implement"]);
		expect(halted).toMatchObject({ stopReason: "turn_interrupted" });
		expect(stopped.getState()?.status).toBe("active");
	});

	it("stops at the turn limit, and blocks the goal when the objective ends unrecoverable", async () => {
		const prompts: string[] = [];
		const { controller } = scriptedController([
			{ kind: "root", route: "implement" },
			{ kind: "root", route: "implement" },
			{ kind: "terminal", terminal: { status: "unrecoverable", reasonCodes: ["missing_required_executor:x"] } },
		]);
		const goals = session(controller, prompts);
		expect(await goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 })).toMatchObject({
			turnsSubmitted: 1,
			stopReason: "max_turns_reached",
		});
		const rest = await goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(rest).toMatchObject({ turnsSubmitted: 1, stopReason: "continuation_not_allowed" });
		expect(goals.getState()?.status).toBe("blocked");
		expect(goals.getState()?.blockedReason).toContain("unrecoverable: missing_required_executor:x");
	});

	it("asks the owner when System One cannot settle a completion check, and not when it is only down", async () => {
		const ownerItems: string[] = [];
		const ambiguous = scriptedController([
			{
				kind: "terminal",
				terminal: {
					status: "semantic_gate_unavailable",
					reasonCodes: ["system_one_ambiguous", "jev_026_ambiguous", "hidden_regressions"],
				},
			},
		]);
		const goals = session(ambiguous.controller, [], { ownerItems });
		await goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 });
		expect(goals.getState()?.status).toBe("blocked");
		expect(ownerItems).toEqual([
			"System One could not settle the objective's cold adversarial challenge check (hidden_regressions), so the goal is held open: say whether to accept it as complete, or what is still missing.",
		]);

		const outageItems: string[] = [];
		const outage = scriptedController([
			{
				kind: "terminal",
				terminal: {
					status: "semantic_gate_unavailable",
					reasonCodes: ["system_one_required_but_unavailable", "jev_025_unavailable"],
				},
			},
		]);
		const held = session(outage.controller, [], { ownerItems: outageItems });
		await held.continueLoop({ maxTurns: 1, maxStallTurns: 3 });
		expect(held.getState()?.blockedReason).toContain("jev_025_unavailable");
		expect(outageItems).toEqual([]);
	});

	it("completes the goal from a complete terminal only when its requirements are satisfied, else blocks and says why", async () => {
		const prompts: string[] = [];
		const { controller } = scriptedController([
			{ kind: "terminal", terminal: { status: "complete", reasonCodes: ["completion_passed"] } },
		]);
		const goals = session(controller, prompts);
		await goals.continueOnce({ maxStallTurns: 3 });
		expect(goals.getState()?.status).toBe("blocked");
		expect(goals.getState()?.blockedReason).toContain("requirements r1 are not marked satisfied");

		const { controller: second } = scriptedController([
			{ kind: "terminal", terminal: { status: "complete", reasonCodes: ["completion_passed"] } },
		]);
		const satisfied = session(second, prompts);
		const state = satisfied.getState()!;
		satisfied.saveState(
			applyGoalEvent(state, {
				type: "satisfy_requirement",
				id: "r1",
				evidenceIds: [],
				now: "2026-09-21T00:00:01.000Z",
			}),
		);
		await satisfied.continueOnce({ maxStallTurns: 3 });
		expect(satisfied.getState()?.status).toBe("completed");
	});

	it("stops a pass after two cycles that executed nothing instead of spinning", async () => {
		const prompts: string[] = [];
		const { controller } = scriptedController([
			{ kind: "worker", route: "review" },
			{ kind: "worker", route: "review" },
			{ kind: "worker", route: "review" },
		]);
		const goals = session(controller, prompts);
		const loop = await goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(loop).toMatchObject({ turnsSubmitted: 0, stopReason: "continuation_not_allowed" });
		expect(prompts).toEqual([]);
	});
});
