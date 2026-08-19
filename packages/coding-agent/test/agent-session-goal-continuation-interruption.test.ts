import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function seedOpenGoal(harness: Harness): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Finish the interrupted task", now: "T0" });
	state = applyGoalEvent(state, {
		type: "add_requirement",
		id: "req-1",
		text: "Finish the requested work",
		now: "T0",
	});
	appendGoalStateSnapshot(harness.sessionManager, state);
}

describe("goal continuation interruption containment", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops a manual continuation loop after its first aborted provider turn", async () => {
		const harness = await createHarness();
		seedOpenGoal(harness);
		harness.settingsManager.setAutonomySettings({ goalAutoContinue: false });
		harness.setResponses(
			Array.from({ length: 20 }, () =>
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Operation aborted" }),
			),
		);

		const result = await harness.session.continueGoalLoop({
			maxTurns: 20,
			maxStallTurns: 20,
			maxWallClockMinutes: 0,
		});

		expect(result).toMatchObject({ stopReason: "turn_interrupted", turnsSubmitted: 1 });
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({
			status: "active",
			continuationTurnsUsed: 1,
			stallTurns: 1,
		});
	});

	it("continues across successful provider turns as a negative control", async () => {
		const harness = await createHarness();
		seedOpenGoal(harness);
		harness.settingsManager.setAutonomySettings({ goalAutoContinue: false });
		harness.setResponses([fauxAssistantMessage("first pass"), fauxAssistantMessage("second pass")]);

		const result = await harness.session.continueGoalLoop({
			maxTurns: 2,
			maxStallTurns: 20,
			maxWallClockMinutes: 0,
		});

		expect(result).toMatchObject({ stopReason: "max_turns_reached", turnsSubmitted: 2 });
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not schedule goal autosteer after an aborted foreground turn", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		seedOpenGoal(harness);
		harness.settingsManager.setAutonomySettings({
			goalAutoContinue: true,
			goalAutoContinueDelayMs: 0,
			goalContinueTurns: 20,
			goalContinueMaxWallClockMinutes: 0,
			maxStallTurns: 20,
		});
		harness.setResponses(
			Array.from({ length: 21 }, () =>
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Operation aborted" }),
			),
		);

		await harness.session.prompt("foreground work");
		await vi.runAllTimersAsync();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({ status: "active", continuationTurnsUsed: 0 });
	});

	it("still schedules goal autosteer after a successful foreground turn", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		seedOpenGoal(harness);
		harness.settingsManager.setAutonomySettings({
			goalAutoContinue: true,
			goalAutoContinueDelayMs: 0,
			goalContinueTurns: 1,
			goalContinueMaxWallClockMinutes: 0,
			maxStallTurns: 1,
		});
		harness.setResponses([
			fauxAssistantMessage("foreground complete"),
			fauxAssistantMessage("continuation complete"),
		]);

		await harness.session.prompt("foreground work");
		await vi.runAllTimersAsync();

		expect(harness.faux.state.callCount).toBe(2);
	});
});
