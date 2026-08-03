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
				"python",
				"edit",
				"write",
				"context_audit",
				"goal",
				"task_steps",
				"ask_question",
				"secret_store",
				"delegate",
				"profile_writer",
				"tool_task",
				"run_toolkit_script",
				"artifact_retrieve",
				"delegate_status",
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
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative's focused coding executor\./);
			expect(harness.session.systemPrompt).not.toContain("N+2 ARCHITECTURE");
			expect(harness.session.systemPrompt.length).toBeLessThanOrEqual(4_096);
			const composition = harness.session.getContextCompositionReport();
			expect(composition.systemPromptTokens + composition.toolSchemaTokens).toBeLessThanOrEqual(
				profile.contextWindow! * 0.35,
			);
			// Prompt shaping is orthogonal to transport selection. An unflagged model still uses
			// provider-native tool calls; capability reduction must never switch on the phone protocol.
			expect(harness.session.agent.textToolCallProtocol).toBeUndefined();
			expect(harness.session.getActiveToolNames()).toEqual([
				"read",
				"bash",
				"python",
				"edit",
				"write",
				"ask_question",
				"run_toolkit_script",
				"artifact_retrieve",
			]);

			// Idle turn with an active goal: neither goal auto-continue nor research may fire.
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("turn done")]);
			await harness.session.prompt("work on the goal");

			expect(getLaneRecordSnapshots(harness.sessionManager.getEntries())).toHaveLength(0);
			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.research?.some((entry) => entry.reasonCode === "model_research_unsupported")).toBe(true);
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
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative's concise chat assistant\./);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an explicitly phone-only small model on the text protocol while using the same minimal prompt", async () => {
		const harness = await createHarness({
			models: [{ id: "phone-only-small", contextWindow: 8_192, textToolCallProtocol: true }],
		});
		try {
			expect(harness.session.getModelCapabilityProfile().class).toBe("minimal");
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative's focused coding executor\./);
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("Use the configured tool protocol.");
			expect(harness.session.agent.textToolCallProtocol).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("blocks an extension from bypassing the constrained prompt budget before the provider call", async () => {
		let providerCalled = false;
		const harness = await createHarness({
			models: [{ id: "small-model", contextWindow: 8_192 }],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}\n${"extension expansion ".repeat(500)}`,
					}));
				},
			],
		});
		try {
			harness.setResponses([
				() => {
					providerCalled = true;
					return fauxAssistantMessage("must not run");
				},
			]);

			await expect(harness.session.prompt("hello")).rejects.toThrow(
				"minimal system prompt exceeds its 4096-character capability budget",
			);
			expect(providerCalled).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("fails visibly instead of silently downgrading images for a text-only model", async () => {
		const harness = await createHarness({ models: [{ id: "text-only", contextWindow: 200_000, input: ["text"] }] });
		try {
			await expect(
				harness.session.prompt("Inspect this image", {
					images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
				}),
			).rejects.toThrow("does not accept image input");
			expect(harness.session.messages).toEqual([]);
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
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative, a self-evolving assistant\./);
			expect(harness.session.systemPrompt).toContain("N+2 ARCHITECTURE");
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
			const delegateSnippet = "Delegate a bounded task to an isolated, least-privilege worker lane.";
			expect(harness.session.systemPrompt).toContain(delegateSnippet);

			await harness.session.setModel(harness.getModel("small-model")!);
			expect(harness.session.getActiveToolNames()).toEqual([
				"read",
				"bash",
				"python",
				"edit",
				"write",
				"ask_question",
				"run_toolkit_script",
				"artifact_retrieve",
			]);
			expect(harness.session.systemPrompt).not.toContain(delegateSnippet);
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative's focused coding executor\./);

			await harness.session.setModel(harness.getModel("big-model")!);
			expect(harness.session.getActiveToolNames()).toEqual(fullSet);
			expect(harness.session.systemPrompt).toMatch(/^You are Pi-Adaptative, a self-evolving assistant\./);
		} finally {
			harness.cleanup();
		}
	});

	it("an internal tool refresh under a small model must not shrink the restorable request", async () => {
		const harness = await createHarness({
			models: [
				{ id: "big-model", contextWindow: 200_000 },
				{ id: "small-model", contextWindow: 8_192 },
			],
		});
		try {
			const fullSet = harness.session.getActiveToolNames();
			await harness.session.setModel(harness.getModel("small-model")!);
			// The same internal no-options refresh that extensions (refreshTools) and memory-init
			// trigger: it must re-derive from the pre-filter REQUEST, or the reduced active set
			// leaks into the request and the later big-model switch restores only the reduced set.
			(harness.session as unknown as { _refreshToolRegistry: () => void })._refreshToolRegistry();
			expect(harness.session.getActiveToolNames()).toEqual([
				"read",
				"bash",
				"python",
				"edit",
				"write",
				"ask_question",
				"run_toolkit_script",
				"artifact_retrieve",
			]);

			await harness.session.setModel(harness.getModel("big-model")!);
			expect(harness.session.getActiveToolNames()).toEqual(fullSet);
		} finally {
			harness.cleanup();
		}
	});

	it("re-derives and restores the capability tool surface when cycling full to small and back", async () => {
		const harness = await createHarness({
			models: [
				{ id: "big-model", contextWindow: 200_000 },
				{ id: "small-model", contextWindow: 8_192 },
			],
		});
		try {
			harness.session.setScopedModels([
				{ model: harness.getModel("big-model")! },
				{ model: harness.getModel("small-model")! },
			]);
			const fullSet = harness.session.getActiveToolNames();
			const firstCycle = await harness.session.cycleModel("forward");
			expect(firstCycle?.model.id).toBe("small-model");
			expect(harness.session.getActiveToolNames()).toEqual([
				"read",
				"bash",
				"python",
				"edit",
				"write",
				"ask_question",
				"run_toolkit_script",
				"artifact_retrieve",
			]);

			const secondCycle = await harness.session.cycleModel("forward");
			expect(secondCycle?.model.id).toBe("big-model");
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
