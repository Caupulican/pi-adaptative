import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition, type DelegateToolDetails } from "../src/core/tools/delegate.ts";
import {
	createDelegateStatusToolDefinition,
	type DelegateStatusToolDetails,
} from "../src/core/tools/delegate-status.ts";

const context = {
	sessionManager: {
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
	},
} as unknown as ExtensionContext;

const fixedReplayScope = () => ({ sessionId: "session-1", branchId: "leaf-1" });

function workerAgentControl(overrides: Partial<WorkerAgentControlPort>): WorkerAgentControlPort {
	return {
		listWorkerAgents: () => [],
		getWorkerAgentActivity: () => "unknown",
		readWorkerAgentTranscript: (agentId) => ({
			agentId,
			cursor: 0,
			totalMessages: 0,
			messages: [],
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
			caller: { kind: "session_root" },
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
			caller: { kind: "session_root" },
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
			caller: { kind: "session_root" },
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
			caller: { kind: "worker", agentId: "agent-sender" },
			resolveMessageReplayScope: fixedReplayScope,
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
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-1", "Check the focused test", {
			senderAgentId: "agent-sender",
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
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
			caller: { kind: "worker", agentId: "agent-1" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
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
				expectReply: true,
			},
			undefined,
			undefined,
			context,
		);

		expect(JSON.stringify(listed.content)).toContain("agent-2");
		expect(JSON.stringify(transcript.content)).toContain("EXACT_PEER_MESSAGE");
		expect(listWorkerAgents).toHaveBeenCalledWith({ callerAgentId: "agent-1" });
		expect(readWorkerAgentTranscript).toHaveBeenCalledWith("agent-2", {
			cursor: 1,
			maxMessages: 1,
			callerAgentId: "agent-1",
		});
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-2", "Please reply with evidence.", {
			senderAgentId: "agent-1",
			threadId: "thread-1",
			expectReply: true,
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
	});

	it("rejects oversized control payloads before invoking worker routing", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-1", queued: true as const }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
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
		const followUpSessionRootWorkerAgent = vi.fn(() => ({
			started: true,
			steering: true,
			messageId: "message-2",
		}));
		const interruptWorkerAgent = vi.fn(() => ({ interrupted: true }));
		const resumeWorkerAgent = vi.fn(() => ({ started: true }));
		const cancelWorkerAgent = vi.fn(() => ({
			laneId: "lane-1",
			type: "worker" as const,
			status: "canceled" as const,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				followUpSessionRootWorkerAgent,
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

		expect(followUpSessionRootWorkerAgent).toHaveBeenCalledWith("agent-1", "Continue", {
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(interruptWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(resumeWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelled.details).toMatchObject({ action: "cancel", agentId: "agent-1", status: "canceled" });
	});

	it("turns a thrown control callback into a bounded typed tool result", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
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
			caller: { kind: "session_root" },
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

	it("blocks action start when callerAgentId is set to enforce 1-level nesting maximum", async () => {
		const startWorkerDelegation = vi.fn();
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute(
			"call",
			{ action: "start", instructions: "Nested delegation" },
			undefined,
			undefined,
			context,
		);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			started: false,
			action: "start",
			skipReason: "subagent_delegation_disabled",
		});
		const textItem = result.content.find(
			(item): item is Extract<typeof item, { type: "text" }> => item.type === "text",
		);
		expect(textItem?.text).toContain("1-level nesting maximum");
	});
});

describe("delegate persistent worker reuse", () => {
	it("uses one leaf-scoped host key for exact start replay and a distinct key on a new leaf", async () => {
		let leafId = "leaf-a";
		const replayContext = {
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => leafId,
			},
		} as unknown as ExtensionContext;
		const admitted = new Map<
			string,
			{
				started: true;
				steering: false;
				messageId: string;
				record: { laneId: string; type: "worker"; status: "queued" };
			}
		>();
		const startWorkerAgentTask = vi.fn(
			(_agentId: string, _message: string, options?: { idempotencyKey?: string }) => {
				const idempotencyKey = options?.idempotencyKey;
				if (!idempotencyKey) {
					return {
						started: false as const,
						steering: false as const,
						messageId: "",
						skipReason: "missing_idempotency_key",
					};
				}
				const replay = admitted.get(idempotencyKey);
				if (replay) return replay;
				const sequence = admitted.size + 1;
				const accepted = {
					started: true as const,
					steering: false as const,
					messageId: `message-${sequence}`,
					record: { laneId: `task-${sequence}`, type: "worker" as const, status: "queued" as const },
				};
				admitted.set(idempotencyKey, accepted);
				return accepted;
			},
		);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: leafId }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});
		const input = { action: "start" as const, agentId: "worker-1", instructions: "Audit replay" };

		const first = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);
		const replay = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);
		leafId = "leaf-b";
		const nextLeaf = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);

		expect(first.details).toMatchObject({ started: true, laneId: "task-1" });
		expect(replay.details).toMatchObject({ started: true, laneId: "task-1" });
		expect(nextLeaf.details).toMatchObject({ started: true, laneId: "task-2" });
		const firstKey = startWorkerAgentTask.mock.calls[0]?.[2]?.idempotencyKey;
		const replayKey = startWorkerAgentTask.mock.calls[1]?.[2]?.idempotencyKey;
		const nextLeafKey = startWorkerAgentTask.mock.calls[2]?.[2]?.idempotencyKey;
		expect(firstKey).toMatch(/^delegate-message-[a-f0-9]{64}$/);
		expect(replayKey).toBe(firstKey);
		expect(nextLeafKey).not.toBe(firstKey);
	});

	it("dispatches a new task onto an idle worker's persistent context instead of minting a fresh agent", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh-lane", type: "worker" as const, status: "queued" as const },
		}));
		const startWorkerAgentTask = vi.fn(() => ({
			started: true,
			steering: false as const,
			messageId: "m1",
			record: { laneId: "task-2", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				startWorkerAgentTask,
			}),
		});

		const result = await tool.execute(
			"call",
			{ action: "start", agentId: "worker-1", instructions: "Now audit SysMain too" },
			undefined,
			undefined,
			context,
		);
		expect(startWorkerAgentTask).toHaveBeenCalledWith(
			"worker-1",
			"Now audit SysMain too",
			expect.objectContaining({ idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/) }),
		);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			started: true,
			action: "start",
			agentId: "worker-1",
			laneId: "task-2",
			queued: true,
		});
	});

	it("reports terminal replay and wake-pending reuse as durable acceptance", async () => {
		const cases = [
			{
				name: "terminal replay",
				outcome: {
					started: false,
					steering: false as const,
					messageId: "message-terminal",
					record: { laneId: "task-terminal", type: "worker" as const, status: "succeeded" as const },
					skipReason: "worker_task_terminal_completed",
				},
				queued: false,
			},
			{
				name: "wake pending",
				outcome: {
					started: false,
					steering: false as const,
					messageId: "message-pending",
					skipReason: "worker_task_waiting_for_older_message",
				},
				queued: true,
			},
		] as const;

		for (const entry of cases) {
			const tool = createDelegateToolDefinition({
				caller: { kind: "session_root" },
				resolveMessageReplayScope: fixedReplayScope,
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({ startWorkerAgentTask: () => entry.outcome }),
			});
			const result = await tool.execute(
				`call-${entry.name}`,
				{ action: "start", agentId: "worker-1", instructions: "replayed task" },
				undefined,
				undefined,
				context,
			);

			expect(result.details).toMatchObject({
				started: true,
				accepted: true,
				messageId: entry.outcome.messageId,
				skipReason: entry.outcome.skipReason,
				queued: entry.queued,
			});
			expect(result.content).toEqual([
				expect.objectContaining({ type: "text", text: expect.stringContaining(entry.outcome.skipReason) }),
			]);
		}
	});

	it("rejects reuse of a busy or unknown worker with an explicit reason", async () => {
		const startWorkerAgentTask = vi.fn();
		const makeTool = (status: "active" | "suspended" | "unknown") =>
			createDelegateToolDefinition({
				caller: { kind: "session_root" },
				resolveMessageReplayScope: fixedReplayScope,
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({
					startWorkerAgentTask: () => ({
						started: false,
						steering: false,
						messageId: "",
						skipReason: status === "unknown" ? "unknown_agent" : `worker_${status}`,
					}),
				}),
			});

		const busy = await makeTool("active").execute(
			"call",
			{ action: "start", agentId: "worker-1", instructions: "task" },
			undefined,
			undefined,
			context,
		);
		expect(busy.details).toMatchObject({ started: false, skipReason: "worker_active" });

		const unknown = await makeTool("unknown").execute(
			"call",
			{ action: "start", agentId: "ghost", instructions: "task" },
			undefined,
			undefined,
			context,
		);
		expect(unknown.details).toMatchObject({ started: false, skipReason: "unknown_agent" });
		expect(startWorkerAgentTask).not.toHaveBeenCalled();
	});

	it("atomically admits only one of two concurrent starts for the same idle agent", async () => {
		let active = false;
		const startWorkerAgentTask = vi.fn(() => {
			if (active) {
				return { started: false, steering: false as const, messageId: "", skipReason: "worker_active" };
			}
			active = true;
			return {
				started: true,
				steering: false as const,
				messageId: "message-first",
				record: { laneId: "task-first", type: "worker" as const, status: "queued" as const },
			};
		});
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});

		const [first, second] = await Promise.all([
			tool.execute(
				"call",
				{ action: "start", agentId: "worker-1", instructions: "first task" },
				undefined,
				undefined,
				context,
			),
			tool.execute(
				"call",
				{ action: "start", agentId: "worker-1", instructions: "second task" },
				undefined,
				undefined,
				context,
			),
		]);

		expect(first.details).toMatchObject({ started: true, laneId: "task-first" });
		expect(second.details).toMatchObject({ started: false, skipReason: "worker_active" });
		expect(startWorkerAgentTask).toHaveBeenCalledTimes(2);
	});

	it("rejects reuse that tries to replace the worker's admitted authority", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({}),
		});
		const result = await tool.execute(
			"call",
			{
				action: "start",
				agentId: "worker-1",
				instructions: "task",
				authority: { budget: { maxTokens: 9_000 } },
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details).toMatchObject({ started: false, skipReason: "reuse_keeps_admitted_authority" });
	});

	it("reports live activity per agent in list so idle workers are discoverable", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "active" as const }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				listWorkerAgents: () =>
					[
						{ agentId: "worker-1", createdAt: "T0", depth: 1 },
						{ agentId: "worker-2", createdAt: "T1", depth: 1 },
					] as never,
				getWorkerAgentActivity: (agentId) => (agentId === "worker-1" ? "idle" : "active"),
				waitForWorkerAgent,
			}),
		});
		const result = await tool.execute("call", { action: "list" }, undefined, undefined, context);
		const textItem = result.content.find(
			(item): item is Extract<typeof item, { type: "text" }> => item.type === "text",
		);
		const payload = JSON.parse(textItem?.text ?? "{}");
		expect(payload.agents).toEqual([
			expect.objectContaining({ agentId: "worker-1", activity: "idle" }),
			expect.objectContaining({ agentId: "worker-2", activity: "active" }),
		]);
		expect(waitForWorkerAgent).not.toHaveBeenCalled();
	});
});
