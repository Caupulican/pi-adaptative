/**
 * The goal-continuation single-flight mutex.
 *
 * Before this fix, idle autosteer (`BackgroundLaneController._runScheduledGoalAutoContinue`,
 * armed with a 0ms timer at every real `prompt()`'s tail) and a manual `session.continueGoalLoop`
 * call (e.g. `/goal start`, `/goal-continue`) could both submit continuation prompts through the
 * same `AgentSession.prompt` concurrently. The second submission hit the `isStreaming &&
 * !streamingBehavior` guard and threw "Agent is already processing" — caught (as a warning) on the
 * idle path, but UNHANDLED on the manual path (`/goal start` had no try/catch).
 *
 * `BackgroundLaneController.continueGoalLoopExclusive` is now the single owner of that mutex:
 * every entry point (idle timer AND `AgentSession.continueGoalLoop`, which BOTH `/goal start` and
 * `/goal-continue` call) is routed through it, so at most one loop is ever in flight per session.
 *
 * Two levels of coverage:
 *  - Deterministic guard-mechanics tests drive `BackgroundLaneController` directly with a
 *    controllable (never-resolving-until-released) `continueGoalLoop` dep, matching the existing
 *    hand-rolled-deps pattern in background-lane-controller.test.ts /
 *    background-lane-disposal-persistence.test.ts.
 *  - An end-to-end test drives a REAL `AgentSession` (via the shared harness) so the actual
 *    production wiring (agent-session.ts:~990 raw-loop deps wiring, ~5180 public delegation) is
 *    exercised, not just the guard in isolation.
 */
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { GoalContinuationLoopResult } from "../src/core/agent-session.ts";
import { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import type { GoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

function makeSnapshot(goalId: string): GoalRuntimeSnapshot {
	return {
		goalState: createGoalState({ goalId, userGoal: "Ship the mutex fix", now: "T0" }),
		workerResults: [],
		learningDecisions: [],
		continuation: {
			action: "continue",
			reasonCode: "goal_active",
			message: "The goal is active and making progress.",
			openRequirementIds: ["req-1"],
			blockedRequirementIds: [],
			satisfiedRequirementIds: [],
		},
	};
}

describe("BackgroundLaneController.continueGoalLoopExclusive (guard mechanics)", () => {
	it("returns already_continuing with a full snapshot for a second call racing an in-flight loop, and invokes the raw loop exactly once", async () => {
		let releaseFirst: ((result: GoalContinuationLoopResult) => void) | undefined;
		const firstCallResult = new Promise<GoalContinuationLoopResult>((resolve) => {
			releaseFirst = resolve;
		});
		let rawLoopCalls = 0;

		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getGoalRuntimeSnapshot: () => makeSnapshot("g1"),
			continueGoalLoop: () => {
				rawLoopCalls++;
				return firstCallResult;
			},
		} as never);

		const firstPromise = controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 20 });
		// Races the still-in-flight first call: `_isGoalAutoContinuing` was already set synchronously
		// before the first call's `await`, so this must be skipped rather than invoking the raw loop.
		const secondResult = await controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 20 });

		expect(secondResult.stopReason).toBe("already_continuing");
		expect(secondResult.turnsSubmitted).toBe(0);
		// A FULL result, not a stub: the skip path still resolves the current goal runtime snapshot.
		expect(secondResult.finalSnapshot.goalState?.goalId).toBe("g1");
		expect(secondResult.finalSnapshot.continuation.action).toBe("continue");
		expect(rawLoopCalls).toBe(1);

		releaseFirst?.({ turnsSubmitted: 1, stopReason: "max_turns_reached", finalSnapshot: makeSnapshot("g1") });
		const firstResult = await firstPromise;
		expect(firstResult.stopReason).toBe("max_turns_reached");
		expect(firstResult.turnsSubmitted).toBe(1);
	});

	it("refuses to start after dispose but only once an already in-flight pass has drained (dispose mid-continuation -> session_disposed, no throw)", async () => {
		let disposed = false;
		let releaseFirst: ((result: GoalContinuationLoopResult) => void) | undefined;
		const firstCallResult = new Promise<GoalContinuationLoopResult>((resolve) => {
			releaseFirst = resolve;
		});

		const controller = new BackgroundLaneController({
			isDisposed: () => disposed,
			getGoalRuntimeSnapshot: () => makeSnapshot("g1"),
			continueGoalLoop: () => firstCallResult,
		} as never);

		const firstPromise = controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 20 });

		// Dispose happens WHILE the first pass is still in flight (mirrors `abortInFlightLanes()`
		// running synchronously inside `dispose()` while a continuation prompt is mid-await).
		disposed = true;

		// A call racing the still in-flight pass sees the mutex first, not disposal — the mutex check
		// is evaluated before the disposal check.
		const racingDuringDispose = await controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 20 });
		expect(racingDuringDispose.stopReason).toBe("already_continuing");

		// The in-flight pass drains normally; its `finally` clears `_isGoalAutoContinuing`.
		releaseFirst?.({ turnsSubmitted: 1, stopReason: "max_turns_reached", finalSnapshot: makeSnapshot("g1") });
		await expect(firstPromise).resolves.toEqual(
			expect.objectContaining({ stopReason: "max_turns_reached", turnsSubmitted: 1 }),
		);

		// The mutex is free again, but the session is disposed: the guard now refuses to START a new
		// continuation instead of throwing or attempting to submit another prompt.
		const afterDispose = await controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 20 });
		expect(afterDispose.stopReason).toBe("session_disposed");
		expect(afterDispose.turnsSubmitted).toBe(0);
	});
});

