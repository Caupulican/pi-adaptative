import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition, type DelegateToolInput } from "../src/core/tools/delegate.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

function context(leafId = "leaf-1"): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => leafId,
		},
	} as unknown as ExtensionContext;
}

function workerAgentControl(overrides: Record<string, unknown> = {}): WorkerAgentControlPort {
	return {
		listWorkerAgents: () => [],
		getWorkerAgentActivity: () => "unknown",
		readWorkerAgentTranscript: (agentId: string) => ({
			agentId,
			cursor: 0,
			totalMessages: 0,
			messages: [],
		}),
		sendWorkerAgentMessage: () => ({ messageId: "worker-send", queued: true }),
		followUpWorkerAgent: () => ({ started: false, steering: false, messageId: "worker-follow-up" }),
		startWorkerAgentTask: () => ({ started: false, steering: false, messageId: "", skipReason: "unknown_agent" }),
		interruptWorkerAgent: () => ({ interrupted: false }),
		resumeWorkerAgent: () => ({ started: false }),
		cancelWorkerAgent: () => undefined,
		waitForWorkerAgent: async () => ({ status: "unknown" }),
		sendSessionRootWorkerAgentMessage: () => ({ messageId: "root-send", queued: true }),
		followUpSessionRootWorkerAgent: () => ({
			started: false,
			steering: false,
			messageId: "root-follow-up",
		}),
		replyToWorkerAgentMessage: () => ({ destination: "session_root", messageId: "root-reply" }),
		listSessionRootReplies: () => [],
		waitForSessionRootReplies: async () => ({ replies: [], timedOut: true }),
		acknowledgeSessionRootReply: () => false,
		reconcileSessionRootReplies: () => undefined,
		...overrides,
	} as unknown as WorkerAgentControlPort;
}

