import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

function seedActiveGoal(harness: Awaited<ReturnType<typeof createHarness>>, requirementCount = 1): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
	for (let i = 1; i <= requirementCount; i++) {
		state = applyGoalEvent(state, { type: "add_requirement", id: `req-${i}`, text: `Requirement ${i}`, now: "T0" });
	}
	appendGoalStateSnapshot(harness.sessionManager, state);
}

describe("AgentSession goal idle autosteer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("continues past the retired 20-turn ceiling until the goal reaches a real terminal state", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			const responses = [fauxAssistantMessage("initial turn settled")];
			for (let i = 1; i <= 21; i++) responses.push(fauxAssistantMessage(`continued ${i}`));
			responses.push(
				fauxAssistantMessage([fauxToolCall("goal", { action: "block_goal", reason: "owner input required" })], {
					stopReason: "toolUse",
				}),
			);
			harness.setResponses(responses);

			await harness.session.prompt("start the task");
			await vi.runAllTimersAsync();

			expect(harness.session.getGoalStateSnapshot()?.continuationTurnsUsed).toBe(22);
			expect(harness.session.getGoalStateSnapshot()?.status).toBe("blocked");
			// Hidden continuation triggers never pollute persisted user history.
			expect(getUserTexts(harness)).toEqual(["start the task"]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("a lean-window model (16-32k) gets NO autosteer continuation: its surface lacks the goal tool, so the loop skips goal_tool_unavailable", async () => {
		const harness = await createHarness({ models: [{ id: "lean-model", contextWindow: 16_384 }] });
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("lean");
			// The lean capability blocklist removes the goal tool from the active surface entirely
			// ("adaptative must prevail": sub-full models are not driven through complex agentic
			// loops they cannot execute) -- so autosteer must not submit ANY continuation prompt,
			// not merely fewer. The pre-blocklist behavior (a reduced 2-turn budget) is retired.
			expect(harness.session.getActiveToolNames()).not.toContain("goal");
			seedActiveGoal(harness, 5);

			const responses = [fauxAssistantMessage("initial turn settled")];
			for (let i = 1; i <= 4; i++) {
				responses.push(
					fauxAssistantMessage(
						[fauxToolCall("goal", { action: "satisfy_requirement", requirementId: `req-${i}` })],
						{ stopReason: "toolUse" },
					),
				);
				responses.push(fauxAssistantMessage(`continued ${i}`));
			}
			harness.setResponses(responses);

			await harness.session.prompt("start the task");
			await vi.runAllTimersAsync();

			expect(harness.session.getGoalStateSnapshot()?.continuationTurnsUsed).toBe(0);
			// Every continuation response remains unconsumed: the loop never started.
			expect(harness.getPendingResponseCount()).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not auto-inject continuation prompts when autoContinueGoal is false", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("manual continuation settled")]);

			await harness.session.prompt("manual continuation prompt", { autoContinueGoal: false });
			await vi.runAllTimersAsync();

			expect(harness.session.getGoalStateSnapshot()?.continuationTurnsUsed).toBe(0);
			expect(getUserTexts(harness)).toEqual(["manual continuation prompt"]);
		} finally {
			harness.cleanup();
		}
	});
});
