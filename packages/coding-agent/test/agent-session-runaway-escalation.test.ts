import type { AgentTool, ToolValidationEscalationEvent } from "@caupulican/pi-agent-core";
import type { CustomEntry } from "@caupulican/pi-agent-core/node";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	RUNAWAY_STOP_CUSTOM_TYPE,
	type RunawayStopRecord,
	TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE,
	type ToolValidationEscalationRecord,
} from "../src/core/agent-session.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * onRunawayStop and onToolValidationEscalation fire in the agent loop (agent-loop.ts) but,
 * before this change, had no host handler — runaway stops were silent and validation escalation
 * never reached the model router. See docs/bug-ledger.md #130.
 */
describe("AgentSession runaway-stop and tool-validation-escalation handlers", () => {
	it("logs, records telemetry, and warns when the runaway-loop backstop trips", async () => {
		const stuckTool: AgentTool = {
			name: "stuck_tool",
			label: "Stuck Tool",
			description: "Always called with the same arguments",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const harness = await createHarness({
			tools: [stuckTool],
		});
		try {
			// This test exercises the core identical-call backstop directly. The autonomy
			// maxStallTurns setting belongs to goal continuation and must not configure it.
			harness.session.agent.maxStallTurns = 2;
			// The faux provider always returns the identical tool call; the backstop must stop the run
			// well before all queued responses are consumed.
			harness.setResponses(
				Array.from({ length: 8 }, () =>
					fauxAssistantMessage(fauxToolCall("stuck_tool", { value: "stuck" }), { stopReason: "toolUse" }),
				),
			);

			await harness.session.prompt("go");

			const warnings = harness.eventsOfType("warning");
			expect(warnings.some((event) => event.message.includes("repeated the same tool call"))).toBe(true);

			const entries = harness.sessionManager.getEntries();
			const runawayEntry = entries.find(
				(entry): entry is CustomEntry<RunawayStopRecord> =>
					entry.type === "custom" && entry.customType === RUNAWAY_STOP_CUSTOM_TYPE,
			);
			expect(runawayEntry).toBeDefined();
			expect(runawayEntry?.data?.repeats).toBe(2);
			expect(runawayEntry?.data?.signature).toBeTruthy();
			expect(harness.getPendingResponseCount()).toBeGreaterThan(0); // stopped early, did not drain the queue
		} finally {
			harness.cleanup();
		}
	});

	it("assigns a real onToolValidationEscalation handler onto the agent (was always undefined)", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.agent.onRunawayStop).toBeTypeOf("function");
			expect(harness.session.agent.onToolValidationEscalation).toBeTypeOf("function");
		} finally {
			harness.cleanup();
		}
	});

	it("blocks an active goal when the runaway backstop trips so auto-continuation cannot restart it", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-runaway", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);
			const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(undefined);

			harness.session.agent.onRunawayStop?.({
				reason: "repeated_tool_call",
				signature: "tool_task:{wait}",
				repeats: 12,
			});

			const blocked = harness.session.getGoalStateSnapshot();
			expect(blocked).toMatchObject({
				goalId: "goal-runaway",
				status: "blocked",
			});
			expect(blocked?.blockedReason).toContain("runaway_tool_loop");
			expect(blocked?.blockedReason).toContain("tool_task:{wait}");

			const result = await harness.session.continueGoalOnce({ maxStallTurns: 20 });
			expect(result.submitted).toBe(false);
			expect(result.snapshot.continuation.action).toBe("ask-user");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	it("records and reports the provider-turn cost fuse without mislabeling it as an identical-tool loop", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-provider-fuse", userGoal: "Finish varied work", now: "T0" }),
				{ type: "add_requirement", id: "work", text: "Complete the work", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);

			harness.session.agent.onRunawayStop?.({
				reason: "provider_turn_limit",
				signature: "provider_turn_limit",
				repeats: 20,
			});

			const warnings = harness.eventsOfType("warning");
			expect(warnings.at(-1)?.message).toContain("provider-turn cost limit");
			expect(warnings.at(-1)?.message).not.toContain("repeated the same tool call");

			const entry = harness.sessionManager
				.getEntries()
				.find(
					(candidate): candidate is CustomEntry<RunawayStopRecord> =>
						candidate.type === "custom" && candidate.customType === RUNAWAY_STOP_CUSTOM_TYPE,
				);
			expect(entry?.data).toMatchObject({
				reason: "provider_turn_limit",
				signature: "provider_turn_limit",
				repeats: 20,
			});
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-provider-fuse",
				status: "blocked",
				blockedReason: expect.stringContaining("provider_turn_limit"),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("persists a late worker terminal without waking a goal blocked by runaway detection", async () => {
		const harness = await createHarness();
		let resolveForeground: (message: AssistantMessage) => void = () => {};
		let foregroundResolved = false;
		const foregroundResponse = new Promise<AssistantMessage>((resolve) => {
			resolveForeground = (message) => {
				foregroundResolved = true;
				resolve(message);
			};
		});
		let signalForegroundStarted!: () => void;
		let signalWorkerTerminal!: () => void;
		let signalHandoff!: () => void;
		const foregroundStarted = new Promise<void>((resolve) => {
			signalForegroundStarted = resolve;
		});
		const workerTerminal = new Promise<void>((resolve) => {
			signalWorkerTerminal = resolve;
		});
		const handoff = new Promise<void>((resolve) => {
			signalHandoff = resolve;
		});
		const heldForegroundResponse: FauxResponseFactory = () => {
			signalForegroundStarted();
			return foregroundResponse;
		};
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some((record) => record.laneId === "worker-late")
			) {
				signalWorkerTerminal();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-worker-completion"
			) {
				signalHandoff();
			}
		});
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-runaway-worker", userGoal: "Finish delegated work", now: "T0" }),
				{ type: "add_requirement", id: "delegated", text: "Review delegated evidence", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.setResponses([heldForegroundResponse, fauxAssistantMessage("LATE HANDOFF RESURRECTED")]);
			const foregroundRun = harness.session.prompt("Keep foreground occupied", { autoContinueGoal: false });
			await foregroundStarted;
			const backgroundLanes = (
				harness.session as unknown as {
					_backgroundLanes: {
						_recordWorkerTerminal(record: {
							laneId: string;
							type: "worker";
							status: "succeeded";
							goalId: string;
						}): void;
					};
				}
			)._backgroundLanes;
			backgroundLanes._recordWorkerTerminal({
				laneId: "worker-late",
				type: "worker",
				status: "succeeded",
				goalId: "goal-runaway-worker",
			});
			await workerTerminal;
			harness.session.agent.onRunawayStop?.({
				reason: "repeated_tool_call",
				signature: "read:loop",
				repeats: 12,
			});
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-runaway-worker",
				status: "blocked",
			});

			resolveForeground(fauxAssistantMessage("Foreground released after runaway stop."));
			await foregroundRun;
			await handoff;

			expect(harness.getPendingResponseCount()).toBe(1);
			expect(JSON.stringify(harness.session.messages)).not.toContain("LATE HANDOFF RESURRECTED");
			const completion = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "background-worker-completion");
			expect(completion).toMatchObject({
				type: "custom_message",
				content: expect.stringContaining("do not continue or replan automatically"),
			});
		} finally {
			unsubscribe();
			if (!foregroundResolved) resolveForeground(fauxAssistantMessage("Test cleanup."));
			harness.cleanup();
		}
	});

	it("blocks an active goal when the tool-failure recovery circuit terminates the run", async () => {
		let executions = 0;
		const failingTool: AgentTool = {
			name: "failing_tool",
			label: "Failing Tool",
			description: "Always fails",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				executions++;
				throw new Error("Credential profile is unavailable.");
			},
		};
		const harness = await createHarness({ tools: [failingTool] });
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-recovery", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.session.agent.maxStallTurns = 0;
			harness.setResponses([
				...Array.from({ length: 4 }, () =>
					fauxAssistantMessage(fauxToolCall("failing_tool", { value: "same" }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("The tool failure requires owner action."),
			]);

			await harness.session.prompt("go", { autoContinueGoal: false });

			expect(executions).toBe(1);
			// Terminal recovery is delivered locally; the queued provider-authored wrap-up is never
			// purchased after the circuit has already proved that the operation cannot recover.
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-recovery",
				status: "blocked",
				blockedReason: expect.stringContaining("terminal_tool_failure: failing_tool"),
			});
		} finally {
			harness.cleanup();
		}
	});

	// The faux harness's default model resolves as local/managed (its baseUrl is a localhost-family
	// URL — see isLocalOrManagedRouterModel in model-router/tool-escalation.ts), so under the
	// capability-gate spine (see capability-gate-spine.test.ts for the full doctrine
	// coverage, including a genuinely cloud-shaped fixture) it routes a validation-escalation event
	// to the evidence-gated native→phone auto-probe, never to the model router.
	it("records a session-log entry and, for the local/managed harness model, fires the evidence-gated auto-probe instead of the model router", async () => {
		const harness = await createHarness();
		try {
			const session = harness.session as unknown as {
				_probeToolCallingForModel: (model: unknown) => Promise<unknown>;
			};
			const probeSpy = vi.spyOn(session, "_probeToolCallingForModel").mockResolvedValue({
				model: `${harness.getModel().provider}/${harness.getModel().id}`,
				verdict: "none",
				nativeGrade: "absent",
			});

			const event: ToolValidationEscalationEvent = {
				tool: "write",
				signature: "write::sig-1",
				repeats: 3,
				model: harness.getModel().id,
				provider: harness.getModel().provider,
			};
			harness.session.agent.onToolValidationEscalation?.(event);

			expect(probeSpy).toHaveBeenCalledTimes(1);
			await probeSpy.mock.results[0]?.value;

			const entries = harness.sessionManager.getEntries();
			const escalationEntry = entries.find(
				(entry): entry is CustomEntry<ToolValidationEscalationRecord> =>
					entry.type === "custom" && entry.customType === TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE,
			);
			expect(escalationEntry).toBeDefined();
			expect(escalationEntry?.data).toMatchObject({
				tool: "write",
				signature: "write::sig-1",
				repeats: 3,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("never aborts the turn for a local/managed model's validation failure, regardless of tool mutation status", async () => {
		const harness = await createHarness();
		try {
			const session = harness.session as unknown as {
				_probeToolCallingForModel: (model: unknown) => Promise<unknown>;
			};
			vi.spyOn(session, "_probeToolCallingForModel").mockResolvedValue({
				model: `${harness.getModel().provider}/${harness.getModel().id}`,
				verdict: "none",
				nativeGrade: "absent",
			});
			const abortSpy = vi.spyOn(harness.session.agent, "abort");

			// A mutating tool: previously, this reused the beforeToolCall mutation gate and could abort
			// a cheap-route session. A local/managed model now never touches the model router at all —
			// it auto-probes instead, so abort is never called from this path.
			harness.session.agent.onToolValidationEscalation?.({
				tool: "write",
				signature: "write::sig-mutating",
				repeats: 3,
				model: harness.getModel().id,
				provider: harness.getModel().provider,
			});
			expect(abortSpy).not.toHaveBeenCalled();

			// A read-only tool: same outcome — the branch is decided by model class, not tool name.
			harness.session.agent.onToolValidationEscalation?.({
				tool: "read",
				signature: "read::sig-readonly",
				repeats: 3,
				model: harness.getModel().id,
				provider: harness.getModel().provider,
			});
			expect(abortSpy).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
});
