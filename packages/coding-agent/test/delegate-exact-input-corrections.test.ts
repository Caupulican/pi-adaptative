import { describe, expect, it, vi } from "vitest";
// Imported by path so the pipeline proof always reads THIS checkout's kernel, matching the drift
// pin in `untrusted-envelope-failure-memory.test.ts`.
import { assessToolFailure } from "../../agent/src/tool-failure-memory.ts";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { wrapUntrustedText } from "../src/core/security/untrusted-boundary.ts";
import { createDelegateToolDefinition, type DelegateToolDetails } from "../src/core/tools/delegate.ts";

const context = {
	sessionManager: {
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
	},
} as unknown as ExtensionContext;

const fixedReplayScope = () => ({ sessionId: "session-1", branchId: "leaf-1" });

function delegateText(result: Awaited<ReturnType<ReturnType<typeof createDelegateToolDefinition>["execute"]>>): string {
	return (
		result.content.find((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")?.text ?? ""
	);
}

function workerAgentControl(overrides: Partial<WorkerAgentControlPort>): WorkerAgentControlPort {
	return {
		listWorkerAgents: () => [],
		getWorkerTaskSessionView: () => ({ totalTasks: 0, omittedTaskCount: 0, tasks: [] }),
		getWorkerAgentActivity: () => "unknown",
		readWorkerAgentTranscript: (agentId) => ({
			agentId,
			cursor: 0,
			totalMessages: 0,
			messages: [],
			omittedMessages: 0,
			serializedBytes: 2,
		}),
		sendWorkerAgentMessage: () => ({ messageId: "unused", queued: true }),
		followUpWorkerAgent: () => ({ started: false, steering: false, messageId: "unused" }),
		sendSessionRootWorkerAgentMessage: () => ({ messageId: "unused", queued: true }),
		followUpSessionRootWorkerAgent: () => ({ started: false, steering: false, messageId: "unused" }),
		replyToWorkerAgentMessage: () => ({ destination: "session_root", messageId: "unused" }),
		listSessionRootReplies: () => [],
		waitForSessionRootReplies: async () => ({ replies: [], timedOut: true }),
		acknowledgeSessionRootReply: () => false,
		reconcileSessionRootReplies: () => undefined,
		startWorkerAgentTask: () => ({ started: false, steering: false, messageId: "", skipReason: "unknown_agent" }),
		interruptWorkerAgent: () => ({ interrupted: false }),
		resumeWorkerAgent: () => ({ started: false }),
		cancelWorkerAgent: () => undefined,
		waitForWorkerAgent: async () => ({ status: "unknown", timedOut: false }),
		waitForWorkerAgents: async () => ({ statuses: [], updatedAgentIds: [], timedOut: false }),
		broadcastWorkerAgentMessage: () => ({ results: [] }),
		retireWorkerAgent: (agentId) => ({
			agent: {
				agentId,
				rootAgentId: agentId,
				depth: 0,
				role: "explorer",
				status: "retired",
				activity: "idle",
				controllable: true,
				createdAt: "T0",
				updatedAt: "T1",
			},
			retired: true,
			replayed: false,
		}),
		...overrides,
	};
}

function controlSpies() {
	const cancelWorkerAgent = vi.fn(() => ({ laneId: "lane-1", type: "worker" as const, status: "canceled" as const }));
	const interruptWorkerAgent = vi.fn(() => ({ interrupted: true }));
	const resumeWorkerAgent = vi.fn(() => ({ started: true }));
	const retireWorkerAgent = vi.fn((agentId: string) => ({
		agent: {
			agentId,
			rootAgentId: agentId,
			depth: 0,
			role: "explorer" as const,
			status: "retired" as const,
			activity: "idle" as const,
			controllable: true,
			createdAt: "T0",
			updatedAt: "T1",
		},
		retired: true as const,
		replayed: false,
	}));
	const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
	const followUpSessionRootWorkerAgent = vi.fn(() => ({
		started: true,
		steering: false as const,
		messageId: "message-1",
	}));
	const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-2", queued: true as const }));
	return {
		cancelWorkerAgent,
		interruptWorkerAgent,
		resumeWorkerAgent,
		retireWorkerAgent,
		waitForWorkerAgent,
		followUpSessionRootWorkerAgent,
		sendWorkerAgentMessage,
	};
}

function toolWithSpies(spies: ReturnType<typeof controlSpies>, startWorkerDelegation = vi.fn()) {
	return createDelegateToolDefinition({
		caller: { kind: "session_root" },
		resolveMessageReplayScope: fixedReplayScope,
		startWorkerDelegation,
		runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		workerAgentControl: workerAgentControl(spies),
	});
}

describe("delegate exact-action input corrections", () => {
	it("waits for every listed worker when wait is spelled with agentIds", async () => {
		// Waiting is read-only, so the plural can only mean wait_many; refusing it cost a live run a
		// turn and left the failure ledger riding every request afterwards.
		const spies = controlSpies();
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [
				{ agentId: "worker-1", status: "idle" as const },
				{ agentId: "worker-2", status: "idle" as const },
			],
			updatedAgentIds: [],
			timedOut: false,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation: vi.fn(),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ ...spies, waitForWorkerAgents }),
		});

		const result = await tool.execute(
			"wait-plural",
			{ action: "wait", agentIds: ["worker-1", "worker-2"], timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);

		expect(result.isError).not.toBe(true);
		expect(waitForWorkerAgents).toHaveBeenCalledWith(["worker-1", "worker-2"], "all", 300_000);
		expect(spies.waitForWorkerAgent).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ started: true, action: "wait_many", agentIds: ["worker-1", "worker-2"] });
	});

	it("rejects plural agentIds on every singular lifecycle action with a named singular correction", async () => {
		for (const action of ["cancel", "interrupt", "resume", "retire"] as const) {
			const spies = controlSpies();
			const tool = toolWithSpies(spies);

			const result = await tool.execute(
				`${action}-plural`,
				{ action, agentIds: ["worker-10"] },
				undefined,
				undefined,
				context,
			);

			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({
				started: false,
				action,
				skipReason: "action_field_forbidden",
			});
			const text = delegateText(result);
			expect(text).toContain("agentIds");
			expect(text).toContain("agentId");
			expect(text).toContain("Nothing was executed.");
			expect(text).not.toContain("keep only agentId");
			expect(spies.cancelWorkerAgent).not.toHaveBeenCalled();
			expect(spies.interruptWorkerAgent).not.toHaveBeenCalled();
			expect(spies.resumeWorkerAgent).not.toHaveBeenCalled();
			expect(spies.retireWorkerAgent).not.toHaveBeenCalled();
			expect(spies.waitForWorkerAgent).not.toHaveBeenCalled();
		}
	});

	it("rejects a message-bearing task field on follow_up and send", async () => {
		for (const action of ["follow_up", "send"] as const) {
			const spies = controlSpies();
			const tool = toolWithSpies(spies);

			const result = await tool.execute(
				`${action}-task`,
				{ action, agentId: "worker-1", task: "do the thing" },
				undefined,
				undefined,
				context,
			);

			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ started: false, action, skipReason: "action_field_forbidden" });
			const text = delegateText(result);
			expect(text).toContain("does not accept field task");
			expect(text).toContain("message");
			expect(text).toContain("Nothing was queued.");
			expect(spies.followUpSessionRootWorkerAgent).not.toHaveBeenCalled();
			expect(spies.sendWorkerAgentMessage).not.toHaveBeenCalled();
		}
	});

	it("rejects interrupt with a message instead of silently dropping the undelivered text", async () => {
		const spies = controlSpies();
		const tool = toolWithSpies(spies);

		const result = await tool.execute(
			"interrupt-message",
			{ action: "interrupt", agentId: "worker-10", message: "stop and read this" },
			undefined,
			undefined,
			context,
		);

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			started: false,
			action: "interrupt",
			skipReason: "action_field_forbidden",
		});
		const text = delegateText(result);
		expect(text).toContain("delegate interrupt does not accept field message");
		expect(text).toContain("The worker was NOT interrupted and the message was NOT delivered.");
		expect(text).toContain("follow_up");
		expect(spies.interruptWorkerAgent).not.toHaveBeenCalled();
	});

	it("names the conflict when both the wrong field and its counterpart are sent", async () => {
		const cancelSpies = controlSpies();
		const cancelTool = toolWithSpies(cancelSpies);
		const cancelResult = await cancelTool.execute(
			"cancel-both",
			{ action: "cancel", agentId: "worker-1", agentIds: ["worker-1"] },
			undefined,
			undefined,
			context,
		);

		expect(cancelResult.isError).toBe(true);
		expect(delegateText(cancelResult)).toContain("Both agentIds and agentId were sent; keep only agentId.");
		expect(cancelSpies.cancelWorkerAgent).not.toHaveBeenCalled();

		const followUpSpies = controlSpies();
		const followUpTool = toolWithSpies(followUpSpies);
		const followUpResult = await followUpTool.execute(
			"follow-up-both",
			{ action: "follow_up", agentId: "worker-1", task: "do it", message: "do it" },
			undefined,
			undefined,
			context,
		);

		expect(followUpResult.isError).toBe(true);
		expect(delegateText(followUpResult)).toContain("Both task and message were sent; keep only message.");
		expect(followUpSpies.followUpSessionRootWorkerAgent).not.toHaveBeenCalled();
	});

	it("leaves the correct singular calls executing unchanged", async () => {
		const spies = controlSpies();
		const tool = toolWithSpies(spies);

		const cancelled = await tool.execute(
			"cancel-valid",
			{ action: "cancel", agentId: "worker-1" },
			undefined,
			undefined,
			context,
		);
		const followedUp = await tool.execute(
			"follow-up-valid",
			{ action: "follow_up", agentId: "worker-1", message: "continue" },
			undefined,
			undefined,
			context,
		);
		const interrupted = await tool.execute(
			"interrupt-valid",
			{ action: "interrupt", agentId: "worker-1" },
			undefined,
			undefined,
			context,
		);

		expect(spies.cancelWorkerAgent).toHaveBeenCalledWith("worker-1");
		expect(spies.followUpSessionRootWorkerAgent).toHaveBeenCalledWith("worker-1", "continue", {
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(spies.interruptWorkerAgent).toHaveBeenCalledWith("worker-1");
		for (const result of [cancelled, followedUp, interrupted]) {
			expect((result.details as DelegateToolDetails).skipReason).not.toBe("action_field_forbidden");
		}
	});

	it("keeps sanitizing unmapped noise fields so execution still proceeds", async () => {
		const spies = controlSpies();
		const tool = toolWithSpies(spies);

		const result = await tool.execute(
			"cancel-noise",
			{ action: "cancel", agentId: "worker-1", instructions: "noise" },
			undefined,
			undefined,
			context,
		);

		expect(result.details).toMatchObject({ action: "cancel", agentId: "worker-1", status: "canceled" });
		expect(spies.cancelWorkerAgent).toHaveBeenCalledWith("worker-1");
	});

	it("keeps adopting a start task as instructions", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const tool = toolWithSpies(controlSpies(), startWorkerDelegation);

		const result = await tool.execute(
			"start-task",
			{ action: "start", task: "Audit the failing lane" },
			undefined,
			undefined,
			context,
		);

		expect(startWorkerDelegation).toHaveBeenCalledWith({ instructions: "Audit the failing lane" });
		expect(result.details).toMatchObject({ started: true });
	});

	it("rejects a mapped field identically when a deletable noise field precedes it", async () => {
		const orderedSpies = controlSpies();
		const orderedTool = toolWithSpies(orderedSpies);
		const plainSpies = controlSpies();
		const plainTool = toolWithSpies(plainSpies);

		const ordered = await orderedTool.execute(
			"cancel-noise-first",
			{ action: "cancel", instructions: "noise", agentIds: ["worker-1"] },
			undefined,
			undefined,
			context,
		);
		const plain = await plainTool.execute(
			"cancel-plural-only",
			{ action: "cancel", agentIds: ["worker-1"] },
			undefined,
			undefined,
			context,
		);

		expect(delegateText(ordered)).toBe(delegateText(plain));
		expect(ordered.details).toMatchObject({ started: false, skipReason: "action_field_forbidden" });
		expect(orderedSpies.cancelWorkerAgent).not.toHaveBeenCalled();
	});

	// The session meltdown was this exact pipeline with an unrepairable result: the correction the
	// tool emitted was discarded and the model was handed `</untrusted_content>` to repair from.
	// Everything here is a production owner — the real violation text, the real wrapper, the real
	// kernel assessment — so the proof breaks if any of the three drifts.
	it("delivers the real correction through the real untrusted wrapper and the real failure assessment", async () => {
		const spies = controlSpies();
		const tool = toolWithSpies(spies);

		const rejected = await tool.execute(
			"cancel-plural-pipeline",
			{ action: "cancel", agentIds: ["worker-10"] },
			undefined,
			undefined,
			context,
		);

		expect(rejected.isError).toBe(true);
		expect(spies.cancelWorkerAgent).not.toHaveBeenCalled();

		const wrapped = wrapUntrustedText(delegateText(rejected), "tool:delegate");
		const assessment = assessToolFailure(wrapped, "failed", "tool_result_error");

		expect(assessment.diagnostic).toContain("agentIds");
		expect(assessment.diagnostic).toContain("agentId");
		expect(assessment.diagnostic).not.toContain("untrusted_content");
	});
});