function toolText(result: Awaited<ReturnType<ReturnType<typeof createDelegateToolDefinition>["execute"]>>): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("delegate session-root reply routing", () => {
	it("requires one explicit validated caller at tool construction", () => {
		const runWorkerDelegation = async () => ({ started: false, skipReason: "unused" });

		expect(() => createDelegateToolDefinition({ runWorkerDelegation, caller: undefined as never })).toThrow(
			"delegate caller",
		);
		expect(() =>
			createDelegateToolDefinition({
				runWorkerDelegation,
				caller: { kind: "worker", agentId: " " },
			}),
		).toThrow("delegate caller");
		expect(() =>
			createDelegateToolDefinition({
				runWorkerDelegation,
				caller: { kind: "legacy", callerAgentId: "worker-1" } as never,
			}),
		).toThrow("delegate caller");
	});

	it("routes root send and follow_up through root-owned wrappers with replay-stable host idempotency", async () => {
		let branchId = "leaf-1";
		const intentsByKey = new Map<string, string>();
		const sendSessionRootWorkerAgentMessage = vi.fn(
			(agentId: string, message: string, options: { idempotencyKey?: string }) => {
				const key = options.idempotencyKey ?? "";
				const intent = JSON.stringify({ agentId, message });
				const existing = intentsByKey.get(key);
				if (existing !== undefined && existing !== intent) throw new Error("idempotency identity conflicts");
				intentsByKey.set(key, intent);
				return { messageId: "root-send", queued: true as const };
			},
		);
		const followUpSessionRootWorkerAgent = vi.fn(
			(_agentId: string, _message: string, _options: { idempotencyKey?: string }) => ({
				started: false,
				steering: true,
				messageId: "root-follow-up",
			}),
		);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				sendSessionRootWorkerAgentMessage,
				followUpSessionRootWorkerAgent,
			}),
		});

		const first = await tool.execute(
			"call-1",
			{ action: "send", agentId: "worker-1", message: "request", threadId: "thread-1", expectReply: true },
			undefined,
			undefined,
			context(),
		);
		await tool.execute(
			"call-1",
			{ action: "send", agentId: "worker-1", message: "request", threadId: "thread-1", expectReply: true },
			undefined,
			undefined,
			context(),
		);
		const followed = await tool.execute(
			"call-1",
			{ action: "follow_up", agentId: "worker-1", message: "continue" },
			undefined,
			undefined,
			context(),
		);
		branchId = "leaf-2";
		await tool.execute(
			"call-1",
			{ action: "send", agentId: "worker-1", message: "request", threadId: "thread-1", expectReply: true },
			undefined,
			undefined,
			context("leaf-2"),
		);
		const divergent = await tool.execute(
			"call-1",
			{ action: "send", agentId: "worker-1", message: "divergent request" },
			undefined,
			undefined,
			context(),
		);

		const firstOptions = sendSessionRootWorkerAgentMessage.mock.calls[0]?.[2];
		const replayOptions = sendSessionRootWorkerAgentMessage.mock.calls[1]?.[2];
		const followUpOptions = followUpSessionRootWorkerAgent.mock.calls[0]?.[2];
		const differentLeafOptions = sendSessionRootWorkerAgentMessage.mock.calls[2]?.[2];
		expect(sendSessionRootWorkerAgentMessage).toHaveBeenNthCalledWith(1, "worker-1", "request", {
			threadId: "thread-1",
			expectReply: true,
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(replayOptions?.idempotencyKey).toBe(firstOptions?.idempotencyKey);
		expect(followUpOptions?.idempotencyKey).not.toBe(firstOptions?.idempotencyKey);
		expect(differentLeafOptions?.idempotencyKey).not.toBe(firstOptions?.idempotencyKey);
		expect(divergent.details).toMatchObject({
			started: false,
			skipReason: "worker_agent_control_error",
		});
		expect(first.details).toMatchObject({ messageId: "root-send", queued: true });
		expect(followed.details).toMatchObject({ messageId: "root-follow-up" });
		expect(toolText(first)).toContain("root-send");
	});

	it("binds worker sends to the host caller and rejects reply metadata on generic sends", async () => {
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "worker-send", queued: true as const }));
		const followUpWorkerAgent = vi.fn(() => ({
			started: false,
			steering: true,
			messageId: "worker-follow-up",
		}));
		const replyToWorkerAgentMessage = vi.fn(() => ({ destination: "session_root" as const, messageId: "reply-1" }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: "attempt-1" }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				sendWorkerAgentMessage,
				followUpWorkerAgent,
				replyToWorkerAgentMessage,
			}),
		});

		const sent = await tool.execute(
			"call-send",
			{ action: "send", agentId: "worker-2", message: "request" },
			undefined,
			undefined,
			context(),
		);
		const rejected = await tool.execute(
			"call-invalid",
			{ action: "send", agentId: "worker-2", message: "not a reply", replyToMessageId: "request-1" },
			undefined,
			undefined,
			context(),
		);
		const followed = await tool.execute(
			"call-follow",
			{ action: "follow_up", agentId: "worker-2", message: "continue" },
			undefined,
			undefined,
			context(),
		);

		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("worker-2", "request", {
			senderAgentId: "worker-1",
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(sent.details).toMatchObject({ messageId: "worker-send" });
		expect(followUpWorkerAgent).toHaveBeenCalledWith("worker-2", "continue", {
			senderAgentId: "worker-1",
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(followed.details).toMatchObject({ messageId: "worker-follow-up" });
		expect(rejected.details).toMatchObject({ started: false, skipReason: "reply_action_required" });
		expect(sendWorkerAgentMessage).toHaveBeenCalledTimes(1);
		expect(replyToWorkerAgentMessage).not.toHaveBeenCalled();
	});

	it("uses an explicit worker replay scope when the production wrapper has no extension context", async () => {
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "worker-send", queued: true as const }));
		const wrapped = wrapToolDefinition(
			createDelegateToolDefinition({
				caller: { kind: "worker", agentId: "worker-1" },
				resolveMessageReplayScope: () => ({ sessionId: "parent-session", branchId: "attempt-42" }),
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({ sendWorkerAgentMessage }),
			}),
		);

		const result = await wrapped.execute(
			"wrapped-call",
			{ action: "send", agentId: "worker-2", message: "coordinate" },
			undefined,
			undefined,
		);

		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("worker-2", "coordinate", {
			senderAgentId: "worker-1",
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(result.details).toMatchObject({ started: true, messageId: "worker-send" });
	});

	it("routes replies only from workers and lets the control infer the exact destination", async () => {
		const replyToWorkerAgentMessage = vi.fn(() => ({
			destination: "worker" as const,
			messageId: "reply-1",
			started: true,
			steering: false,
		}));
		const workerTool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ replyToWorkerAgentMessage }),
		});
		const rootTool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ replyToWorkerAgentMessage }),
		});

		const replied = await workerTool.execute(
			"call-reply",
			{ action: "reply", message: "exact evidence", replyToMessageId: "request-1" },
			undefined,
			undefined,
			context(),
		);
		const rootRejected = await rootTool.execute(
			"call-root-reply",
			{ action: "reply", message: "forbidden", replyToMessageId: "request-1" },
			undefined,
			undefined,
			context(),
		);
		const ambiguous = await workerTool.execute(
			"call-ambiguous",
			{
				action: "reply",
				agentId: "worker-2",
				message: "forbidden target",
				replyToMessageId: "request-1",
			},
			undefined,
			undefined,
			context(),
		);
		const threaded = await workerTool.execute(
			"call-threaded",
			{
				action: "reply",
				message: "forbidden thread",
				replyToMessageId: "request-1",
				threadId: "thread-1",
			},
			undefined,
			undefined,
			context(),
		);
		const replyExpected = await workerTool.execute(
			"call-reply-expected",
			{
				action: "reply",
				message: "forbidden expectation",
				replyToMessageId: "request-1",
				expectReply: true,
			},
			undefined,
			undefined,
			context(),
		);

		expect(replyToWorkerAgentMessage).toHaveBeenCalledWith("worker-1", "exact evidence", "request-1");
		expect(replied.details).toMatchObject({
			started: true,
			action: "reply",
			messageId: "reply-1",
		});
		expect(rootRejected.details).toMatchObject({ started: false, skipReason: "worker_only_action" });
		expect(ambiguous.details).toMatchObject({ started: false, skipReason: "reply_target_forbidden" });
		expect(threaded.details).toMatchObject({ started: false, skipReason: "reply_target_forbidden" });
		expect(replyExpected.details).toMatchObject({ started: false, skipReason: "reply_target_forbidden" });
		expect(replyToWorkerAgentMessage).toHaveBeenCalledTimes(1);
	});

	it("rejects every field outside the exact inbox and reply action allowlists before control", async () => {
		const listSessionRootReplies = vi.fn(() => []);
		const waitForSessionRootReplies = vi.fn(async () => ({ replies: [], timedOut: true }));
		const acknowledgeSessionRootReply = vi.fn(() => true);
		const replyToWorkerAgentMessage = vi.fn(() => ({
			destination: "session_root" as const,
			messageId: "reply-1",
		}));
		const control = workerAgentControl({
			listSessionRootReplies,
			waitForSessionRootReplies,
			acknowledgeSessionRootReply,
			replyToWorkerAgentMessage,
		});
		const rootTool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: control,
		});
		const workerTool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: control,
		});
		const fieldSamples = {
			profileId: "profile-1",
			authority: {},
			instructions: "instructions",
			agentId: "worker-2",
			message: "message",
			threadId: "thread-1",
			replyToMessageId: "request-1",
			requestMessageId: "request-1",
			messageId: "reply-1",
			ackToken: "00000000-0000-4000-8000-000000000001",
			expectReply: true,
			cursor: 0,
			maxMessages: 1,
			timeoutMs: 1,
		} satisfies Omit<DelegateToolInput, "action">;
		const cases: Array<{
			action: "inbox" | "inbox_wait" | "inbox_ack" | "reply";
			base: DelegateToolInput;
			allowed: ReadonlySet<keyof typeof fieldSamples>;
		}> = [
			{
				action: "inbox",
				base: { action: "inbox" },
				allowed: new Set(["agentId", "requestMessageId", "maxMessages"]),
			},
			{
				action: "inbox_wait",
				base: { action: "inbox_wait" },
				allowed: new Set(["agentId", "requestMessageId", "maxMessages", "timeoutMs"]),
			},
			{
				action: "inbox_ack",
				base: {
					action: "inbox_ack",
					messageId: "reply-required",
					ackToken: "00000000-0000-4000-8000-000000000002",
				},
				allowed: new Set(["messageId", "ackToken"]),
			},
			{
				action: "reply",
				base: { action: "reply", message: "answer", replyToMessageId: "request-required" },
				allowed: new Set(["message", "replyToMessageId"]),
			},
		];

		for (const actionCase of cases) {
			for (const [field, value] of Object.entries(fieldSamples) as Array<
				[keyof typeof fieldSamples, (typeof fieldSamples)[keyof typeof fieldSamples]]
			>) {
				if (actionCase.allowed.has(field)) continue;
				const result = await (actionCase.action === "reply" ? workerTool : rootTool).execute(
					`forbidden-${actionCase.action}-${field}`,
					{ ...actionCase.base, [field]: value },
					undefined,
					undefined,
					context(),
				);
				expect(result.details, `${actionCase.action} must reject ${field}`).toMatchObject({
					started: false,
				});
			}
		}

		expect(listSessionRootReplies).not.toHaveBeenCalled();
		expect(waitForSessionRootReplies).not.toHaveBeenCalled();
		expect(acknowledgeSessionRootReply).not.toHaveBeenCalled();
		expect(replyToWorkerAgentMessage).not.toHaveBeenCalled();
	});

	it("returns only whole bounded inbox entries without consuming omitted replies", async () => {
		const replies = Array.from({ length: 8 }, (_, index) => ({
			messageId: `reply-${index}`,
			sourceAgentId: `worker-${index}`,
			requestMessageId: `request-${index}`,
			content: "é".repeat(4_096),
			createdAt: "2026-08-07T00:00:00.000Z",
			ackToken: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
		}));
		const listSessionRootReplies = vi.fn(() => replies);
		const acknowledgeSessionRootReply = vi.fn(() => true);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				listSessionRootReplies,
				acknowledgeSessionRootReply,
			}),
		});

		const result = await tool.execute(
			"call-inbox",
			{ action: "inbox", agentId: "worker-3", requestMessageId: "request-3" },
			undefined,
			undefined,
			context(),
		);
		const text = toolText(result);
		const payload = JSON.parse(text) as { replies: typeof replies; omittedCount: number };

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(16 * 1024);
		expect(payload.replies.length).toBeGreaterThan(0);
		expect(payload.replies.length).toBeLessThan(replies.length);
		expect(payload.replies.every((reply) => reply.content.length === 4_096)).toBe(true);
		expect(payload.omittedCount).toBe(replies.length - payload.replies.length);
		expect(listSessionRootReplies).toHaveBeenCalledWith({
			sourceAgentId: "worker-3",
			requestMessageId: "request-3",
			maxMessages: 64,
		});
		expect(acknowledgeSessionRootReply).not.toHaveBeenCalled();
	});

	it("forwards the tool AbortSignal to a non-consuming event-driven inbox wait", async () => {
		const reply = {
			messageId: "reply-1",
			sourceAgentId: "worker-1",
			requestMessageId: "request-1",
			content: "evidence",
			createdAt: "2026-08-07T00:00:00.000Z",
			ackToken: "00000000-0000-4000-8000-000000000001",
		};
		const waitForSessionRootReplies = vi.fn(async () => ({ replies: [reply], timedOut: false }));
		const acknowledgeSessionRootReply = vi.fn(() => true);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				waitForSessionRootReplies,
				acknowledgeSessionRootReply,
			}),
		});
		const controller = new AbortController();

		const result = await tool.execute(
			"call-wait",
			{ action: "inbox_wait", requestMessageId: "request-1", maxMessages: 3, timeoutMs: 1_000 },
			controller.signal,
			undefined,
			context(),
		);

		expect(waitForSessionRootReplies).toHaveBeenCalledWith({
			requestMessageId: "request-1",
			maxMessages: 3,
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		expect(acknowledgeSessionRootReply).not.toHaveBeenCalled();
		expect(JSON.parse(toolText(result))).toMatchObject({ replies: [reply], timedOut: false, omittedCount: 0 });
	});

	it("acknowledges one exact inbox token only from the root caller", async () => {
		const acknowledgeSessionRootReply = vi.fn(() => true);
		const control = workerAgentControl({ acknowledgeSessionRootReply });
		const rootTool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: control,
		});
		const workerTool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: control,
		});

		const acknowledged = await rootTool.execute(
			"call-ack",
			{
				action: "inbox_ack",
				messageId: "reply-1",
				ackToken: "00000000-0000-4000-8000-000000000001",
			},
			undefined,
			undefined,
			context(),
		);
		const workerRejected = await workerTool.execute(
			"call-worker-ack",
			{
				action: "inbox_ack",
				messageId: "reply-1",
				ackToken: "00000000-0000-4000-8000-000000000001",
			},
			undefined,
			undefined,
			context(),
		);

		expect(acknowledgeSessionRootReply).toHaveBeenCalledWith("reply-1", "00000000-0000-4000-8000-000000000001");
		expect(acknowledged.details).toMatchObject({ action: "inbox_ack", accepted: true, messageId: "reply-1" });
		expect(workerRejected.details).toMatchObject({ started: false, skipReason: "root_only_action" });
		expect(acknowledgeSessionRootReply).toHaveBeenCalledTimes(1);
	});
});
