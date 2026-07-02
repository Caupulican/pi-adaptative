import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

function seedActiveGoal(harness: Awaited<ReturnType<typeof createHarness>>): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
	state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Keep working", now: "T0" });
	appendGoalStateSnapshot(harness.sessionManager, state);
}

function countContinuationPrompts(harness: Awaited<ReturnType<typeof createHarness>>): number {
	return getUserTexts(harness).filter((text) => text.includes("Goal continuation context")).length;
}

describe("AgentSession goal idle autosteer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("injects the default 20 continuation prompts after an idle turn while the goal advances", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			const responses = [fauxAssistantMessage("initial turn settled")];
			for (let i = 1; i <= 20; i++) {
				responses.push(
					fauxAssistantMessage(
						[fauxToolCall("goal", { action: "add_requirement", requirementId: `auto-${i}`, text: `Auto ${i}` })],
						{ stopReason: "toolUse" },
					),
				);
				responses.push(fauxAssistantMessage(`continued ${i}`));
			}
			harness.setResponses(responses);

			await harness.session.prompt("start the task");
			await vi.runAllTimersAsync();

			expect(countContinuationPrompts(harness)).toBe(20);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("caps a lean-window model (16-32k) at 2 continuation turns even when more would advance the goal", async () => {
		const harness = await createHarness({ models: [{ id: "lean-model", contextWindow: 16_384 }] });
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("lean");
			seedActiveGoal(harness);

			// Supply enough turns to run well past the lean cap: if the budget were the default 20,
			// all four continuation turns would fire. The cap must stop it at 2.
			const responses = [fauxAssistantMessage("initial turn settled")];
			for (let i = 1; i <= 4; i++) {
				responses.push(
					fauxAssistantMessage(
						[fauxToolCall("goal", { action: "add_requirement", requirementId: `auto-${i}`, text: `Auto ${i}` })],
						{ stopReason: "toolUse" },
					),
				);
				responses.push(fauxAssistantMessage(`continued ${i}`));
			}
			harness.setResponses(responses);

			await harness.session.prompt("start the task");
			await vi.runAllTimersAsync();

			expect(countContinuationPrompts(harness)).toBe(2);
			// Responses for the untaken turns remain unconsumed: the loop stopped on the budget, not exhaustion.
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

			expect(countContinuationPrompts(harness)).toBe(0);
			expect(getUserTexts(harness)).toEqual(["manual continuation prompt"]);
		} finally {
			harness.cleanup();
		}
	});
});
