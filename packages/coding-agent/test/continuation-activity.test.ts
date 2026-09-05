import { describe, expect, it, vi } from "vitest";
import { BackgroundLaneController } from "../src/core/background-lane-controller.ts";

describe("continuation activity authority", () => {
	it("notifies when an armed goal is cancelled or becomes ineligible without submitting another model turn", async () => {
		vi.useFakeTimers();
		let enabled = true;
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () => ({
				getAutonomySettings: () => ({ maxStallTurns: 3, goalAutoContinue: enabled, goalAutoContinueDelayMs: 10 }),
			}),
			getGoalRuntimeSnapshot: () => ({ continuation: { action: "continue" } }),
		} as never);
		const states: boolean[] = [];
		const off = controller.subscribeIdleContinuationActivity(() =>
			states.push(controller.hasPendingIdleContinuation()),
		);
		try {
			controller.scheduleGoalAutoContinueFromIdle();
			expect(states.at(-1)).toBe(true);
			controller.clearGoalAutoContinueTimer();
			expect(states.at(-1)).toBe(false);
			controller.scheduleGoalAutoContinueFromIdle();
			enabled = false;
			await vi.advanceTimersByTimeAsync(10);
			expect(states.at(-1)).toBe(false);
			off();
			const count = states.length;
			enabled = true;
			controller.scheduleGoalAutoContinueFromIdle();
			expect(states).toHaveLength(count);
		} finally {
			controller.clearGoalAutoContinueTimer();
			vi.useRealTimers();
		}
	});
	it("reports manual continuation release even when its loop fails", async () => {
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			isForegroundBusy: () => false,
			continueGoalLoop: async () => {
				throw new Error("loop failed");
			},
		} as never);
		const states: boolean[] = [];
		controller.subscribeIdleContinuationActivity(() => states.push(controller.hasPendingIdleContinuation()));
		await expect(controller.continueGoalLoopExclusive({ maxTurns: 1, maxStallTurns: 3 })).rejects.toThrow(
			"loop failed",
		);
		expect(states).toEqual([true, false]);
	});
});
