import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

/**
 * Seeds `requirementCount` open requirements (req-1..req-N). Callers that drive multiple
 * continuation turns satisfy one requirement per turn (genuine progress, so the goal-loop's
 * progress signature — satisfied-requirement count — actually advances) and seed one extra
 * requirement beyond the turn budget so at least one stays open and the continuation decision
 * never flips to "finalize" mid-run.
 */
function seedActiveGoal(harness: Awaited<ReturnType<typeof createHarness>>, requirementCount = 1): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
	for (let i = 1; i <= requirementCount; i++) {
		state = applyGoalEvent(state, { type: "add_requirement", id: `req-${i}`, text: `Requirement ${i}`, now: "T0" });
	}
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
			// One extra requirement (21) beyond the 20-turn budget so a requirement stays open
			// through every turn while the other 20 get genuinely satisfied, one per turn.
			seedActiveGoal(harness, 21);
			const responses = [fauxAssistantMessage("initial turn settled")];
			for (let i = 1; i <= 20; i++) {
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

			expect(countContinuationPrompts(harness)).toBe(20);
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

			expect(countContinuationPrompts(harness)).toBe(0);
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

			expect(countContinuationPrompts(harness)).toBe(0);
			expect(getUserTexts(harness)).toEqual(["manual continuation prompt"]);
		} finally {
			harness.cleanup();
		}
	});
});
