import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition, type DelegateToolDetails } from "../src/core/tools/delegate.ts";
import {
	createDelegateStatusToolDefinition,
	type DelegateStatusToolDetails,
} from "../src/core/tools/delegate-status.ts";

const context = {} as ExtensionContext;

function workerAgentControl(overrides: Partial<WorkerAgentControlPort>): WorkerAgentControlPort {
	return {
		listWorkerAgents: () => [],
		readWorkerAgentTranscript: (agentId) => ({
			agentId,
			cursor: 0,
			totalMessages: 0,
			messages: [],
		}),
		sendWorkerAgentMessage: () => ({ messageId: "unused", queued: true }),
		followUpWorkerAgent: () => ({ started: false, steering: false, messageId: "unused" }),
		interruptWorkerAgent: () => ({ interrupted: false }),
		resumeWorkerAgent: () => ({ started: false }),
		cancelWorkerAgent: () => undefined,
		waitForWorkerAgent: async () => ({ status: "unknown" }),
		...overrides,
	};
}

describe("delegate logical-agent controls", () => {
	it("uses one flat action schema and returns the stable agent id with the initial task lane", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute("call", { instructions: "Inspect the failure" }, undefined, undefined, context);
		expect(startWorkerDelegation).toHaveBeenCalledWith({ instructions: "Inspect the failure" });
		expect(result.details).toMatchObject({ started: true, agentId: "lane-1", laneId: "lane-1" });
		expect(JSON.stringify(tool.parameters)).not.toContain("oneOf");
	});

	it("forwards a model-authored capability specification instead of requiring a profile cage", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-free", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const authority = {
			role: "operator" as const,
			model: { provider: "faux", modelId: "selected" },
			thinkingLevel: "high" as const,
			capabilities: ["filesystem.read" as const, "process.exec" as const, "workflow.delegate" as const],
			toolNames: ["read", "bash", "delegate"],
			readPaths: ["."],
			budget: { maxTokens: 8_192, maxToolCalls: 64 },
		};

		await tool.execute(
			"call",
			{ instructions: "Use the strongest useful local tools.", authority },
			undefined,
			undefined,
			context,
		);

		expect(startWorkerDelegation).toHaveBeenCalledWith({
			instructions: "Use the strongest useful local tools.",
			authority,
		});
	});

	it("bounds the owner profile catalog injected into the model prompt while retaining its total", () => {
		const tool = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			orchestrationProfiles: Array.from({ length: 40 }, (_, index) => ({
				profileId: `profile-${index}-${"p".repeat(512)}`,
				role: `role-${"r".repeat(512)}`,
				description: `description-${index}-${"d".repeat(8_192)}`,
			})),
		});

		const guideline = tool.promptGuidelines?.[0];
		expect(guideline?.length).toBeLessThanOrEqual(4_096);
		expect(guideline).toContain("40 configured");
		expect(guideline).toContain("24 omitted");
	});

	it("validates action-specific fields before routing worker controls", async () => {
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-1", queued: true as const }));
		const tool = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ sendWorkerAgentMessage }),
		});

		const missing = await tool.execute("call", { action: "send", agentId: "agent-1" }, undefined, undefined, context);
		expect(missing.content).toEqual([{ type: "text", text: "delegate send requires message" }]);
		expect(sendWorkerAgentMessage).not.toHaveBeenCalled();

		const sent = await tool.execute(
			"call",
			{ action: "send", agentId: "agent-1", message: "Check the focused test" },
			undefined,
			undefined,
			context,
		);
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-1", "Check the focused test");
		expect(sent.details).toMatchObject({ action: "send", agentId: "agent-1", queued: true });
	});

	it("lets an agent list peers, read exact transcript pages, and send threaded reply-expected messages", async () => {
		const listWorkerAgents = vi.fn(() => [
			{
				schemaVersion: 1 as const,
				agentId: "agent-2",
				parentAgentId: "agent-1",
				rootAgentId: "agent-1",
				depth: 1,
				role: "explorer" as const,
				status: "registered" as const,
				resumeContext: {
					provider: "pi" as const,
					sessionId: "peer-session",
					cwd: "/repo",
					resourceProfileNames: [],
					contextPointers: [],
				},
				createdAt: "2026-08-04T00:00:00.000Z",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
		]);
		const readWorkerAgentTranscript = vi.fn(() => ({
			agentId: "agent-2",
			cursor: 1,
			totalMessages: 3,
			messages: [{ role: "user" as const, content: "EXACT_PEER_MESSAGE", timestamp: 1 }],
			nextCursor: 2,
		}));
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-2", queued: true as const }));
		const tool = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			callerAgentId: "agent-1",
			workerAgentControl: workerAgentControl({
				listWorkerAgents,
				readWorkerAgentTranscript,
				sendWorkerAgentMessage,
			}),
		});

		const listed = await tool.execute("call", { action: "list" }, undefined, undefined, context);
		const transcript = await tool.execute(
			"call",
			{ action: "transcript", agentId: "agent-2", cursor: 1, maxMessages: 1 },
			undefined,
			undefined,
			context,
		);
		await tool.execute(
			"call",
			{
				action: "send",
				agentId: "agent-2",
				message: "Please reply with evidence.",
				threadId: "thread-1",
				replyToMessageId: "message-1",
				expectReply: true,
			},
			undefined,
			undefined,
			context,
		);

		expect(JSON.stringify(listed.content)).toContain("agent-2");
		expect(JSON.stringify(transcript.content)).toContain("EXACT_PEER_MESSAGE");
		expect(readWorkerAgentTranscript).toHaveBeenCalledWith("agent-2", { cursor: 1, maxMessages: 1 });
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-2", "Please reply with evidence.", {
			senderAgentId: "agent-1",
			threadId: "thread-1",
			replyToMessageId: "message-1",
			expectReply: true,
		});
	});

	it("rejects oversized control payloads before invoking worker routing", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-1", queued: true as const }));
		const tool = createDelegateToolDefinition({
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ sendWorkerAgentMessage }),
		});

		const oversizedStart = await tool.execute(
			"call",
			{ instructions: "x".repeat(16 * 1024 + 1) },
			undefined,
			undefined,
			context,
		);
		const oversizedSend = await tool.execute(
			"call",
			{ action: "send", agentId: "agent-1", message: "x".repeat(4_096 + 1) },
			undefined,
			undefined,
			context,
		);
		const oversizedAction = await tool.execute(
			"call",
			{ action: "x".repeat(17) as "start", instructions: "unused" },
			undefined,
			undefined,
			context,
		);

		expect(oversizedStart.details).toMatchObject({ started: false, skipReason: "instructions_too_long" });
		expect(oversizedSend.details).toMatchObject({ started: false, skipReason: "message_too_long" });
		expect(oversizedAction.details).toMatchObject({ started: false, skipReason: "invalid_action" });
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(sendWorkerAgentMessage).not.toHaveBeenCalled();
	});

	it("routes follow-up, interruption, resume, and terminal cancellation through the existing callbacks", async () => {
		const followUpWorkerAgent = vi.fn(() => ({ started: true, steering: true, messageId: "message-2" }));
		const interruptWorkerAgent = vi.fn(() => ({ interrupted: true }));
		const resumeWorkerAgent = vi.fn(() => ({ started: true }));
		const cancelWorkerAgent = vi.fn(() => ({
			laneId: "lane-1",
			type: "worker" as const,
			status: "canceled" as const,
		}));
		const tool = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				followUpWorkerAgent,
				interruptWorkerAgent,
				resumeWorkerAgent,
				cancelWorkerAgent,
			}),
		});

		await tool.execute(
			"call",
			{ action: "follow_up", agentId: "agent-1", message: "Continue" },
			undefined,
			undefined,
			context,
		);
		await tool.execute("call", { action: "interrupt", agentId: "agent-1" }, undefined, undefined, context);
		await tool.execute("call", { action: "resume", agentId: "agent-1" }, undefined, undefined, context);
		const cancelled = await tool.execute(
			"call",
			{ action: "cancel", agentId: "agent-1" },
			undefined,
			undefined,
			context,
		);

		expect(followUpWorkerAgent).toHaveBeenCalledWith("agent-1", "Continue");
		expect(interruptWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(resumeWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelled.details).toMatchObject({ action: "cancel", agentId: "agent-1", status: "canceled" });
	});

	it("turns a thrown control callback into a bounded typed tool result", async () => {
		const tool = createDelegateToolDefinition({
			startWorkerDelegation: () => {
				throw new Error(`synthetic failure ${"x".repeat(32_000)}`);
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute("call", { instructions: "Inspect" }, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);

		expect(result.details).toMatchObject({
			started: false,
			action: "start",
			skipReason: "worker_agent_control_error",
		});
		expect(content?.text.length).toBeLessThanOrEqual(2_048);
		expect(content?.text).toContain("synthetic failure");
	});

	it("bounds synchronous worker claims before returning them to model context", async () => {
		const tool = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({
				started: true,
				record: { laneId: "lane-1", type: "worker", status: "succeeded" },
				outcome: {
					claim: {
						requestId: "lane-1",
						status: "completed",
						summary: `bounded marker ${"s".repeat(64_000)}`,
						changedFiles: [],
						blockers: Array.from({ length: 100 }, (_, index) => `blocker-${index}-${"b".repeat(1_000)}`),
						evidence: {
							query: "worker:lane-1",
							sources: [],
							findings: Array.from({ length: 100 }, (_, index) => ({
								id: `finding-${index}`,
								summary: `finding-${index}-${"f".repeat(1_000)}`,
								evidenceIds: [],
							})),
						},
					},
					acceptance: { outcome: "allow", gate: "test", reasonCode: "accepted" },
					accepted: true,
					laneStatus: "succeeded",
					reasonCode: "completed",
					costUsd: 0,
				},
			}),
		});

		const result = await tool.execute("call", { instructions: "Inspect" }, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);
		const details = result.details as DelegateToolDetails;

		expect(content?.text.length).toBeLessThanOrEqual(16 * 1024);
		expect(content?.text).toContain("bounded marker");
		expect(details.summary?.length).toBeLessThanOrEqual(8_000);
		expect(details.blockers?.length).toBeLessThanOrEqual(16);
	});
});

