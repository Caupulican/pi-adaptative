import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts } from "./suite/harness.ts";

describe("AgentSession natural-language goal admission", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists an explicit chat goal but ignores meta-discussion", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("explained"), fauxAssistantMessage("started")]);
			const discussion =
				"it's an issue to notice if the goal has been set via text chat without using the goal slash command";
			await harness.session.prompt(discussion, { autoContinueGoal: false });
			expect(harness.session.getGoalStateSnapshot()).toBeUndefined();

			await harness.session.prompt("Set a persistent goal: preserve efficient compaction and goal continuation.", {
				autoContinueGoal: false,
			});
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				status: "active",
				userGoal: "preserve efficient compaction and goal continuation.",
			});
			expect(getUserTexts(harness)).toEqual([
				discussion,
				"Set a persistent goal: preserve efficient compaction and goal continuation.",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("feeds an admitted chat goal into the existing hidden continuation loop", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("initial turn settled"),
				fauxAssistantMessage([fauxToolCall("goal", { action: "complete" })], { stopReason: "toolUse" }),
			]);

			await harness.session.prompt("Keep working until this is complete: prove chat goal continuation.");
			await vi.runAllTimersAsync();

			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				status: "completed",
				userGoal: "prove chat goal continuation.",
				continuationTurnsUsed: 1,
			});
			// The constant continuation trigger is custom/hidden and never becomes fake user history.
			expect(getUserTexts(harness)).toEqual(["Keep working until this is complete: prove chat goal continuation."]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
