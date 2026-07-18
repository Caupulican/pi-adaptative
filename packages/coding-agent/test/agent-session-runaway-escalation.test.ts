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
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
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

	it("records a session-log entry and feeds the model router's existing escalation gate", async () => {
		const harness = await createHarness();
		try {
			const modelRouter = (harness.session as unknown as { _modelRouter: { maybeEscalateToolCall: unknown } })
				._modelRouter;
			const escalateSpy = vi.spyOn(
				modelRouter as { maybeEscalateToolCall: (toolName: string, args: unknown) => unknown },
				"maybeEscalateToolCall",
			);

			const event: ToolValidationEscalationEvent = {
				tool: "write",
				signature: "write::sig-1",
				repeats: 3,
				model: harness.getModel().id,
				provider: harness.getModel().provider,
			};
			harness.session.agent.onToolValidationEscalation?.(event);

			expect(escalateSpy).toHaveBeenCalledWith("write", undefined);

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

	it("reuses the model router's existing cheap-route escalation policy verbatim (no new policy)", async () => {
		const harness = await createHarness();
		try {
			const session = harness.session as unknown as {
				_modelRouter: { _activeModelRouterRoute?: RouteDecision };
			};
			const cheapRoute: RouteDecision = {
				tier: "cheap",
				risk: "read-only",
				confidence: 1,
				reasonCode: "test_cheap_route",
				reasons: [],
			};

			// A mutating tool ("write") on an active cheap route: shouldEscalateModelRouterTool (already
			// covered by test/model-router-tool-escalation.test.ts) says escalate, which aborts the run.
			session._modelRouter._activeModelRouterRoute = cheapRoute;
			const abortSpy = vi.spyOn(harness.session.agent, "abort");
			harness.session.agent.onToolValidationEscalation?.({
				tool: "write",
				signature: "write::sig-mutating",
				repeats: 3,
				model: harness.getModel().id,
				provider: harness.getModel().provider,
			});
			expect(abortSpy).toHaveBeenCalledTimes(1);

			// A read-only tool on the same active cheap route: the existing policy does not escalate it,
			// so this handler must not invent an escalation either.
			abortSpy.mockClear();
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
