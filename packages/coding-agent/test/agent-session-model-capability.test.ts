import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function seedActiveGoal(harness: Harness): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" });
	state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Do the thing", now: "T0" });
	appendGoalStateSnapshot(harness.sessionManager, state);
}

describe("model capability auto-detection", () => {
	it("keeps the full default tool set on a large-window model", async () => {
		const harness = await createHarness({ models: [{ id: "big-model", contextWindow: 200_000 }] });
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("full");
			expect(harness.session.getActiveToolNames()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"context_audit",
				"goal",
				"delegate",
				"run_toolkit_script",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("reduces an 8k model to the minimal coding set and disables background lanes", async () => {
		const harness = await createHarness({
			models: [{ id: "small-model", contextWindow: 8_192 }],
			settings: { researchLane: { enabled: true }, autonomy: { mode: "balanced" } },
		});
		try {
			const profile = harness.session.getModelCapabilityProfile();
			expect(profile.class).toBe("minimal");
			expect(profile.backgroundLanesEnabled).toBe(false);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

			// Idle turn with an active goal: neither goal auto-continue nor research may fire.
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("turn done")]);
			await harness.session.prompt("work on the goal");

			expect(getLaneRecordSnapshots(harness.sessionManager.getEntries())).toHaveLength(0);
			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.research?.some((entry) => entry.reasonCode === "model_context_too_small")).toBe(true);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("strips all tools on a chat-class (<8k) model", async () => {
		const harness = await createHarness({ models: [{ id: "tiny-model", contextWindow: 4_096 }] });
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("chat");
			expect(harness.session.getActiveToolNames()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("mode off disables detection entirely", async () => {
		const harness = await createHarness({
			models: [{ id: "tiny-model", contextWindow: 4_096 }],
			settings: { modelCapability: { mode: "off" } },
		});
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("full");
			expect(harness.session.getActiveToolNames()).toContain("goal");
		} finally {
			harness.cleanup();
		}
	});

	it("re-derives the tool surface on model switch and restores it on the way back", async () => {
		const harness = await createHarness({
			models: [
				{ id: "big-model", contextWindow: 200_000 },
				{ id: "small-model", contextWindow: 8_192 },
			],
		});
		try {
			const fullSet = harness.session.getActiveToolNames();
			expect(fullSet).toContain("goal");
			const delegateSnippet = "Delegate a bounded read-only analysis subtask";
			expect(harness.session.systemPrompt).toContain(delegateSnippet);

			await harness.session.setModel(harness.getModel("small-model")!);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			expect(harness.session.systemPrompt).not.toContain(delegateSnippet);

			await harness.session.setModel(harness.getModel("big-model")!);
			expect(harness.session.getActiveToolNames()).toEqual(fullSet);
		} finally {
			harness.cleanup();
		}
	});

	it("scales lane output tokens from the lane model's own window", async () => {
		const harness = await createHarness({
			models: [{ id: "mid-model", contextWindow: 16_384 }],
			settings: { researchLane: { enabled: true }, autonomy: { mode: "balanced" } },
		});
		try {
			seedActiveGoal(harness);
			let seenMaxTokens: number | undefined;
			harness.setResponses([
				(_context, options) => {
					seenMaxTokens = options?.maxTokens;
					return fauxAssistantMessage('{"findings":[]}');
				},
			]);

			const outcome = await harness.session.runResearchLaneOnce();
			expect(outcome.started).toBe(true);
			expect(seenMaxTokens).toBe(2_048);
		} finally {
			harness.cleanup();
		}
	});
});

describe("lane model inheritance", () => {
	it("lanes inherit the session model even when a router cheap model is configured", async () => {
		const harness = await createHarness({
			models: [{ id: "session-model", contextWindow: 200_000 }],
			settings: {
				researchLane: { enabled: true },
				autonomy: { mode: "balanced" },
				modelRouter: { enabled: true, cheapModel: "provider/does-not-resolve" },
			},
		});
		try {
			seedActiveGoal(harness);
			let laneModelId: string | undefined;
			harness.setResponses([
				(_context, _options, _state, model) => {
					laneModelId = model.id;
					return fauxAssistantMessage('{"findings":[{"summary":"inherited"}]}');
				},
			]);

			const outcome = await harness.session.runResearchLaneOnce();
			expect(outcome.started).toBe(true);
			expect(outcome.record?.status).toBe("succeeded");
			expect(laneModelId).toBe("session-model");
		} finally {
			harness.cleanup();
		}
	});
});
