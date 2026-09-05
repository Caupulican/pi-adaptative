import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

describe("delegate follow-up diagnostics", () => {
	it.each(["session_root", "worker"] as const)(
		"preserves %s follow-up refusal and exact accepted message identity",
		async (kind) => {
			const followUp = vi.fn<WorkerAgentControlPort["followUpWorkerAgent"]>();
			const tool = createDelegateToolDefinition({
				caller: kind === "worker" ? { kind, agentId: "parent-worker" } : { kind },
				resolveMessageReplayScope: () => ({ sessionId: "session", branchId: "branch" }),
				runWorkerDelegation: async () => ({ started: false }),
				workerAgentControl: {
					followUpWorkerAgent: followUp,
					followUpSessionRootWorkerAgent: followUp,
				} as unknown as WorkerAgentControlPort,
			});
			followUp.mockReturnValueOnce({
				started: false,
				steering: false,
				messageId: "worker-message-current-review",
				skipReason: "worker_task_waiting_for_older_message",
			});
			const queued = await tool.execute(
				"current-review",
				{ action: "follow_up", agentId: "worker-reviewer", message: "Review the new document." },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(queued.isError).not.toBe(true);
			expect(queued.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("worker_task_waiting_for_older_message") }),
			]);
			expect(queued.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("worker-message-current-review not started") }),
			]);
			expect(queued.content).toEqual([
				expect.objectContaining({
					text: expect.stringContaining(
						"An idle worker or an older task report does not prove this message completed",
					),
				}),
			]);
			expect(queued.details).toMatchObject({ started: false, messageId: "worker-message-current-review" });

			expect(followUp).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["session_root", "worker"] as const)("does not advertise a refused %s follow-up as queued", async (kind) => {
		const followUp = vi.fn<WorkerAgentControlPort["followUpWorkerAgent"]>().mockReturnValue({
			started: false,
			steering: false,
			messageId: "",
			skipReason: "agent_retired",
		});
		const tool = createDelegateToolDefinition({
			caller: kind === "worker" ? { kind, agentId: "parent-worker" } : { kind },
			resolveMessageReplayScope: () => ({ sessionId: "session", branchId: "branch" }),
			runWorkerDelegation: async () => ({ started: false }),
			workerAgentControl: {
				followUpWorkerAgent: followUp,
				followUpSessionRootWorkerAgent: followUp,
			} as unknown as WorkerAgentControlPort,
		});
		const refused = await tool.execute(
			"retired-review",
			{ action: "follow_up", agentId: "worker-reviewer", message: "Review after retirement." },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(refused.isError).toBe(true);
		expect(refused.content).toEqual([expect.objectContaining({ text: expect.stringContaining("agent_retired") })]);
		expect(refused.details).toMatchObject({ started: false, skipReason: "agent_retired" });
		expect(followUp).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ started: true, steering: false, messageId: "worker-message-running", state: "started" },
		{ started: false, steering: true, messageId: "worker-message-steering", state: "steering queued" },
		{
			started: false,
			steering: false,
			messageId: "worker-message-finalized",
			state: "not started",
			skipReason: "worker_message_already_finalized",
		},
	])("retains the $state negative control without inventing a refusal", async ({ state, ...outcome }) => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: () => ({ sessionId: "session", branchId: "branch" }),
			runWorkerDelegation: async () => ({ started: false }),
			workerAgentControl: {
				followUpSessionRootWorkerAgent: () => outcome,
			} as unknown as WorkerAgentControlPort,
		});
		const result = await tool.execute(
			"accepted-follow-up",
			{ action: "follow_up", agentId: "worker-reviewer", message: "Continue review." },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining(`${outcome.messageId} ${state}`) }),
		]);
		expect(result.details).toMatchObject({ started: outcome.started, messageId: outcome.messageId });
		if (outcome.skipReason) {
			expect(result.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining(outcome.skipReason) }),
			]);
		}
	});
});
