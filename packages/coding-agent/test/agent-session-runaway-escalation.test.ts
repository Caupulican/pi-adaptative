import type { AgentTool, ToolValidationEscalationEvent } from "@caupulican/pi-agent-core";
import type { CustomEntry } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	RUNAWAY_STOP_CUSTOM_TYPE,
	type RunawayStopRecord,
	TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE,
	type ToolValidationEscalationRecord,
} from "../src/core/agent-session.ts";
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
			settings: { autonomy: { maxStallTurns: 2 } },
		});
		try {
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