describe("delegate_status wait", () => {
	it("requires a logical agent id and waits through the event-driven callback without polling", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const }));
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => [],
			getWorkerClaimSnapshots: () => [],
			workerAgentControl: workerAgentControl({ waitForWorkerAgent }),
		});

		const missing = await tool.execute("call", { action: "wait" }, undefined, undefined, context);
		expect(missing.content).toEqual([{ type: "text", text: "wait action requires agentId" }]);
		expect(waitForWorkerAgent).not.toHaveBeenCalled();

		const result = await tool.execute(
			"call",
			{ action: "wait", agentId: "agent-1", timeoutMs: 1_000 },
			undefined,
			undefined,
			context,
		);
		expect(waitForWorkerAgent).toHaveBeenCalledWith("agent-1", 1_000);
		expect(result.details).toMatchObject({ kind: "wait", agentId: "agent-1", agentStatus: "idle" });
		expect(tool.description).toContain("event-driven");
		expect(tool.description).toContain("Do not poll");
	});

	it("rejects oversized control identities before waiting or rendering them", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const }));
		const acknowledgeWorkerReview = vi.fn(() => ({
			ok: true as const,
			requestId: "unused",
			reviewedAt: "2026-07-27T00:00:00.000Z",
		}));
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => [],
			getWorkerClaimSnapshots: () => [],
			workerAgentControl: workerAgentControl({ waitForWorkerAgent }),
			acknowledgeWorkerReview,
		});

		const oversizedAgentId = "a".repeat(513);
		const oversizedLaneId = "l".repeat(513);
		const wait = await tool.execute(
			"call",
			{ action: "wait", agentId: oversizedAgentId },
			undefined,
			undefined,
			context,
		);
		const review = await tool.execute(
			"call",
			{ action: "review", laneId: oversizedLaneId },
			undefined,
			undefined,
			context,
		);

		expect(wait.details).toMatchObject({ kind: "wait", reason: "invalid_agent_id" });
		expect(review.details).toMatchObject({ kind: "review", reviewed: false, reason: "invalid_lane_id" });
		expect(waitForWorkerAgent).not.toHaveBeenCalled();
		expect(acknowledgeWorkerReview).not.toHaveBeenCalled();
	});

	it("bounds sticky unreviewed identities and rendered history for long sessions", async () => {
		const records = Array.from({ length: 200 }, (_, index) => ({
			laneId: `lane-${index}`,
			type: "worker" as const,
			status: "succeeded" as const,
		}));
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => records,
			getWorkerClaimSnapshots: () =>
				records.map((record) => ({
					requestId: record.laneId,
					status: "completed" as const,
					summary: `claim-${record.laneId}-${"x".repeat(8_000)}`,
					changedFiles: [],
					parentReviewRequired: true,
				})),
		});

		const result = await tool.execute("call", {}, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);
		const details = result.details as DelegateStatusToolDetails;

		expect(content?.text.length).toBeLessThanOrEqual(16 * 1024);
		expect(details.unreviewedCount).toBe(200);
		expect(details.unreviewedLaneIds?.length).toBeLessThanOrEqual(64);
		expect(details.lanes?.length).toBeLessThanOrEqual(20);
	});
});
