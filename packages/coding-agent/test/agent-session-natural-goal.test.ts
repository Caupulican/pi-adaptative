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

	it("starts a durable goal when the owner replaces the approach with I-want-to-refactor", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("goal is active")]);
			await harness.session.prompt("instead of trace and fix, i want to refactor what is in place", {
				autoContinueGoal: false,
			});
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				status: "active",
				userGoal: "refactor what is in place",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("starts a durable goal from handover language using the previous user task", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("noted the task"), fauxAssistantMessage("goal is active")]);
			await harness.session.prompt("finish the mixed-surface generator so water and mountain stay present", {
				autoContinueGoal: false,
			});
			expect(harness.session.getGoalStateSnapshot()).toBeUndefined();

			await harness.session.prompt(
				"this is a goal by the way, i'm handing over to you, use max 2 sub agents to help you deliver. You are the orchestrator and also reviewer and team lead",
				{ autoContinueGoal: false },
			);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				status: "active",
				userGoal: "finish the mixed-surface generator so water and mountain stay present",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("starts a durable goal when the owner later says the stated task is a goal", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("noted the task"), fauxAssistantMessage("goal is active")]);
			await harness.session.prompt("Implement the inspect wording so workers can start without a profile.", {
				autoContinueGoal: false,
			});
			expect(harness.session.getGoalStateSnapshot()).toBeUndefined();

			await harness.session.prompt("this is a goal", { autoContinueGoal: false });
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				status: "active",
				userGoal: "Implement the inspect wording so workers can start without a profile.",
			});
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