function seedOpenGoal(harness: Awaited<ReturnType<typeof createHarness>>): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship the mutex fix", now: "T0" });
	state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Requirement 1", now: "T0" });
	appendGoalStateSnapshot(harness.sessionManager, state);
}

function countContinuationPrompts(harness: Awaited<ReturnType<typeof createHarness>>): number {
	return getUserTexts(harness).filter((text) => text.includes("Goal continuation context")).length;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 5): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("waitUntil: condition was never satisfied within the timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

describe("AgentSession goal-continuation single-flight mutex (end-to-end)", () => {
	it("serializes a racing idle auto-continue and a manual continueGoalLoop call: exactly one drives, the other returns already_continuing, no unhandled rejection or double-processing warning", async () => {
		const harness = await createHarness();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			seedOpenGoal(harness);

			let idlePassStarted = false;
			let releaseIdlePass: (() => void) | undefined;
			const idleGate = new Promise<void>((resolve) => {
				releaseIdlePass = resolve;
			});

			harness.setResponses([
				fauxAssistantMessage("initial turn settled"),
				async () => {
					idlePassStarted = true;
					await idleGate;
					// Plain text, no tool call: the goal state does not advance, so the idle-triggered
					// loop stops after exactly this one pass (`goal_state_not_advanced`) -- no further
					// queued responses are needed.
					return fauxAssistantMessage("idle continuation pass settled");
				},
			]);

			// Real user turn: settles immediately and, at its tail, arms the 0ms idle goal-continuation
			// timer (DEFAULT_GOAL_AUTO_CONTINUE=true, DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS=0).
			await harness.session.prompt("start the task");

			// Real (not fake) timers: let the 0ms timer fire and drive the idle-triggered continuation
			// into the gated faux call, so it genuinely holds the mutex while suspended mid-pass.
			await waitUntil(() => idlePassStarted);

			// Manual continueGoalLoop races the idle pass that is still in flight. Both go through the
			// SAME public entry point (AgentSession.continueGoalLoop -> BackgroundLaneController.
			// continueGoalLoopExclusive), so the mutex must serialize them instead of both submitting
			// prompts concurrently.
			const manualResult: GoalContinuationLoopResult = await harness.session.continueGoalLoop({
				maxTurns: 1,
				maxStallTurns: 20,
				maxWallClockMinutes: 0,
			});

			expect(manualResult.stopReason).toBe("already_continuing");
			expect(manualResult.turnsSubmitted).toBe(0);
			// A FULL snapshot, not a stub result.
			expect(manualResult.finalSnapshot.goalState?.goalId).toBe("g1");
			expect(manualResult.finalSnapshot.continuation).toBeDefined();

			// Let the idle-triggered pass complete.
			releaseIdlePass?.();
			await waitUntil(() => countContinuationPrompts(harness) >= 1);
			// Drain trailing microtasks so the idle loop's own `finally` has cleared the mutex flag.
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Exactly one loop actually submitted a continuation prompt.
			expect(countContinuationPrompts(harness)).toBe(1);

			expect(unhandledRejections).toEqual([]);
			const warnings = harness.eventsOfType("warning");
			expect(warnings.some((event) => event.message.includes("already processing"))).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			harness.cleanup();
		}
	});

	it("returns session_disposed without throwing when continueGoalLoop is called after the session is disposed", async () => {
		const harness = await createHarness();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			seedOpenGoal(harness);

			harness.session.dispose();

			const result = await harness.session.continueGoalLoop({
				maxTurns: 1,
				maxStallTurns: 20,
				maxWallClockMinutes: 0,
			});
			expect(result.stopReason).toBe("session_disposed");
			expect(result.turnsSubmitted).toBe(0);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			harness.cleanup();
		}
	});
});
