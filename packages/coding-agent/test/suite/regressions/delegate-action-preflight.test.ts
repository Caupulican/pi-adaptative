import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../../../src/core/delegation/worker-agent-control.ts";
import { createDelegateToolDefinition } from "../../../src/core/tools/delegate.ts";
import { wrapToolDefinition } from "../../../src/core/tools/tool-definition-wrapper.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("delegation validation recovery", () => {
	it("classifies a missing wait mode before execution and admits the corrected wait once", async () => {
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [{ agentId: "worker", status: "idle" as const }],
			updatedAgentIds: ["worker"],
			timedOut: false,
		}));
		const tool = wrapToolDefinition(
			createDelegateToolDefinition({
				caller: { kind: "session_root" },
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				// Only the wait port is reachable in this fixture; no worker/provider is started.
				workerAgentControl: { waitForWorkerAgents } as unknown as WorkerAgentControlPort,
			}),
		);
		const execute = vi.fn(tool.execute);
		const harness = await createHarness({ tools: [{ ...tool, execute }] });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{
						action: "wait_many",
						agentIds: ["worker"],
					},
					{ id: "invalid" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{
						action: "wait_many",
						agentIds: ["worker"],
						mode: "all",
					},
					{ id: "corrected" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The worker is idle."),
		]);
		await harness.session.prompt("Wait for the worker to finish.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const rejected = results.find((message) => message.toolCallId === "invalid");
		expect(rejected).toMatchObject({ isError: true });
		expect(getMessageText(rejected)).toContain("invalid_arguments");
		expect(getMessageText(rejected)).toContain("mode");
		expect(execute).toHaveBeenCalledOnce();
		expect(waitForWorkerAgents).toHaveBeenCalledOnce();
		expect(waitForWorkerAgents).toHaveBeenCalledWith(["worker"], "all", undefined);
		expect(results.find((message) => message.toolCallId === "corrected")).toMatchObject({ isError: false });
	});
});
