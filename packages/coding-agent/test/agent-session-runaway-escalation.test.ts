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

	it("records a repeated-tool guard and keeps the active goal eligible for enforced recovery", async () => {
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

			const recovered = harness.session.getGoalStateSnapshot();
			expect(recovered).toMatchObject({
				goalId: "goal-runaway",
				status: "active",
				blockedReason: undefined,
			});
			const guard = recovered?.events.findLast((event) => event.type === "system_stop_goal");
			expect(guard).toMatchObject({
				type: "system_stop_goal",
				reason: expect.stringContaining("runaway_tool_loop"),
			});
			expect(guard).toMatchObject({ reason: expect.stringContaining("tool_task:{wait}") });
			expect(recovered?.events.at(-1)?.type).toBe("resume_goal");

			const result = await harness.session.continueGoalOnce({ maxStallTurns: 20 });
			expect(result.submitted).toBe(true);
			expect(result.snapshot.continuation.action).toBe("continue");
			expect(prompt).toHaveBeenCalledOnce();
		} finally {
			harness.cleanup();
		}
	});

	it("keeps enforcing recovery across consecutive bounded guards instead of terminalizing the goal", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-repeated-recovery", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);

			for (let attempt = 0; attempt < 2; attempt++) {
				harness.session.agent.onRunawayStop?.({
					reason: "repeated_tool_call",
					signature: "bash:{same-failed-probe}",
					repeats: 12,
				});
				expect(harness.session.getGoalStateSnapshot()?.status).toBe("active");
			}

			const eventTypes = harness.session.getGoalStateSnapshot()?.events.map((event) => event.type) ?? [];
			expect(eventTypes.filter((type) => type === "system_stop_goal")).toHaveLength(2);
			expect(eventTypes.filter((type) => type === "resume_goal")).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});

	it("does not require an owner chat turn after automatic runaway recovery", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-runaway-resume", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.session.agent.onRunawayStop?.({
				reason: "repeated_tool_call",
				signature: "tool_task:{wait}",
				repeats: 12,
			});
			expect(harness.session.getGoalStateSnapshot()?.status).toBe("active");

			harness.setResponses([fauxAssistantMessage("audit resumed")]);
			await harness.session.prompt("continue the audit", { autoContinueGoal: false });

			const resumed = harness.session.getGoalStateSnapshot();
			expect(resumed).toMatchObject({ goalId: "goal-runaway-resume", status: "active" });
			const eventTypes = resumed?.events.map((event) => event.type) ?? [];
			expect(eventTypes.lastIndexOf("system_stop_goal")).toBeLessThan(eventTypes.lastIndexOf("resume_goal"));
			expect(eventTypes.filter((type) => type === "resume_goal")).toHaveLength(1);
			expect(JSON.stringify(harness.session.messages)).toContain("runaway-recovery");
			expect(JSON.stringify(harness.session.messages)).toContain(
				"Do not repeat the same failed operation unchanged",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("automatically resumes and schedules a runaway-guard-blocked goal when its session runtime is restored", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		try {
			harness.settingsManager.setAutonomySettings({
				goalAutoContinue: true,
				goalAutoContinueDelayMs: 100,
				goalContinueTurns: 1,
				goalContinueMaxWallClockMinutes: 0,
				maxStallTurns: 1,
			});
			harness.setResponses([fauxAssistantMessage("automatic continuation resumed")]);
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-runaway-restore", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(
				applyGoalEvent(state, {
					type: "system_stop_goal",
					status: "blocked",
					reason: "runaway_tool_loop: interrupted before process exit",
					now: "T1",
				}),
			);
			expect(harness.session.getGoalStateSnapshot()?.status).toBe("blocked");

			expect(harness.session.restoreGoalRuntimeAfterResume()).toBe(true);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-runaway-restore",
				status: "active",
			});
			await vi.advanceTimersToNextTimerAsync();
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
			vi.useRealTimers();
		}
	});

	it("does not override an explicit goal blocker when ordinary owner chat continues", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				applyGoalEvent(
					createGoalState({ goalId: "goal-owner-blocked", userGoal: "Wait for approval", now: "T0" }),
					{ type: "add_requirement", id: "approval", text: "Obtain approval", now: "T0" },
				),
				{ type: "block_goal", reason: "Waiting for explicit publication approval", now: "T1" },
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.setResponses([fauxAssistantMessage("still waiting")]);

			await harness.session.prompt("status update", { autoContinueGoal: false });

			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-owner-blocked",
				status: "blocked",
				blockedReason: "Waiting for explicit publication approval",
			});
			expect(harness.session.restoreGoalRuntimeAfterResume()).toBe(false);
			expect(harness.session.getGoalStateSnapshot()?.status).toBe("blocked");
		} finally {
			harness.cleanup();
		}
	});

	it("warns instead of swallowing a new explicit owner goal while recovering a system-blocked goal", async () => {
		const harness = await createHarness();
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-system-blocked", userGoal: "Finish the prior audit", now: "T0" }),
				{
					type: "system_stop_goal",
					status: "blocked",
					reason: "runaway_tool_loop: interrupted before recovery",
					now: "T1",
				},
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.setResponses([fauxAssistantMessage("prior audit resumed")]);

			await harness.session.prompt("Set a persistent goal: ship a different objective.", {
				autoContinueGoal: false,
			});

			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-system-blocked",
				status: "active",
			});
			expect(
				harness
					.eventsOfType("warning")
					.some((event) => event.message.includes("unfinished goal 'goal-system-blocked'")),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("records and reports an explicit provider-turn fuse without mislabeling it as an identical-tool loop", async () => {
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
			expect(warnings.at(-1)?.message).toContain("configured provider-turn limit");
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
			const recovered = harness.session.getGoalStateSnapshot();
			expect(recovered).toMatchObject({
				goalId: "goal-provider-fuse",
				status: "active",
				blockedReason: undefined,
			});
			expect(recovered?.events.findLast((event) => event.type === "system_stop_goal")).toMatchObject({
				reason: expect.stringContaining("provider_turn_limit"),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("lets a late worker terminal wake work after automatic runaway recovery", async () => {
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
				status: "active",
			});

			resolveForeground(fauxAssistantMessage("Foreground released after runaway stop."));
			await foregroundRun;
			await handoff;

			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
			expect(JSON.stringify(harness.session.messages)).toContain("LATE HANDOFF RESURRECTED");
			const completion = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "background-worker-completion");
			expect(completion).toMatchObject({ type: "custom_message" });
			expect(completion && "content" in completion ? String(completion.content) : "").not.toContain(
				"do not continue or replan automatically",
			);
		} finally {
			unsubscribe();
			if (!foregroundResolved) resolveForeground(fauxAssistantMessage("Test cleanup."));
			harness.cleanup();
		}
	});

	it("keeps an active goal open when one unchanged failed operation is repeatedly refused", async () => {
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
			expect(harness.getPendingResponseCount()).toBe(0);
			const assistantText = harness.session.messages
				.flatMap((message) =>
					message.role === "assistant"
						? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
						: [],
				)
				.join("\n");
			expect(assistantText).toContain("The tool failure requires owner action.");
			const goal = harness.session.getGoalStateSnapshot();
			expect(goal).toMatchObject({ goalId: "goal-recovery" });
			expect(goal?.status).not.toBe("blocked");
			expect(goal?.blockedReason ?? "").not.toContain("terminal_tool_failure");
		} finally {
			harness.cleanup();
		}
	});

	it("still blocks an active goal when a tool explicitly terminates with an error", async () => {
		let executions = 0;
		const terminalTool: AgentTool = {
			name: "terminal_tool",
			label: "Terminal Tool",
			description: "Explicitly terminates the current tool batch",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return {
					content: [{ type: "text", text: "backend revoked this session" }],
					details: {},
					isError: true,
					terminate: true,
				};
			},
		};
		const harness = await createHarness({ tools: [terminalTool] });
		try {
			const state = applyGoalEvent(
				createGoalState({ goalId: "goal-terminal", userGoal: "Finish the audit", now: "T0" }),
				{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
			);
			harness.session.saveGoalStateSnapshot(state);
			harness.session.agent.maxStallTurns = 0;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("terminal_tool", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("unreachable wrap-up"),
			]);

			await harness.session.prompt("go", { autoContinueGoal: false });

			expect(executions).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-terminal",
				status: "blocked",
				blockedReason: expect.stringContaining("terminal_tool_failure: terminal_tool"),
			});
			expect(harness.session.restoreGoalRuntimeAfterResume()).toBe(false);
			expect(harness.session.getGoalStateSnapshot()?.status).toBe("blocked");
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
