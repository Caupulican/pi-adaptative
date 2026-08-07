import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentMailbox, workerAgentMessageId } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import {
	MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
	type WorkerConversation,
	WorkerConversationStore,
} from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	type AgentBindingContract,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	ORCHESTRATION_SCHEMA_VERSION,
} from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-agent-control-coordinator-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function registeredAgent(overrides: Partial<AgentBindingContract> = {}): AgentBindingContract {
	const agentId = overrides.agentId ?? "agent-1";
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		role: "explorer",
		status: "registered",
		resumeContext: {
			provider: "pi",
			sessionId: "worker-1",
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		},
		createdAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:00.000Z",
		...overrides,
		agentId,
		rootAgentId: overrides.rootAgentId ?? agentId,
		depth: overrides.depth ?? 0,
	};
}

function activeAttempt(status: AttemptRuntimeState["status"]): AttemptRuntimeState {
	return {
		attemptId: "attempt-1",
		taskId: "worker-1",
		dispatch: {
			provider: "pi",
			taskId: "worker-1",
			instructions: "inspect",
			profileId: "explorer",
			resourcePointerIds: [],
		},
		status,
		checkpointIds: [],
		createdAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:00.000Z",
	};
}

describe("WorkerAgentControlCoordinator", () => {
	it("forwards bounded opaque transcript pagination without assuming a message-count cursor", () => {
		const agent = registeredAgent({ agentId: "paged-worker" });
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
		} as unknown as WorkerLifecycle;
		const getRawTranscriptPage = vi.fn(() => ({
			cursor: 100,
			messages: [],
			nextCursor: 112,
			omittedMessages: 1,
			serializedBytes: 2,
		}));
		const open = vi.spyOn(WorkerConversationStore.prototype, "open").mockReturnValue({
			getRawTranscriptPage,
		} as unknown as WorkerConversation);
		try {
			const coordinator = new WorkerAgentControlCoordinator({
				agentDir: root(),
				parentSessionId: "parent-opaque-transcript",
				processOwnerId: "pi-worker:1:owner",
				isControlAvailable: () => true,
				getLifecycle: () => lifecycle,
				recoveredRequest: () => ({ instructions: "unused" }),
				run: async () => ({ started: false, skipReason: "unused" }),
				scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
				statusChanged: vi.fn(),
				abortLane: vi.fn(),
				cancelLane: vi.fn(),
			});

			expect(
				coordinator.readWorkerAgentTranscript("paged-worker", {
					cursor: 100,
					maxMessages: 8,
					maxBytes: 12 * 1024,
				}),
			).toEqual({
				agentId: "paged-worker",
				cursor: 100,
				messages: [],
				nextCursor: 112,
				omittedMessages: 1,
				serializedBytes: 2,
			});
			expect(getRawTranscriptPage).toHaveBeenCalledWith({ cursor: 100, maxMessages: 8, maxBytes: 12 * 1024 });
			expect(() =>
				coordinator.readWorkerAgentTranscript("paged-worker", {
					maxMessages: MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES + 1,
				}),
			).toThrow(`through ${MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES} messages`);
		} finally {
			open.mockRestore();
		}
	});

	it("projects activity from durable task order when attempt clocks tie and UUID order reverses", async () => {
		const agent = registeredAgent({ activeAttemptId: "attempt-a", status: "active" });
		const completed = {
			...activeAttempt("completed"),
			attemptId: "attempt-z",
			taskId: "task-old",
			agentId: agent.agentId,
			createdAt: "2026-07-27T00:00:00.000Z",
		};
		const queued = {
			...activeAttempt("queued"),
			attemptId: "attempt-a",
			taskId: "task-new",
			agentId: agent.agentId,
			createdAt: "2026-07-27T00:00:00.000Z",
		};
		const snapshot = {
			agents: { [agent.agentId]: agent },
			tasks: {
				"task-old": { attemptIds: [completed.attemptId] },
				"task-new": { attemptIds: [queued.attemptId] },
			},
			attempts: { [completed.attemptId]: completed, [queued.attemptId]: queued },
		} as unknown as TaskRuntimeProjection;
		const getLatestAgentAttempt = vi.fn();
		const lifecycle = {
			getTaskRuntimeSnapshot: () => snapshot,
			getLatestAgentAttempt,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-tied-attempt-order",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(coordinator.listWorkerAgents()).toEqual([
			expect.objectContaining({ agentId: agent.agentId, activity: "active" }),
		]);
		await expect(coordinator.waitForWorkerAgents([agent.agentId], "all", 1)).resolves.toMatchObject({
			statuses: [{ agentId: agent.agentId, status: "active" }],
			timedOut: true,
		});
		expect(getLatestAgentAttempt).not.toHaveBeenCalled();
	});

	it("owns follow-up scheduling, event-driven state waits, and cancellation callbacks without controller wrappers", async () => {
		let agent = registeredAgent();
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "worker-1", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
			attempt = {
				...activeAttempt("queued"),
				taskId: record.laneId,
				dispatch: {
					...activeAttempt("queued").dispatch,
					instructions: args.instructions,
					logicalLaneId: args.agentId,
					...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
				},
			};
			agent = registeredAgent({ activeAttemptId: attempt.attemptId });
			return { record, attempt };
		});
		const suspendAgent = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getTaskRuntimeSnapshot: () =>
				({
					agents: { [agent.agentId]: agent },
					attempts: attempt ? { [attempt.attemptId]: attempt } : {},
				}) as TaskRuntimeProjection,
			prepareAgentTurn,
			getRecord: () => record,
			suspendAgent,
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const drain = vi.fn();
		const track = vi.fn();
		const scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "drain" | "track" | "dropQueued"> = {
			enqueue,
			drain,
			track,
			dropQueued: vi.fn(),
		};
		const abortLane = vi.fn();
		const cancelLane = vi.fn(() => ({ ...record, status: "canceled" as const }));
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-1",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler,
			statusChanged: vi.fn(),
			abortLane,
			cancelLane,
		});

		const followUp = coordinator.followUpWorkerAgent("agent-1", "continue safely");
		expect(followUp).toMatchObject({ started: true, steering: false, record });
		expect(prepareAgentTurn).toHaveBeenCalledWith({
			agentId: "agent-1",
			instructions: "continue safely",
			controlMessageId: followUp.messageId,
		});
		expect(enqueue).toHaveBeenCalledWith(record, { instructions: "recovered" });
		expect(drain).toHaveBeenCalledOnce();
		expect(coordinator.sendWorkerAgentMessage(" agent-1 ", "durable follow-up")).toMatchObject({ queued: true });
		expect(
			coordinator
				.mailboxMessagesForConversation(
					"agent-1",
					{ findDeliveredWorkerControlMessageIds: () => new Set<string>() } as unknown as WorkerConversation,
					true,
				)
				.map((message) => (message.role === "user" ? String(message.content) : "")),
		).toContainEqual(expect.stringContaining("durable follow-up"));

		attempt = activeAttempt("running");
		agent = registeredAgent({ activeAttemptId: attempt.attemptId, status: "active" });
		expect(coordinator.interruptWorkerAgent("agent-1")).toEqual({ interrupted: true });
		expect(suspendAgent).toHaveBeenCalledWith("worker-1", "agent-1", "pi-worker:1:owner");
		expect(abortLane).toHaveBeenCalledWith("worker-1", "agent_interrupted");

		const waiting = coordinator.waitForWorkerAgent("agent-1", 10_000);
		agent = registeredAgent({ activeAttemptId: attempt.attemptId, status: "suspended" });
		coordinator.signalStateChanged();
		await expect(waiting).resolves.toEqual({ status: "suspended" });

		attempt = activeAttempt("suspended");
		enqueue.mockClear();
		drain.mockClear();
		track.mockClear();
		expect(coordinator.resumeWorkerAgent("agent-1")).toMatchObject({ started: true, record });
		expect(enqueue).toHaveBeenCalledWith(record, { instructions: "recovered" }, true, false);
		expect(drain).toHaveBeenCalledOnce();
		expect(track).not.toHaveBeenCalled();

		expect(coordinator.cancelWorkerAgent("agent-1", "owner_cancelled")).toMatchObject({ status: "canceled" });
		expect(abortLane).toHaveBeenLastCalledWith("worker-1", "owner_cancelled");
		expect(cancelLane).toHaveBeenCalledWith("worker-1", "owner_cancelled");
	});

	it("keeps a suspended resume queued when worker capacity is full", async () => {
		const agentDir = root();
		const attempt = {
			...activeAttempt("suspended"),
			attemptId: "attempt-capacity-resume",
			taskId: "worker-capacity-resume",
		};
		const agent = registeredAgent({ activeAttemptId: attempt.attemptId, status: "suspended" });
		const record = { laneId: attempt.taskId, type: "worker" as const, status: "running" as const };
		const request = { instructions: "resume after capacity is available" };
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({
				agents: { [agent.agentId]: agent },
				attempts: { [attempt.attemptId]: attempt },
			}),
			getRecord: (laneId: string) => (laneId === record.laneId ? record : undefined),
		} as unknown as WorkerLifecycle;
		let capacityFull = true;
		const admit = vi.fn(() =>
			capacityFull ? ({ action: "wait", reason: "capacity" } as const) : ({ action: "start" } as const),
		);
		const scheduledRun = vi.fn(async () => ({ started: true as const }));
		const cancelLane = vi.fn();
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit,
			getRecord: lifecycle.getRecord.bind(lifecycle),
			run: scheduledRun,
			cancel: cancelLane,
			warn: vi.fn(),
		});
		const bypassRun = vi.fn(async () => ({
			started: false as const,
			skipReason: "worker_delegation_already_running",
		}));
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-capacity-resume",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => request,
			run: bypassRun,
			scheduler,
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane,
		});

		expect(coordinator.resumeWorkerAgent(agent.agentId)).toMatchObject({ started: true, record });
		await Promise.resolve();
		expect(bypassRun).not.toHaveBeenCalled();
		expect(admit).toHaveBeenCalledWith(request, record);
		expect(scheduledRun).not.toHaveBeenCalled();
		expect(cancelLane).not.toHaveBeenCalled();
		expect(scheduler.queuedCount).toBe(1);

		capacityFull = false;
		scheduler.drain();
		expect(scheduledRun).toHaveBeenCalledWith(request, record);
		expect(cancelLane).not.toHaveBeenCalled();
		expect(scheduler.queuedCount).toBe(0);
	});

	it("resumes a suspended verifier through the reserved scheduler queue", () => {
		const attempt = {
			...activeAttempt("suspended"),
			attemptId: "attempt-verifier-resume",
			taskId: "worker-verifier-resume",
		};
		const agent = registeredAgent({ activeAttemptId: attempt.attemptId, status: "suspended" });
		const record = { laneId: attempt.taskId, type: "worker" as const, status: "running" as const };
		const request = { instructions: "resume verifier", verificationOfTaskId: "worker-subject" };
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({
				agents: { [agent.agentId]: agent },
				attempts: { [attempt.attemptId]: attempt },
			}),
			getRecord: (laneId: string) => (laneId === record.laneId ? record : undefined),
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const drain = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-verifier-resume",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => request,
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue, drain, track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(coordinator.resumeWorkerAgent(agent.agentId)).toMatchObject({ started: true, record });
		expect(enqueue).toHaveBeenCalledWith(record, request, true, true);
		expect(drain).toHaveBeenCalledOnce();
	});

	it("keeps an expected reply open until durable target admission and reuses the exact accepted reply", () => {
		const agentDir = root();
		const requester = registeredAgent({ agentId: "agent-1", rootAgentId: "agent-1" });
		const responder = registeredAgent({
			agentId: "agent-2",
			parentAgentId: "agent-1",
			rootAgentId: "agent-1",
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ "agent-1": requester, "agent-2": responder })[agentId],
			getTaskRuntimeSnapshot: () => ({
				agents: { "agent-1": requester, "agent-2": responder },
				attempts: {},
			}),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-1",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-1",
			agentId: "agent-2",
		});
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "agent-1",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		const requesterMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-1",
			agentId: "agent-1",
		});
		for (let index = 0; index < 64; index++) {
			requesterMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `occupied mandatory ${index}`,
				senderAgentId: "other-source",
				replyToMessageId: `other-request-${index}`,
				idempotencyKey: `other-reply-${index}`,
				task: { kind: "agent_turn" },
			});
		}

		expect(() => coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId)).toThrow(
			"message limit",
		);
		expect(responderMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();

		requesterMailbox.acknowledgeDelivered(requesterMailbox.pending()[0]!.messageId);
		const acceptedReply = coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId);
		const committedReply = requesterMailbox.pending().find((message) => message.content === "Exact evidence.");
		expect(committedReply).toBeDefined();
		expect(acceptedReply.messageId).toBe(committedReply?.messageId);
		expect(responderMailbox.awaitingReplies()).toEqual([]);

		const retriedReply = coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId);
		expect(retriedReply).toMatchObject({ destination: "worker", messageId: committedReply?.messageId });
		expect(requesterMailbox.pending().filter((message) => message.content === "Exact evidence.")).toHaveLength(1);
		expect(responderMailbox.awaitingReplies()).toEqual([]);
	});

	it("acknowledges a reply at durable target acceptance and retains it across a drain interruption", () => {
		const agentDir = root();
		let target = registeredAgent({ agentId: "agent-1", rootAgentId: "agent-1" });
		const responder = registeredAgent({
			agentId: "agent-2",
			parentAgentId: "agent-1",
			rootAgentId: "agent-1",
			depth: 1,
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-transaction",
			agentId: "agent-2",
		});
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "agent-1",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		for (let index = 0; index < 127; index++) {
			const history = responderMailbox.enqueue({ kind: "follow_up", content: `retained history ${index}` });
			responderMailbox.acknowledgeDelivered(history.messageId);
		}
		const targetMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-transaction",
			agentId: "agent-1",
		});
		let attempt: AttemptRuntimeState | undefined;
		let failDrain = true;
		const record = { laneId: "agent-1:reply-turn", type: "worker" as const, status: "queued" as const };
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === "agent-1" ? target : agentId === "agent-2" ? responder : undefined,
			getLatestAgentAttempt: (agentId: string) => (agentId === "agent-1" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({ agents: { "agent-1": target, "agent-2": responder }, attempts: {} }),
			prepareAgentTurn: vi.fn(() => {
				attempt = { ...activeAttempt("queued"), attemptId: "attempt-reply", taskId: record.laneId };
				target = { ...target, activeAttemptId: attempt.attemptId };
				return { record, attempt };
			}),
		} as unknown as WorkerLifecycle;
		const drain = vi.fn(() => {
			if (!failDrain) return;
			failDrain = false;
			expect(responderMailbox.awaitingReplies()).toEqual([]);
			const pressure = responderMailbox.enqueue({ kind: "follow_up", content: "retention pressure" });
			responderMailbox.acknowledgeDelivered(pressure.messageId);
			throw new Error("simulated reply task drain failure");
		});
		const cancelLane = vi.fn(() => {
			if (attempt) attempt = { ...attempt, status: "cancelled" };
			return { ...record, status: "canceled" as const };
		});
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-reply-transaction",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain, track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane,
		});
		const accepted = coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId);
		expect(accepted).toMatchObject({
			started: true,
			messageId: expect.stringMatching(/^worker-message-/),
			skipReason: "worker_task_recovery_pending:simulated reply task drain failure",
		});
		expect(targetMailbox.pending()).toEqual([
			expect.objectContaining({
				messageId: accepted.messageId,
				content: "Exact evidence.",
				replyToMessageId: request.messageId,
				task: { kind: "agent_turn" },
			}),
		]);
		expect(responderMailbox.awaitingReplies()).toEqual([]);

		expect(coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId)).toMatchObject({
			messageId: accepted.messageId,
			steering: false,
			skipReason: "worker_reply_already_accepted",
		});
		expect(targetMailbox.pending()).toHaveLength(1);
		expect(lifecycle.prepareAgentTurn).toHaveBeenCalledOnce();
		expect(responderMailbox.awaitingReplies()).toEqual([]);
		expect(
			coordinator.mailboxMessagesForConversation(
				"agent-1",
				{
					findDeliveredWorkerControlMessageIds: () => new Set([accepted.messageId]),
				} as unknown as WorkerConversation,
				true,
			),
		).toEqual([]);
		expect(targetMailbox.pending()).toEqual([]);
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		for (let index = 0; index < 160; index++) {
			const history = responderMailbox.enqueue({ kind: "follow_up", content: `source history ${index}` });
			responderMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(responderMailbox.getMessage(request.messageId)).toBeUndefined();
		expect(coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId)).toMatchObject({
			messageId: accepted.messageId,
			steering: false,
			skipReason: "worker_reply_already_accepted",
		});
		expect(() => coordinator.replyToWorkerAgentMessage("agent-2", "Drifted evidence.", request.messageId)).toThrow(
			"identity conflicts",
		);
		for (let index = 0; index < 160; index++) {
			const history = targetMailbox.enqueue({ kind: "follow_up", content: `target history ${index}` });
			targetMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(targetMailbox.getMessage(accepted.messageId)).toBeUndefined();
		expect(coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId)).toMatchObject({
			messageId: accepted.messageId,
			steering: false,
			skipReason: "worker_reply_already_accepted",
		});
		expect(() => coordinator.replyToWorkerAgentMessage("agent-2", "Drifted evidence.", request.messageId)).toThrow(
			"identity conflicts",
		);
		expect(targetMailbox.pending()).toEqual([]);
	});

	it("recreates a source-reserved reply after a crash and active-to-idle transition", () => {
		const agentDir = root();
		let target = registeredAgent({ agentId: "agent-1", rootAgentId: "agent-1", activeAttemptId: "attempt-active" });
		const responder = registeredAgent({
			agentId: "agent-2",
			parentAgentId: "agent-1",
			rootAgentId: "agent-1",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined = {
			...activeAttempt("running"),
			attemptId: "attempt-active",
			taskId: "agent-1:active-turn",
		};
		const record = { laneId: "agent-1:replay-turn", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn(() => {
			attempt = { ...activeAttempt("queued"), attemptId: "attempt-replay", taskId: record.laneId };
			target = { ...target, activeAttemptId: attempt.attemptId };
			return { record, attempt };
		});
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === "agent-1" ? target : agentId === "agent-2" ? responder : undefined,
			getLatestAgentAttempt: (agentId: string) => (agentId === "agent-1" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({ agents: { "agent-1": target, "agent-2": responder }, attempts: {} }),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-reply-mode-replay",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-mode-replay",
			agentId: "agent-2",
		});
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "agent-1",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		const replyMessageId = workerAgentMessageId(
			"parent-reply-mode-replay",
			`peer-reply:agent-2:${request.messageId}`,
		);
		expect(responderMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, "Exact evidence.")).toBe(
			true,
		);
		const targetMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-mode-replay",
			agentId: "agent-1",
		});
		expect(targetMailbox.pending()).toEqual([]);
		expect(() => coordinator.replyToWorkerAgentMessage("agent-2", "Drifted evidence.", request.messageId)).toThrow(
			"durable source receipt",
		);

		attempt = {
			...activeAttempt("cancelled"),
			attemptId: "attempt-active",
			taskId: "agent-1:active-turn",
		};
		coordinator.signalStateChanged();
		expect(prepareAgentTurn).toHaveBeenCalledOnce();
		expect(targetMailbox.pending()).toEqual([
			expect.objectContaining({
				messageId: replyMessageId,
				kind: "follow_up",
				content: "Exact evidence.",
				task: { kind: "agent_turn" },
			}),
		]);
		expect(responderMailbox.awaitingReplies()).toEqual([]);
		expect(coordinator.replyToWorkerAgentMessage("agent-2", "Exact evidence.", request.messageId)).toMatchObject({
			messageId: replyMessageId,
			steering: false,
			skipReason: "worker_reply_already_accepted",
		});
	});

	it("reserves source replay evidence before admitting unrelated controls", () => {
		const agentDir = root();
		const requester = registeredAgent({ agentId: "requester", rootAgentId: "requester" });
		const responder = registeredAgent({
			agentId: "responder",
			parentAgentId: "requester",
			rootAgentId: "requester",
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ requester, responder })[agentId as "requester" | "responder"],
			getTaskRuntimeSnapshot: () => ({ agents: { requester, responder }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-reply-source-capacity",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const sourceMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-source-capacity",
			agentId: "responder",
		});
		const request = sourceMailbox.enqueue({
			kind: "follow_up",
			content: "Return capacity evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		sourceMailbox.acknowledgeDelivered(request.messageId);
		for (let index = 0; index < 511; index++) {
			const receipt = sourceMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `source receipt ${index}`,
				idempotencyKey: `source-receipt-${index}`,
			});
			if (receipt.status !== "retained") throw new Error("Expected a distinct source receipt.");
			sourceMailbox.acknowledgeDelivered(receipt.messageId);
		}
		expect(() =>
			sourceMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "source receipt overflow",
				idempotencyKey: "source-receipt-overflow",
			}),
		).toThrow("replay evidence capacity");
		const targetMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-source-capacity",
			agentId: "requester",
		});

		const accepted = coordinator.replyToWorkerAgentMessage("responder", "Capacity evidence.", request.messageId);
		expect(accepted).toMatchObject({ destination: "worker", messageId: expect.any(String) });
		expect(sourceMailbox.awaitingReplies()).toEqual([]);
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBe(accepted.messageId);
		expect(targetMailbox.pending()).toEqual([expect.objectContaining({ messageId: accepted.messageId })]);
	});

	it("routes a target reply through source bytes reserved from passive backlog", () => {
		const agentDir = root();
		const requesterId = `r${"\0".repeat(511)}`;
		const requester = registeredAgent({ agentId: requesterId, rootAgentId: requesterId });
		const responder = registeredAgent({
			agentId: "responder",
			parentAgentId: requesterId,
			rootAgentId: requesterId,
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === requesterId ? requester : agentId === "responder" ? responder : undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { [requesterId]: requester, responder }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const parentSessionId = "parent-reply-source-byte-capacity";
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "responder" });
		const request = sourceMailbox.enqueue({
			kind: "follow_up",
			content: "Return byte-reserved evidence.",
			senderAgentId: requesterId,
			expectReply: true,
		});
		sourceMailbox.acknowledgeDelivered(request.messageId);
		let saturated = false;
		for (let index = 0; index < 64; index++) {
			try {
				sourceMailbox.enqueue({ kind: "follow_up", content: "o".repeat(4_096) });
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("mandatory") }));
				saturated = true;
				break;
			}
		}
		expect(saturated).toBe(true);

		const accepted = coordinator.replyToWorkerAgentMessage("responder", `r${"\0".repeat(4_095)}`, request.messageId);
		expect(accepted).toMatchObject({ destination: "worker", messageId: expect.any(String) });
		expect(sourceMailbox.awaitingReplies()).toEqual([]);
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBe(accepted.messageId);
		expect(new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: requesterId }).pending()).toEqual([
			expect.objectContaining({ messageId: accepted.messageId }),
		]);
	});

	it("preserves a crash-left source outbox while the worker target is full and retries on the next event", () => {
		const agentDir = root();
		const parentSessionId = "parent-reply-outbox-target-capacity";
		const requester = registeredAgent({ agentId: "requester", rootAgentId: "requester" });
		const responder = registeredAgent({
			agentId: "responder",
			parentAgentId: "requester",
			rootAgentId: "requester",
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ requester, responder })[agentId as "requester" | "responder"],
			getTaskRuntimeSnapshot: () => ({ agents: { requester, responder }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "responder" });
		const request = sourceMailbox.enqueue({
			kind: "follow_up",
			content: "Return delayed evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		sourceMailbox.acknowledgeDelivered(request.messageId);
		const replyMessageId = workerAgentMessageId(parentSessionId, `peer-reply:responder:${request.messageId}`);
		expect(sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, "Delayed evidence.")).toBe(
			true,
		);
		const targetMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "requester" });
		for (let index = 0; index < 64; index++) {
			targetMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `occupied mandatory ${index}`,
				senderAgentId: "other-source",
				replyToMessageId: `other-request-${index}`,
				idempotencyKey: `other-reply-${index}`,
				task: { kind: "agent_turn" },
			});
		}

		coordinator.signalStateChanged();
		expect(sourceMailbox.listReplyAcknowledgements()).toEqual([
			expect.objectContaining({
				messageId: request.messageId,
				acknowledgementId: replyMessageId,
				replyContent: "Delayed evidence.",
			}),
		]);
		expect(targetMailbox.pending().filter((message) => message.messageId === replyMessageId)).toEqual([]);

		targetMailbox.acknowledgeDelivered(targetMailbox.pending()[0]!.messageId);
		coordinator.signalStateChanged();
		expect(targetMailbox.pending().filter((message) => message.messageId === replyMessageId)).toEqual([
			expect.objectContaining({ content: "Delayed evidence.", replyToMessageId: request.messageId }),
		]);
	});

	it("delivers a crash-left source outbox to a retired target transcript while rejecting a new reply", () => {
		const agentDir = root();
		const parentSessionId = "parent-reply-outbox-retired-target";
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId,
			logicalAgentId: "requester",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const requester = registeredAgent({
			agentId: "requester",
			rootAgentId: "requester",
			status: "retired",
			resumeContext: conversation.getResumeContext(),
		});
		const responder = registeredAgent({
			agentId: "responder",
			parentAgentId: "requester",
			rootAgentId: "requester",
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ requester, responder })[agentId as "requester" | "responder"],
			getTaskRuntimeSnapshot: () => ({ agents: { requester, responder }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "responder" });
		const targetMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "requester" });
		const prior = targetMailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "Previously accepted message.",
			senderAgentId: "responder",
			idempotencyKey: "previously-accepted-message",
		});
		if (prior.status !== "retained") throw new Error("Expected a retained prior message.");
		targetMailbox.acknowledgeDelivered(prior.messageId);
		expect(
			coordinator.sendWorkerAgentMessage("requester", "Previously accepted message.", {
				senderAgentId: "responder",
				idempotencyKey: "previously-accepted-message",
			}),
		).toEqual({ messageId: prior.messageId, queued: true });
		expect(() =>
			coordinator.sendWorkerAgentMessage("requester", "Divergent prior message.", {
				senderAgentId: "responder",
				idempotencyKey: "previously-accepted-message",
			}),
		).toThrow("identity conflicts");
		for (let index = 0; index < 64; index++) {
			targetMailbox.enqueue({ kind: "follow_up", content: `retired passive backlog ${index}` });
		}
		const request = sourceMailbox.enqueue({
			kind: "follow_up",
			content: "Return crash-left evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		sourceMailbox.acknowledgeDelivered(request.messageId);
		const replyMessageId = workerAgentMessageId(parentSessionId, `peer-reply:responder:${request.messageId}`);
		expect(sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, "Crash-left evidence.")).toBe(
			true,
		);

		const commitReply = vi
			.spyOn(WorkerAgentMailbox.prototype, "commitReplyAcknowledgement")
			.mockImplementationOnce(() => {
				throw new Error("simulated crash after retired transcript append");
			});
		coordinator.signalStateChanged();
		commitReply.mockRestore();
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBe(replyMessageId);
		coordinator.signalStateChanged();
		expect(targetMailbox.getMessage(replyMessageId)).toBeUndefined();
		expect(targetMailbox.pending()).toHaveLength(64);
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		const transcript = new WorkerConversationStore()
			.open({
				agentDir,
				resumeContext: conversation.getResumeContext(),
				expectedLogicalAgentId: "requester",
			})
			.getRawTranscript();
		expect(
			transcript.filter(
				(message) => message.role === "user" && String(message.content).includes("Crash-left evidence."),
			),
		).toHaveLength(1);

		const terminal = coordinator.deliverWorkerTerminalHandoff({
			parentAgentId: "requester",
			childAgentId: "responder",
			terminalAttemptId: "retired-child-attempt",
			record: { laneId: "retired-child-lane", type: "worker", status: "succeeded" },
		});
		expect(terminal).toMatchObject({
			accepted: true,
			skipReason: "terminal_handoff_retired_target_transcript_delivery",
		});
		expect(
			coordinator.deliverWorkerTerminalHandoff({
				parentAgentId: "requester",
				childAgentId: "responder",
				terminalAttemptId: "retired-child-attempt",
				record: { laneId: "retired-child-lane", type: "worker", status: "succeeded" },
			}),
		).toMatchObject({ accepted: true, messageId: terminal.messageId });
		expect(
			new WorkerConversationStore()
				.open({
					agentDir,
					resumeContext: conversation.getResumeContext(),
					expectedLogicalAgentId: "requester",
				})
				.getRawTranscript()
				.filter(
					(message) => message.role === "user" && String(message.content).includes("Worker terminal handoff"),
				),
		).toHaveLength(1);

		const newRequest = sourceMailbox.enqueue({
			kind: "follow_up",
			content: "Return rejected evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		sourceMailbox.acknowledgeDelivered(newRequest.messageId);
		expect(() =>
			coordinator.replyToWorkerAgentMessage("responder", "Rejected evidence.", newRequest.messageId),
		).toThrow("is retired");
		expect(() =>
			coordinator.sendWorkerAgentMessage("requester", "Rejected passive message.", {
				senderAgentId: "responder",
			}),
		).toThrow("is retired");
		expect(() => coordinator.sendSessionRootWorkerAgentMessage("requester", "Rejected root message.")).toThrow(
			"is retired",
		);
		expect(sourceMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: newRequest.messageId })]);
	});

	it("commits a crash-left reply acknowledgement when transcript delivery is reconciled", () => {
		const agentDir = root();
		const target = registeredAgent({ agentId: "agent-1", rootAgentId: "agent-1" });
		const responder = registeredAgent({
			agentId: "agent-2",
			parentAgentId: "agent-1",
			rootAgentId: "agent-1",
			depth: 1,
		});
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === "agent-1" ? target : agentId === "agent-2" ? responder : undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { "agent-1": target, "agent-2": responder }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-reply-delivery-recovery",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-delivery-recovery",
			agentId: "agent-2",
		});
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "agent-1",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		const targetMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-delivery-recovery",
			agentId: "agent-1",
		});
		const reply = targetMailbox.enqueue({
			kind: "follow_up",
			content: "Exact evidence.",
			senderAgentId: "agent-2",
			replyToMessageId: request.messageId,
		});
		expect(responderMailbox.beginReplyAcknowledgement(request.messageId, reply.messageId, reply.content)).toBe(true);

		expect(
			coordinator.mailboxMessagesForConversation(
				"agent-1",
				{
					findDeliveredWorkerControlMessageIds: () => new Set([reply.messageId]),
				} as unknown as WorkerConversation,
				true,
			),
		).toEqual([]);
		expect(targetMailbox.pending()).toEqual([]);
		expect(responderMailbox.rollbackReplyAcknowledgement(request.messageId, reply.messageId)).toBe(false);
		expect(responderMailbox.awaitingReplies()).toEqual([]);
	});

	it("exposes safe session peers while restricting transcripts and destructive control to the caller subtree", () => {
		const agentDir = root();
		const parentSessionId = "parent-session-peer-visibility";
		const binding = (agentId: string, overrides: Partial<AgentBindingContract> = {}) => {
			const conversation = new WorkerConversationStore().ensure({
				agentDir,
				parentSessionId,
				logicalAgentId: agentId,
				cwd: agentDir,
				resourceProfileNames: [],
				contextPointers: [],
			});
			return registeredAgent({
				...overrides,
				agentId,
				resumeContext: conversation.getResumeContext(),
			});
		};
		const rootAgent = binding("root", { rootAgentId: "root" });
		const child = binding("child", {
			agentId: "child",
			parentAgentId: "root",
			rootAgentId: "root",
			depth: 1,
		});
		const sibling = binding("sibling", {
			agentId: "sibling",
			parentAgentId: "root",
			rootAgentId: "root",
			depth: 1,
		});
		const foreign = binding("foreign", { rootAgentId: "foreign" });
		const agents = { root: rootAgent, child, sibling, foreign };
		const attempts = {
			"attempt-root": { ...activeAttempt("running"), attemptId: "attempt-root", taskId: "root" },
			"attempt-child": { ...activeAttempt("running"), attemptId: "attempt-child", taskId: "child" },
			"attempt-sibling": { ...activeAttempt("running"), attemptId: "attempt-sibling", taskId: "sibling" },
		};
		const getTaskRuntimeSnapshot = vi.fn(() => ({ agents, attempts }));
		const getLatestAgentAttempt = vi.fn(
			(agentId: string) =>
				attempts[`attempt-${agentId}` as keyof typeof attempts] as AttemptRuntimeState | undefined,
		);
		const lifecycle = {
			getAgent: (agentId: string) => agents[agentId as keyof typeof agents],
			getTaskRuntimeSnapshot,
			getLatestAgentAttempt,
		} as unknown as WorkerLifecycle;
		const cancelLane = vi.fn(() => ({ laneId: "child", type: "worker" as const, status: "canceled" as const }));
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane,
		});

		const views = coordinator.listWorkerAgents({ callerAgentId: "child" });
		expect(views.map((agent) => agent.agentId).sort()).toEqual(["child", "foreign", "root", "sibling"]);
		expect(getTaskRuntimeSnapshot).toHaveBeenCalledOnce();
		expect(getLatestAgentAttempt).not.toHaveBeenCalled();
		const serializedViews = JSON.stringify(views);
		expect(serializedViews).not.toContain("resumeContext");
		expect(serializedViews).not.toContain("sessionFile");
		expect(serializedViews).not.toContain("contextPointers");
		expect(Object.keys(views.find((agent) => agent.agentId === "foreign") ?? {}).sort()).toEqual([
			"activity",
			"agentId",
			"createdAt",
			"depth",
			"role",
			"rootAgentId",
			"status",
			"updatedAt",
		]);
		expect(coordinator.readWorkerAgentTranscript("child", { callerAgentId: "child" })).toMatchObject({
			agentId: "child",
		});
		expect(() => coordinator.readWorkerAgentTranscript("sibling", { callerAgentId: "child" })).toThrow(
			"outside its control subtree",
		);
		expect(() => coordinator.readWorkerAgentTranscript("foreign", { callerAgentId: "child" })).toThrow(
			"outside its control subtree",
		);
		expect(coordinator.readWorkerAgentTranscript("foreign")).toMatchObject({ agentId: "foreign" });
		expect(() => coordinator.cancelWorkerAgent("root", "agent_cancelled", { callerAgentId: "child" })).toThrow(
			"outside its control subtree",
		);
		expect(() => coordinator.cancelWorkerAgent("sibling", "agent_cancelled", { callerAgentId: "child" })).toThrow(
			"outside its control subtree",
		);
		expect(coordinator.cancelWorkerAgent("child", "agent_cancelled", { callerAgentId: "root" })).toMatchObject({
			status: "canceled",
		});
		expect(cancelLane).toHaveBeenCalledOnce();
	});

	it("routes reply-expected messages between independent top-level session peers", () => {
		const agentDir = root();
		const requesterAttempt = {
			...activeAttempt("running"),
			attemptId: "attempt-peer-requester",
			taskId: "requester-task",
		};
		const requester = registeredAgent({
			agentId: "requester",
			rootAgentId: "requester",
			status: "active",
			activeAttemptId: requesterAttempt.attemptId,
		});
		const responder = registeredAgent({ agentId: "responder", rootAgentId: "responder" });
		const lifecycle = {
			getAgent: (agentId: string) => ({ requester, responder })[agentId as "requester" | "responder"],
			getLatestAgentAttempt: (agentId: string) => (agentId === requester.agentId ? requesterAttempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { requester, responder },
				attempts: { [requesterAttempt.attemptId]: requesterAttempt },
			}),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-session-peer-messaging",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		const sent = coordinator.sendWorkerAgentMessage("responder", "Return peer evidence.", {
			senderAgentId: "requester",
			threadId: "peer-thread",
			expectReply: true,
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-session-peer-messaging",
			agentId: "responder",
		});
		expect(responderMailbox.pending()).toEqual([
			expect.objectContaining({ messageId: sent.messageId, senderAgentId: "requester", expectReply: true }),
		]);
		responderMailbox.acknowledgeDelivered(sent.messageId);
		const reply = coordinator.replyToWorkerAgentMessage("responder", "Exact peer evidence.", sent.messageId);
		expect(reply).toMatchObject({ destination: "worker", steering: true });
		expect(
			new WorkerAgentMailbox({
				agentDir,
				parentSessionId: "parent-session-peer-messaging",
				agentId: "requester",
			}).pending(),
		).toEqual([
			expect.objectContaining({
				messageId: reply.messageId,
				senderAgentId: "responder",
				replyToMessageId: sent.messageId,
			}),
		]);
	});

	it("keeps peer sends visible but rejects cross-root worker wake controls", () => {
		const agentDir = root();
		const caller = registeredAgent({ agentId: "caller", rootAgentId: "caller" });
		const peer = registeredAgent({ agentId: "peer", rootAgentId: "peer" });
		const prepareAgentTurn = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => ({ caller, peer })[agentId as "caller" | "peer"],
			getLatestAgentAttempt: () => undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { caller, peer }, attempts: {} }),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-session-peer-authority",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(
			coordinator.sendWorkerAgentMessage("peer", "Share evidence without waking.", { senderAgentId: "caller" }),
		).toMatchObject({ queued: true });
		expect(() =>
			coordinator.followUpWorkerAgent("peer", "Wake with caller authority.", { senderAgentId: "caller" }),
		).toThrow("outside its control subtree");
		expect(() =>
			coordinator.startWorkerAgentTask("peer", "Start with caller authority.", { callerAgentId: "caller" }),
		).toThrow("outside its control subtree");
		expect(prepareAgentTurn).not.toHaveBeenCalled();
	});

	it("broadcasts once per canonical session peer, reports target failures, and never wakes a cross-root peer", () => {
		const agentDir = root();
		const parentSessionId = "parent-session-broadcast";
		const caller = registeredAgent({ agentId: "caller", rootAgentId: "caller" });
		let peer = registeredAgent({ agentId: "peer", rootAgentId: "peer" });
		const retired = registeredAgent({ agentId: "retired", rootAgentId: "retired", status: "retired" });
		const prepareAgentTurn = vi.fn();
		const scheduler = { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() };
		const lifecycle = {
			getAgent: (agentId: string) => ({ caller, peer, retired })[agentId as "caller" | "peer" | "retired"],
			getLatestAgentAttempt: () => undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { caller, peer, retired }, attempts: {} }),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler,
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		const first = coordinator.broadcastWorkerAgentMessage(
			[" peer ", "peer", "unknown", "retired"],
			"Share untrusted coordination evidence.",
			{
				senderAgentId: "caller",
				threadId: "broadcast-thread",
				idempotencyKey: "broadcast-call-1",
			},
		);
		expect(first.results).toEqual([
			{
				agentId: "peer",
				accepted: true,
				queued: true,
				replayed: false,
				messageId: expect.stringMatching(/^worker-message-[a-f0-9]{64}$/),
			},
			{ agentId: "unknown", accepted: false, error: "Unknown logical worker agent 'unknown'." },
			{ agentId: "retired", accepted: false, error: "Logical worker agent 'retired' is retired." },
		]);
		const firstMessageId = first.results[0]?.accepted ? first.results[0].messageId : undefined;
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "peer" });
		expect(mailbox.pending()).toEqual([
			expect.objectContaining({
				messageId: firstMessageId,
				kind: "follow_up",
				senderAgentId: "caller",
				threadId: "broadcast-thread",
			}),
		]);
		expect(mailbox.pending()[0]?.task).toBeUndefined();

		peer = { ...peer, status: "retired" };
		expect(
			coordinator.broadcastWorkerAgentMessage(["peer"], "Share untrusted coordination evidence.", {
				senderAgentId: "caller",
				threadId: "broadcast-thread",
				idempotencyKey: "broadcast-call-1",
			}).results,
		).toEqual([
			{
				agentId: "peer",
				accepted: true,
				queued: true,
				replayed: true,
				messageId: firstMessageId,
			},
		]);
		expect(
			coordinator.broadcastWorkerAgentMessage(["peer"], "A fresh retired message.", {
				senderAgentId: "caller",
				idempotencyKey: "broadcast-call-2",
			}).results,
		).toEqual([{ agentId: "peer", accepted: false, error: "Logical worker agent 'peer' is retired." }]);
		expect(mailbox.pending()).toHaveLength(1);
		expect(prepareAgentTurn).not.toHaveBeenCalled();
		expect(scheduler.enqueue).not.toHaveBeenCalled();
	});

	it("continues a broadcast after one target mailbox rejects admission under backpressure", () => {
		const agentDir = root();
		const parentSessionId = "parent-session-broadcast-backpressure";
		const full = registeredAgent({ agentId: "full", rootAgentId: "full" });
		const available = registeredAgent({ agentId: "available", rootAgentId: "available" });
		const lifecycle = {
			getAgent: (agentId: string) => ({ full, available })[agentId as "full" | "available"],
			getLatestAgentAttempt: () => undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { full, available }, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const fullMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "full" });
		for (let index = 0; index < 64; index++) {
			fullMailbox.enqueue({ kind: "follow_up", content: `pending ${index}` });
		}

		const broadcast = coordinator.broadcastWorkerAgentMessage(["full", "available"], "Bounded evidence.", {
			idempotencyKey: "broadcast-backpressure-call",
		});

		expect(broadcast.results[0]).toEqual({
			agentId: "full",
			accepted: false,
			error: expect.stringContaining("message limit"),
		});
		expect(broadcast.results[1]).toMatchObject({ agentId: "available", accepted: true, queued: true });
		expect(new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "available" }).pending()).toHaveLength(1);
	});

	it("rejects active, suspended, cross-root, pending-message, and unresolved-reply retirement", () => {
		const agentDir = root();
		const parentSessionId = "parent-agent-retirement-guards";
		const caller = registeredAgent({ agentId: "caller", rootAgentId: "caller" });
		const active = registeredAgent({
			agentId: "active",
			parentAgentId: "caller",
			rootAgentId: "caller",
			depth: 1,
			status: "active",
			activeAttemptId: "attempt-active",
		});
		const suspended = registeredAgent({
			agentId: "suspended",
			parentAgentId: "caller",
			rootAgentId: "caller",
			depth: 1,
			status: "suspended",
			activeAttemptId: "attempt-suspended",
		});
		const pending = registeredAgent({
			agentId: "pending",
			parentAgentId: "caller",
			rootAgentId: "caller",
			depth: 1,
		});
		const awaiting = registeredAgent({
			agentId: "awaiting",
			parentAgentId: "caller",
			rootAgentId: "caller",
			depth: 1,
		});
		const foreign = registeredAgent({ agentId: "foreign", rootAgentId: "foreign" });
		const activeAttemptState = { ...activeAttempt("running"), attemptId: "attempt-active" };
		const suspendedAttemptState = { ...activeAttempt("suspended"), attemptId: "attempt-suspended" };
		const agents = { caller, active, suspended, pending, awaiting, foreign };
		const retireAgent = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => agents[agentId as keyof typeof agents],
			getLatestAgentAttempt: (agentId: string) => {
				if (agentId === "active") return activeAttemptState;
				if (agentId === "suspended") return suspendedAttemptState;
				return undefined;
			},
			getTaskRuntimeSnapshot: () => ({
				agents,
				attempts: {
					[activeAttemptState.attemptId]: activeAttemptState,
					[suspendedAttemptState.attemptId]: suspendedAttemptState,
				},
			}),
			retireAgent,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "pending" }).enqueue({
			kind: "follow_up",
			content: "Pending evidence must survive.",
			senderAgentId: "caller",
		});
		const awaitingMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "awaiting" });
		const request = awaitingMailbox.enqueue({
			kind: "follow_up",
			content: "Reply before retirement.",
			senderAgentId: "caller",
			expectReply: true,
		});
		awaitingMailbox.acknowledgeDelivered(request.messageId);

		expect(() => coordinator.retireWorkerAgent("active", { callerAgentId: "caller" })).toThrow("active");
		expect(() => coordinator.retireWorkerAgent("suspended", { callerAgentId: "caller" })).toThrow("suspended");
		expect(() => coordinator.retireWorkerAgent("foreign", { callerAgentId: "caller" })).toThrow(
			"outside its control subtree",
		);
		expect(() => coordinator.retireWorkerAgent("pending", { callerAgentId: "caller" })).toThrow(
			"pending control message",
		);
		expect(() => coordinator.retireWorkerAgent("awaiting", { callerAgentId: "caller" })).toThrow(
			"unresolved reply obligation",
		);
		expect(retireAgent).not.toHaveBeenCalled();
	});

	it("retires idle leaves idempotently across restart while retaining their durable bindings", () => {
		const agentDir = root();
		const parentSessionId = "parent-agent-retirement-restart";
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: parentSessionId });
		const ensure = (agentId: string, parentAgentId?: string) =>
			lifecycle.ensureAgent({
				agentId,
				...(parentAgentId ? { parentAgentId } : {}),
				role: "explorer",
				resumeContext: {
					provider: "pi",
					sessionId: `session-${agentId}`,
					cwd: agentDir,
					resourceProfileNames: [],
					contextPointers: [],
				},
			});
		ensure("root-agent");
		ensure("child", "root-agent");
		const grandchildBefore = ensure("grandchild", "child");
		ensure("foreign");
		const statusChanged = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged,
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(() => coordinator.retireWorkerAgent("child", { callerAgentId: "root-agent" })).toThrow(
			"non-retired descendant 'grandchild'",
		);
		expect(() => coordinator.retireWorkerAgent("foreign", { callerAgentId: "child" })).toThrow(
			"outside its control subtree",
		);
		expect(coordinator.retireWorkerAgent("grandchild", { callerAgentId: "root-agent" })).toEqual({
			agent: expect.objectContaining({ agentId: "grandchild", status: "retired" }),
			retired: true,
			replayed: false,
		});
		expect(coordinator.retireWorkerAgent("grandchild", { callerAgentId: "root-agent" })).toEqual({
			agent: expect.objectContaining({ agentId: "grandchild", status: "retired" }),
			retired: true,
			replayed: true,
		});
		expect(coordinator.retireWorkerAgent("foreign")).toMatchObject({ retired: true, replayed: false });
		expect(statusChanged).toHaveBeenCalledTimes(2);

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId: parentSessionId });
		const restartedStatusChanged = vi.fn();
		const restarted = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => restartedLifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: restartedStatusChanged,
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(restarted.retireWorkerAgent("grandchild", { callerAgentId: "root-agent" })).toMatchObject({
			retired: true,
			replayed: true,
		});
		expect(restartedLifecycle.getAgent("grandchild")?.resumeContext).toEqual(grandchildBefore.resumeContext);
		expect(restarted.listWorkerAgents().find(({ agentId }) => agentId === "grandchild")?.status).toBe("retired");
		expect(restartedStatusChanged).not.toHaveBeenCalled();
	});

	it("waits across top-level peers while yielding and restoring exactly one caller scheduler slot", async () => {
		const caller = registeredAgent({
			agentId: "caller",
			rootAgentId: "caller",
			status: "active",
			activeAttemptId: "attempt-caller",
		});
		const peer = registeredAgent({ agentId: "peer", rootAgentId: "peer" });
		let peerAttempt = {
			...activeAttempt("queued"),
			attemptId: "attempt-peer",
			taskId: "peer",
			dispatch: { ...activeAttempt("queued").dispatch, logicalLaneId: "peer" },
		};
		const lifecycle = {
			getAgent: (agentId: string) => ({ caller, peer })[agentId as "caller" | "peer"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "peer" ? peerAttempt : activeAttempt("running")),
			getTaskRuntimeSnapshot: () => ({ agents: { caller, peer }, attempts: { "attempt-peer": peerAttempt } }),
		} as unknown as WorkerLifecycle;
		const releaseYield = vi.fn();
		const yieldCapacity = vi.fn(() => releaseYield);
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-1",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			yieldCapacity,
		});

		const waiting = coordinator.waitForWorkerAgent("peer", 10_000, { callerAgentId: "caller" });
		expect(yieldCapacity).toHaveBeenCalledOnce();
		expect(yieldCapacity).toHaveBeenCalledWith("caller", "caller");
		peerAttempt = { ...peerAttempt, status: "completed" };
		coordinator.signalStateChanged();

		await expect(waiting).resolves.toEqual({ status: "idle" });
		expect(releaseYield).toHaveBeenCalledOnce();
	});

	it("waits for any deduplicated session peer with one shared state subscription and one capacity yield", async () => {
		const caller = registeredAgent({
			agentId: "caller",
			rootAgentId: "caller",
			status: "active",
			activeAttemptId: "attempt-caller",
		});
		const peerA = registeredAgent({
			agentId: "peer-a",
			rootAgentId: "peer-a",
			status: "active",
			activeAttemptId: "attempt-peer-a",
		});
		const peerB = registeredAgent({
			agentId: "peer-b",
			rootAgentId: "peer-b",
			status: "active",
			activeAttemptId: "attempt-peer-b",
		});
		const peerAAttempt = {
			...activeAttempt("running"),
			attemptId: "attempt-peer-a",
			taskId: "peer-a-task",
			dispatch: { ...activeAttempt("running").dispatch, logicalLaneId: "peer-a" },
		};
		let peerBAttempt = {
			...activeAttempt("queued"),
			attemptId: "attempt-peer-b",
			taskId: "peer-b-task",
			dispatch: { ...activeAttempt("queued").dispatch, logicalLaneId: "peer-b" },
		};
		const getLatestAgentAttempt = vi.fn((agentId: string) => {
			if (agentId === "peer-a") return peerAAttempt;
			if (agentId === "peer-b") return peerBAttempt;
			return activeAttempt("running");
		});
		const getTaskRuntimeSnapshot = vi.fn(() => ({
			agents: { caller, "peer-a": peerA, "peer-b": peerB },
			attempts: {
				"attempt-peer-a": peerAAttempt,
				"attempt-peer-b": peerBAttempt,
			},
		}));
		const lifecycle = {
			getAgent: (agentId: string) => ({ caller, "peer-a": peerA, "peer-b": peerB })[agentId],
			getLatestAgentAttempt,
			getTaskRuntimeSnapshot,
		} as unknown as WorkerLifecycle;
		const releaseYield = vi.fn();
		const yieldCapacity = vi.fn(() => releaseYield);
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-multi-wait-any",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			yieldCapacity,
		});
		const subscribe = vi.spyOn(WorkerAgentMailbox.prototype, "subscribe");

		try {
			const waiting = coordinator.waitForWorkerAgents([" peer-a ", "peer-a", "peer-b"], "any", 10_000, {
				callerAgentId: "caller",
			});
			expect(subscribe).not.toHaveBeenCalled();
			expect(yieldCapacity).toHaveBeenCalledOnce();
			expect(yieldCapacity).toHaveBeenCalledWith("caller", "caller");
			peerBAttempt = { ...peerBAttempt, status: "completed" };
			const snapshotsBeforeStateEvent = getTaskRuntimeSnapshot.mock.calls.length;
			coordinator.signalStateChanged();

			await expect(waiting).resolves.toEqual({
				statuses: [
					{ agentId: "peer-a", status: "active" },
					{ agentId: "peer-b", status: "idle" },
				],
				updatedAgentIds: ["peer-b"],
				timedOut: false,
			});
			expect(releaseYield).toHaveBeenCalledOnce();
			// One snapshot reconciles mailboxes and one projects every target status; neither scales by target count.
			expect(getTaskRuntimeSnapshot.mock.calls.length - snapshotsBeforeStateEvent).toBe(2);
			expect(getLatestAgentAttempt).not.toHaveBeenCalled();
		} finally {
			subscribe.mockRestore();
		}
	});

	it("cleans the shared wait subscription and timeout when caller-capacity yield throws", async () => {
		const caller = registeredAgent({ agentId: "caller", rootAgentId: "caller" });
		const peer = registeredAgent({ agentId: "peer", rootAgentId: "peer" });
		const peerAttempt = {
			...activeAttempt("running"),
			attemptId: "attempt-peer",
			taskId: "peer-task",
			agentId: "peer",
		};
		const lifecycle = {
			getAgent: (agentId: string) => ({ caller, peer })[agentId as "caller" | "peer"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "peer" ? peerAttempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { caller, peer },
				attempts: { [peerAttempt.attemptId]: peerAttempt },
			}),
		} as unknown as WorkerLifecycle;
		let observedListenerCount = 0;
		let stateListeners: Set<() => void>;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-multi-wait-yield-failure",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			yieldCapacity: () => {
				observedListenerCount = stateListeners.size;
				throw new Error("synthetic yield failure");
			},
		});
		stateListeners = (coordinator as unknown as { stateListeners: Set<() => void> }).stateListeners;

		await expect(
			coordinator.waitForWorkerAgents(["peer"], "all", 10_000, { callerAgentId: "caller" }),
		).rejects.toThrow("synthetic yield failure");
		expect(observedListenerCount).toBe(1);
		expect(stateListeners.size).toBe(0);
	});

	it("waits for all peers and returns partial updates when the bounded wait times out", async () => {
		vi.useFakeTimers();
		try {
			const caller = registeredAgent({ agentId: "caller", rootAgentId: "caller" });
			const peerA = registeredAgent({ agentId: "peer-a", rootAgentId: "peer-a" });
			const peerB = registeredAgent({ agentId: "peer-b", rootAgentId: "peer-b" });
			let peerAAttempt = {
				...activeAttempt("running"),
				attemptId: "attempt-peer-a",
				taskId: "peer-a-task",
				agentId: "peer-a",
			};
			const peerBAttempt = {
				...activeAttempt("running"),
				attemptId: "attempt-peer-b",
				taskId: "peer-b-task",
				agentId: "peer-b",
			};
			const lifecycle = {
				getAgent: (agentId: string) => ({ caller, "peer-a": peerA, "peer-b": peerB })[agentId],
				getLatestAgentAttempt: (agentId: string) => {
					if (agentId === "peer-a") return peerAAttempt;
					if (agentId === "peer-b") return peerBAttempt;
					return undefined;
				},
				getTaskRuntimeSnapshot: () => ({
					agents: { caller, "peer-a": peerA, "peer-b": peerB },
					attempts: {
						"attempt-peer-a": peerAAttempt,
						"attempt-peer-b": peerBAttempt,
					},
				}),
			} as unknown as WorkerLifecycle;
			const releaseYield = vi.fn();
			const yieldCapacity = vi.fn(() => releaseYield);
			const coordinator = new WorkerAgentControlCoordinator({
				agentDir: root(),
				parentSessionId: "parent-multi-wait-all",
				processOwnerId: "pi-worker:1:owner",
				isControlAvailable: () => true,
				getLifecycle: () => lifecycle,
				recoveredRequest: () => ({ instructions: "unused" }),
				run: async () => ({ started: false, skipReason: "unused" }),
				scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
				statusChanged: vi.fn(),
				abortLane: vi.fn(),
				cancelLane: vi.fn(),
				yieldCapacity,
			});

			let resolved = false;
			const waiting = coordinator.waitForWorkerAgents(["peer-a", "peer-b"], "all", 1_000, {
				callerAgentId: "caller",
			});
			void waiting.then(() => {
				resolved = true;
			});
			peerAAttempt = { ...peerAAttempt, status: "completed" };
			coordinator.signalStateChanged();
			await Promise.resolve();
			expect(resolved).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);

			await expect(waiting).resolves.toEqual({
				statuses: [
					{ agentId: "peer-a", status: "idle" },
					{ agentId: "peer-b", status: "active" },
				],
				updatedAgentIds: ["peer-a"],
				timedOut: true,
			});
			expect(yieldCapacity).toHaveBeenCalledOnce();
			expect(releaseYield).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("validates one bounded canonical multi-agent wait set", () => {
		const lifecycle = {
			getAgent: () => undefined,
			getTaskRuntimeSnapshot: () => ({ agents: {}, attempts: {} }),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-multi-wait-validation",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		expect(() => coordinator.waitForWorkerAgents([], "any")).toThrow(
			`from 1 through ${MAX_ORCHESTRATION_COLLECTION_LENGTH}`,
		);
		expect(() =>
			coordinator.waitForWorkerAgents(
				Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH + 1 }, (_, index) => `agent-${index}`),
				"all",
			),
		).toThrow(`from 1 through ${MAX_ORCHESTRATION_COLLECTION_LENGTH}`);
		expect(() => coordinator.waitForWorkerAgents([" "], "any")).toThrow("id is required");
		expect(() =>
			coordinator.waitForWorkerAgents(["x".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1)], "any"),
		).toThrow(`exceeds ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH}`);
		expect(() => coordinator.waitForWorkerAgents(["agent-1"], "race" as never)).toThrow("mode");
	});

	it("projects a 64-agent immediate wait from one snapshot without per-agent lifecycle reads", async () => {
		const agents = Object.fromEntries(
			Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH }, (_, index) => {
				const agentId = `peer-${index}`;
				return [agentId, registeredAgent({ agentId, rootAgentId: agentId })];
			}),
		);
		const getTaskRuntimeSnapshot = vi.fn(() => ({ agents, attempts: {} }));
		const getAgent = vi.fn();
		const getLatestAgentAttempt = vi.fn();
		const lifecycle = { getTaskRuntimeSnapshot, getAgent, getLatestAgentAttempt } as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-64-wait",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		const result = await coordinator.waitForWorkerAgents(Object.keys(agents), "all");

		expect(result.statuses).toHaveLength(64);
		expect(result.statuses.every(({ status }) => status === "idle")).toBe(true);
		expect(getTaskRuntimeSnapshot).toHaveBeenCalledOnce();
		expect(getAgent).not.toHaveBeenCalled();
		expect(getLatestAgentAttempt).not.toHaveBeenCalled();
	});

	it("reports activity without yielding capacity and atomically rejects a competing task start", () => {
		const agentDir = root();
		let agent = registeredAgent();
		const otherAgent = registeredAgent({ agentId: "agent-2" });
		let attempt: AttemptRuntimeState | undefined;
		let taskDependencies: readonly string[] = [];
		const record = { laneId: "worker-1:turn:2", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn(
			(args: {
				agentId: string;
				instructions: string;
				controlMessageId?: string;
				dependsOnTaskIds?: readonly string[];
			}) => {
				taskDependencies = args.dependsOnTaskIds ?? [];
				attempt = {
					...activeAttempt("queued"),
					taskId: record.laneId,
					dispatch: {
						...activeAttempt("queued").dispatch,
						instructions: args.instructions,
						logicalLaneId: args.agentId,
						...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
					},
				};
				agent = registeredAgent({ activeAttemptId: attempt.attemptId });
				return { record, attempt };
			},
		);
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === agent.agentId ? agent : agentId === otherAgent.agentId ? otherAgent : undefined,
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({
				agents: { [agent.agentId]: agent, [otherAgent.agentId]: otherAgent },
				tasks: attempt
					? { [attempt.taskId]: { task: { dependsOn: taskDependencies }, attemptIds: [attempt.attemptId] } }
					: {},
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: (laneId: string) => (laneId === record.laneId ? record : undefined),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const yieldCapacity = vi.fn(() => vi.fn());
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-atomic-start",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			yieldCapacity,
		});

		expect(coordinator.getWorkerAgentActivity("agent-1")).toBe("idle");
		expect(yieldCapacity).not.toHaveBeenCalled();
		const first = coordinator.startWorkerAgentTask("agent-1", "first task", {
			idempotencyKey: "host-start-call-1",
			dependsOnTaskIds: ["dependency-a", "dependency-b"],
		});
		expect(first).toMatchObject({
			started: true,
			steering: false,
			record,
		});
		expect(
			coordinator.startWorkerAgentTask("agent-1", "first task", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-a", "dependency-b"],
			}),
		).toEqual(first);
		expect(() =>
			coordinator.startWorkerAgentTask("agent-1", "drifted task", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-a", "dependency-b"],
			}),
		).toThrow("idempotency identity conflicts");
		expect(() =>
			coordinator.startWorkerAgentTask("agent-1", "first task", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-b", "dependency-a"],
			}),
		).toThrow("durable task dependencies");
		expect(() =>
			coordinator.startWorkerAgentTask("agent-2", "first task", { idempotencyKey: "host-start-call-1" }),
		).toThrow("already accepted by logical worker 'agent-1'");
		expect(
			coordinator.startWorkerAgentTask("agent-1", "competing task", { idempotencyKey: "host-start-call-2" }),
		).toMatchObject({
			started: false,
			steering: false,
			skipReason: "worker_active",
		});
		expect(prepareAgentTurn).toHaveBeenCalledOnce();
		expect(prepareAgentTurn).toHaveBeenCalledWith({
			agentId: "agent-1",
			instructions: "first task",
			controlMessageId: first.messageId,
			dependsOnTaskIds: ["dependency-a", "dependency-b"],
		});
		// Explicit follow-up remains the intentional steering path for an active task.
		expect(coordinator.followUpWorkerAgent("agent-1", "steer active task")).toMatchObject({
			started: false,
			steering: true,
		});
		if (!attempt) throw new Error("Expected active attempt.");
		attempt = { ...attempt, status: "completed" };
		expect(
			coordinator.startWorkerAgentTask("agent-1", "first task", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-a", "dependency-b"],
			}),
		).toEqual(first);
		expect(prepareAgentTurn).toHaveBeenCalledOnce();

		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-atomic-start", agentId: "agent-1" });
		for (const message of mailbox.pending()) mailbox.acknowledgeDelivered(message.messageId);
		for (let index = 0; index < 160; index++) {
			const history = mailbox.enqueue({ kind: "follow_up", content: `start history ${index}` });
			mailbox.acknowledgeDelivered(history.messageId);
		}
		expect(mailbox.getMessage(first.messageId)).toBeUndefined();
		expect(
			coordinator.startWorkerAgentTask("agent-1", "first task", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-a", "dependency-b"],
			}),
		).toEqual(first);
		expect(() =>
			coordinator.startWorkerAgentTask("agent-1", "drifted after eviction", {
				idempotencyKey: "host-start-call-1",
				dependsOnTaskIds: ["dependency-a", "dependency-b"],
			}),
		).toThrow("idempotency identity conflicts");
		expect(mailbox.pending()).toEqual([]);
		expect(prepareAgentTurn).toHaveBeenCalledOnce();
	});

	it("recovers mailbox acceptance across prepare, scheduler enqueue, and drain crash boundaries", () => {
		for (const failurePoint of ["prepare", "enqueue", "drain"] as const) {
			const agentDir = root();
			const agent = registeredAgent();
			let attempt: AttemptRuntimeState | undefined;
			let failed = false;
			const prepareAgentTurn = vi.fn(
				(args: {
					agentId: string;
					instructions: string;
					controlMessageId?: string;
					dependsOnTaskIds?: readonly string[];
				}) => {
					if (failurePoint === "prepare" && !failed) {
						failed = true;
						throw new Error("simulated prepare failure");
					}
					attempt = {
						...activeAttempt("queued"),
						attemptId: `attempt-${failurePoint}`,
						taskId: `worker-${failurePoint}`,
						dispatch: {
							...activeAttempt("queued").dispatch,
							instructions: args.instructions,
							logicalLaneId: args.agentId,
							...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
						},
					};
					return {
						record: { laneId: attempt.taskId, type: "worker" as const, status: "queued" as const },
						attempt,
					};
				},
			);
			const enqueue = vi.fn(() => {
				if (failurePoint === "enqueue" && !failed) {
					failed = true;
					throw new Error("simulated enqueue failure");
				}
			});
			const drain = vi.fn(() => {
				if (failurePoint === "drain" && !failed) {
					failed = true;
					throw new Error("simulated drain failure");
				}
			});
			const abortLane = vi.fn();
			const cancelLane = vi.fn();
			const dropQueued = vi.fn();
			const lifecycle = {
				getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
				getLatestAgentAttempt: () => attempt,
				getTaskRuntimeSnapshot: () => ({
					agents: { [agent.agentId]: agent },
					attempts: attempt ? { [attempt.attemptId]: attempt } : {},
				}),
				getRecord: (laneId: string) =>
					attempt?.taskId === laneId ? { laneId, type: "worker" as const, status: "queued" as const } : undefined,
				prepareAgentTurn,
			} as unknown as WorkerLifecycle;
			const coordinator = new WorkerAgentControlCoordinator({
				agentDir,
				parentSessionId: `parent-crash-${failurePoint}`,
				processOwnerId: "pi-worker:1:owner",
				isControlAvailable: () => true,
				getLifecycle: () => lifecycle,
				recoveredRequest: () => ({ instructions: "recovered" }),
				run: async () => ({ started: false, skipReason: "unused" }),
				scheduler: { enqueue, drain, track: vi.fn(), dropQueued },
				statusChanged: vi.fn(),
				abortLane,
				cancelLane,
			});
			const mailbox = new WorkerAgentMailbox({
				agentDir,
				parentSessionId: `parent-crash-${failurePoint}`,
				agentId: agent.agentId,
			});

			const accepted = coordinator.startWorkerAgentTask(agent.agentId, `survive ${failurePoint}`, {
				dependsOnTaskIds: ["dependency-a"],
			});
			expect(accepted.messageId).toMatch(/^worker-message-/);
			expect(accepted.skipReason).toContain(`simulated ${failurePoint} failure`);
			expect(mailbox.pendingTaskBearing()).toEqual([
				expect.objectContaining({
					messageId: accepted.messageId,
					task: { kind: "agent_turn", dependsOnTaskIds: ["dependency-a"] },
				}),
			]);
			expect(abortLane).not.toHaveBeenCalled();
			expect(cancelLane).not.toHaveBeenCalled();
			expect(dropQueued).not.toHaveBeenCalled();

			coordinator.signalStateChanged();
			coordinator.signalStateChanged();
			expect(prepareAgentTurn).toHaveBeenCalledTimes(failurePoint === "prepare" ? 2 : 1);
			expect(prepareAgentTurn).toHaveBeenLastCalledWith({
				agentId: agent.agentId,
				instructions: `survive ${failurePoint}`,
				controlMessageId: accepted.messageId,
				dependsOnTaskIds: ["dependency-a"],
			});
			expect(attempt?.dispatch.controlMessageId).toBe(accepted.messageId);
			expect(mailbox.pendingTaskBearing()).toHaveLength(1);
			expect(enqueue).toHaveBeenCalled();
			expect(drain).toHaveBeenCalled();
		}
	});

	it("dead-letters a terminal failed wake and admits the next durable task", () => {
		const agentDir = root();
		const agent = registeredAgent();
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "worker-terminal-wake", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
			attempt = {
				...activeAttempt("queued"),
				attemptId: "attempt-terminal-wake",
				taskId: record.laneId,
				dispatch: {
					...activeAttempt("queued").dispatch,
					instructions: args.instructions,
					logicalLaneId: args.agentId,
					...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
				},
			};
			return { record, attempt };
		});
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({
				agents: { [agent.agentId]: agent },
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: () => record,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-terminal-wake",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue, drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-terminal-wake",
			agentId: agent.agentId,
		});

		const accepted = coordinator.startWorkerAgentTask(agent.agentId, "one durable wake");
		expect(accepted).toMatchObject({ started: true, record });
		if (!attempt) throw new Error("test attempt missing");
		attempt = { ...attempt, status: "failed" };
		coordinator.signalStateChanged();
		coordinator.signalStateChanged();
		expect(prepareAgentTurn).toHaveBeenCalledOnce();
		expect(enqueue).toHaveBeenCalledOnce();
		expect(mailbox.pendingTaskBearing()).toEqual([]);
		expect(mailbox.getMessage(accepted.messageId)).toMatchObject({
			failedAt: expect.any(String),
			failureReason: "worker_task_terminal_failed",
			task: { kind: "agent_turn" },
		});

		const next = coordinator.startWorkerAgentTask(agent.agentId, "next durable wake");
		expect(next).toMatchObject({ started: true, record });
		expect(prepareAgentTurn).toHaveBeenCalledTimes(2);
		expect(enqueue).toHaveBeenCalledTimes(2);
	});

	it("drains a retired target backlog in bounded event-driven continuations", async () => {
		const agentDir = root();
		const parentSessionId = "parent-retired-bounded-drain";
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId,
			logicalAgentId: "retired",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const agent = registeredAgent({
			agentId: "retired",
			rootAgentId: "retired",
			status: "retired",
			resumeContext: conversation.getResumeContext(),
		});
		const prepareAgentTurn = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getLatestAgentAttempt: () => undefined,
			getTaskRuntimeSnapshot: () => ({ agents: { [agent.agentId]: agent }, attempts: {} }),
			getRecord: () => undefined,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: agent.agentId });
		for (let index = 0; index < 64; index++) {
			mailbox.enqueue({
				kind: "follow_up",
				content: `ordinary retired task ${index}`,
				task: { kind: "agent_turn" },
			});
		}
		for (let index = 0; index < 64; index++) {
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `mandatory retired handoff ${index}`,
				senderAgentId: `child-${index}`,
				idempotencyKey: `retired-terminal-${index}`,
				task: { kind: "terminal_handoff", sourceAttemptId: `child-attempt-${index}` },
			});
		}

		coordinator.signalStateChanged();
		expect(mailbox.pendingTaskBearing()).toHaveLength(64);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(mailbox.pendingTaskBearing()).toEqual([]);
		expect(prepareAgentTurn).not.toHaveBeenCalled();
		const reopened = new WorkerConversationStore().open({
			agentDir,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: agent.agentId,
		});
		expect(
			reopened
				.getRawTranscript()
				.filter(
					(message) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.startsWith("[Worker control "),
				),
		).toHaveLength(64);
	});

	it("transfers a terminal handoff into the parent transcript when its correlated wake terminalizes", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "parent-terminal-fallback",
			logicalAgentId: "parent",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			resumeContext: conversation.getResumeContext(),
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "parent:terminal-fallback", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
			attempt = {
				...activeAttempt("queued"),
				attemptId: "attempt-parent-terminal-fallback",
				taskId: record.laneId,
				dispatch: {
					...activeAttempt("queued").dispatch,
					instructions: args.instructions,
					logicalLaneId: args.agentId,
					...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
				},
			};
			return { record, attempt };
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { parent, child },
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: () => record,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-terminal-fallback",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-terminal-fallback",
			agentId: "parent",
		});
		const handoff = {
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-terminal-fallback",
			record: { laneId: "child-task", type: "worker" as const, status: "succeeded" as const },
		};

		const accepted = coordinator.deliverWorkerTerminalHandoff(handoff);
		expect(accepted).toMatchObject({ accepted: true, started: true });
		if (!attempt) throw new Error("test attempt missing");
		attempt = { ...attempt, status: "failed" };
		coordinator.signalStateChanged();

		expect(mailbox.getMessage(accepted.messageId)).toMatchObject({
			deliveredAt: expect.any(String),
			task: { kind: "terminal_handoff", sourceAttemptId: "attempt-child-terminal-fallback" },
		});
		expect(mailbox.getMessage(accepted.messageId)).not.toHaveProperty("failedAt");
		expect(mailbox.pendingTaskBearing()).toEqual([]);
		const reopened = new WorkerConversationStore().open({
			agentDir,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: "parent",
		});
		expect(reopened.getRawTranscript()).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: expect.stringMatching(
					/childAgentId=child[\s\S]*bounded raw transcript pages[\s\S]*complete durable entries[\s\S]*omittedMessages/,
				),
			}),
		);
		expect(coordinator.deliverWorkerTerminalHandoff(handoff)).toMatchObject({
			accepted: true,
			started: false,
			messageId: accepted.messageId,
		});
	});

	it("waits for a newer target turn before transcript-settling an older terminal handoff", () => {
		const agentDir = root();
		const parentSessionId = "parent-terminal-newer-active";
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId,
			logicalAgentId: "parent",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			resumeContext: conversation.getResumeContext(),
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let wakeAttempt: AttemptRuntimeState | undefined;
		let latestAttempt: AttemptRuntimeState | undefined;
		const wakeRecord = { laneId: "parent:old-handoff", type: "worker" as const, status: "queued" as const };
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? latestAttempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { parent, child },
				attempts: Object.fromEntries(
					[wakeAttempt, latestAttempt]
						.filter((attempt): attempt is AttemptRuntimeState => attempt !== undefined)
						.map((attempt) => [attempt.attemptId, attempt]),
				),
			}),
			getRecord: (taskId: string) => (taskId === wakeRecord.laneId ? wakeRecord : undefined),
			prepareAgentTurn: vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
				wakeAttempt = {
					...activeAttempt("queued"),
					attemptId: "attempt-old-handoff",
					taskId: wakeRecord.laneId,
					dispatch: {
						...activeAttempt("queued").dispatch,
						instructions: args.instructions,
						logicalLaneId: args.agentId,
						...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
					},
				};
				latestAttempt = wakeAttempt;
				return { record: wakeRecord, attempt: wakeAttempt };
			}),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "parent" });
		const accepted = coordinator.deliverWorkerTerminalHandoff({
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-newer-active",
			record: { laneId: "child-task", type: "worker", status: "succeeded" },
		});
		if (!wakeAttempt) throw new Error("Expected correlated handoff wake.");
		wakeAttempt = { ...wakeAttempt, status: "failed" };
		latestAttempt = {
			...activeAttempt("running"),
			attemptId: "attempt-newer-parent-turn",
			taskId: "parent:newer-turn",
			dispatch: { ...activeAttempt("running").dispatch, logicalLaneId: "parent" },
		};

		coordinator.signalStateChanged();

		expect(mailbox.getMessage(accepted.messageId)).not.toHaveProperty("deliveredAt");
		expect(mailbox.pendingTaskBearing()).toEqual([expect.objectContaining({ messageId: accepted.messageId })]);
		expect(
			conversation
				.getRawTranscript()
				.filter(
					(message) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.includes(accepted.messageId),
				),
		).toEqual([]);

		latestAttempt = { ...latestAttempt, status: "failed" };
		coordinator.signalStateChanged();
		coordinator.signalStateChanged();
		expect(mailbox.getMessage(accepted.messageId)).toEqual(
			expect.objectContaining({ deliveredAt: expect.any(String) }),
		);
		expect(mailbox.pendingTaskBearing()).toEqual([]);
		const reopened = new WorkerConversationStore().open({
			agentDir,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: "parent",
		});
		expect(
			reopened
				.getRawTranscript()
				.filter(
					(message) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.includes(accepted.messageId),
				),
		).toHaveLength(1);
	});

	it("acknowledges an active-turn transcript append after a crash without scheduling a duplicate wake", () => {
		const agentDir = root();
		const parentSessionId = "parent-terminal-active-append-crash";
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId,
			logicalAgentId: "parent",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			resumeContext: conversation.getResumeContext(),
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let latestAttempt: AttemptRuntimeState = {
			...activeAttempt("running"),
			attemptId: "attempt-active-parent",
			taskId: "parent:active-turn",
			dispatch: { ...activeAttempt("running").dispatch, logicalLaneId: "parent" },
		};
		const prepareAgentTurn = vi.fn(() => {
			throw new Error("duplicate wake must not be prepared");
		});
		const enqueue = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? latestAttempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { parent, child },
				attempts: { [latestAttempt.attemptId]: latestAttempt },
			}),
			getRecord: () => undefined,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue, drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "parent" });
		const accepted = coordinator.deliverWorkerTerminalHandoff({
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-active-append",
			record: { laneId: "child-task", type: "worker", status: "succeeded" },
		});
		const retained = mailbox.getMessage(accepted.messageId);
		if (!retained) throw new Error("Expected retained active-parent handoff.");
		conversation.appendMessage({
			role: "user",
			content: `[Worker control ${retained.messageId} from=child]\n${retained.content}`,
			timestamp: Date.now(),
		});
		latestAttempt = { ...latestAttempt, status: "failed" };

		coordinator.signalStateChanged();

		expect(mailbox.getMessage(accepted.messageId)).toEqual(
			expect.objectContaining({ deliveredAt: expect.any(String) }),
		);
		expect(mailbox.pendingTaskBearing()).toEqual([]);
		expect(prepareAgentTurn).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("retains a terminal handoff when its transcript identity has divergent content", () => {
		const agentDir = root();
		const parentSessionId = "parent-terminal-divergent-transcript";
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId,
			logicalAgentId: "parent",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			resumeContext: conversation.getResumeContext(),
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "parent:divergent-handoff", type: "worker" as const, status: "queued" as const };
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { parent, child },
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: () => record,
			prepareAgentTurn: vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
				attempt = {
					...activeAttempt("queued"),
					attemptId: "attempt-divergent-handoff",
					taskId: record.laneId,
					dispatch: {
						...activeAttempt("queued").dispatch,
						instructions: args.instructions,
						logicalLaneId: args.agentId,
						...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
					},
				};
				return { record, attempt };
			}),
		} as unknown as WorkerLifecycle;
		const warn = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			warn,
		});
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "parent" });
		const accepted = coordinator.deliverWorkerTerminalHandoff({
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-divergent",
			record: { laneId: "child-task", type: "worker", status: "succeeded" },
		});
		conversation.appendMessage({
			role: "user",
			content: `[Worker control ${accepted.messageId}]\nDivergent transcript payload`,
			timestamp: Date.now(),
		});
		if (!attempt) throw new Error("Expected correlated handoff wake.");
		attempt = { ...attempt, status: "failed" };

		coordinator.signalStateChanged();

		expect(mailbox.getMessage(accepted.messageId)).not.toHaveProperty("deliveredAt");
		expect(mailbox.pendingTaskBearing()).toEqual([expect.objectContaining({ messageId: accepted.messageId })]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("transcript identity conflicts"));
	});

	it("commits a worker reply after terminal wake fallback reaches the target transcript", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "parent-reply-fallback",
			logicalAgentId: "requester",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const requester = registeredAgent({
			agentId: "requester",
			rootAgentId: "requester",
			resumeContext: conversation.getResumeContext(),
		});
		const responder = registeredAgent({
			agentId: "responder",
			parentAgentId: "requester",
			rootAgentId: "requester",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "requester:reply-fallback", type: "worker" as const, status: "queued" as const };
		const lifecycle = {
			getAgent: (agentId: string) => ({ requester, responder })[agentId as "requester" | "responder"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "requester" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { requester, responder },
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: () => record,
			prepareAgentTurn: vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
				attempt = {
					...activeAttempt("queued"),
					attemptId: "attempt-requester-reply-fallback",
					taskId: record.laneId,
					dispatch: {
						...activeAttempt("queued").dispatch,
						instructions: args.instructions,
						logicalLaneId: args.agentId,
						...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
					},
				};
				return { record, attempt };
			}),
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-reply-fallback",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const responderMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-fallback",
			agentId: "responder",
		});
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		const requesterMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-reply-fallback",
			agentId: "requester",
		});

		const accepted = coordinator.replyToWorkerAgentMessage("responder", "Exact evidence.", request.messageId);
		expect(accepted).toMatchObject({ destination: "worker", started: true });
		if (!attempt) throw new Error("test attempt missing");
		attempt = { ...attempt, status: "failed" };
		const acknowledgeDelivered = vi
			.spyOn(WorkerAgentMailbox.prototype, "acknowledgeDelivered")
			.mockImplementation(() => {
				throw new Error("simulated crash after source commit");
			});
		coordinator.signalStateChanged();
		acknowledgeDelivered.mockRestore();
		expect(requesterMailbox.pending()).toEqual([expect.objectContaining({ messageId: accepted.messageId })]);
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBe(accepted.messageId);
		for (let index = 0; index < 160; index++) {
			const history = responderMailbox.enqueue({ kind: "follow_up", content: `source crash history ${index}` });
			responderMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(responderMailbox.getMessage(request.messageId)).toBeDefined();
		coordinator.signalStateChanged();

		expect(requesterMailbox.getMessage(accepted.messageId)).toMatchObject({ deliveredAt: expect.any(String) });
		expect(requesterMailbox.getMessage(accepted.messageId)).not.toHaveProperty("failedAt");
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		expect(responderMailbox.getMessage(request.messageId)).toMatchObject({
			repliedAt: expect.any(String),
			replyReceipt: { replyMessageId: accepted.messageId },
		});
		const reopened = new WorkerConversationStore().open({
			agentDir,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: "requester",
		});
		expect(reopened.getRawTranscript()).toContainEqual(
			expect.objectContaining({ role: "user", content: expect.stringContaining("Exact evidence.") }),
		);
		expect(coordinator.replyToWorkerAgentMessage("responder", "Exact evidence.", request.messageId)).toMatchObject({
			destination: "worker",
			messageId: accepted.messageId,
			skipReason: "worker_reply_already_accepted",
		});

		const secondRequest = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return second evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(secondRequest.messageId);
		attempt = undefined;
		const secondAccepted = coordinator.replyToWorkerAgentMessage(
			"responder",
			"Second evidence.",
			secondRequest.messageId,
		);
		const secondAttempt = attempt as AttemptRuntimeState | undefined;
		if (!secondAttempt) throw new Error("second test attempt missing");
		attempt = { ...secondAttempt, status: "failed" };
		const commitReply = vi
			.spyOn(WorkerAgentMailbox.prototype, "commitReplyAcknowledgement")
			.mockImplementationOnce(() => {
				throw new Error("simulated crash after target delivery");
			});
		coordinator.signalStateChanged();
		commitReply.mockRestore();
		expect(requesterMailbox.getMessage(secondAccepted.messageId)).toMatchObject({ deliveredAt: expect.any(String) });
		expect(responderMailbox.getReplyAcknowledgementId(secondRequest.messageId)).toBe(secondAccepted.messageId);
		for (let index = 0; index < 160; index++) {
			const history = requesterMailbox.enqueue({ kind: "follow_up", content: `target crash history ${index}` });
			requesterMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(requesterMailbox.getMessage(secondAccepted.messageId)).toBeUndefined();
		expect(requesterMailbox.hasDeliveredControlReceipt(secondAccepted.messageId)).toBe(false);
		coordinator.signalStateChanged();
		expect(responderMailbox.getReplyAcknowledgementId(secondRequest.messageId)).toBeUndefined();
		expect(requesterMailbox.pending().filter((message) => message.messageId === secondAccepted.messageId)).toEqual(
			[],
		);
	});

	it("does not let throwing state observers redefine an already-drained task start", () => {
		let agent = registeredAgent();
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "worker-observer-turn", type: "worker" as const, status: "queued" as const };
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({ agents: { [agent.agentId]: agent }, attempts: {} }),
			prepareAgentTurn: vi.fn(() => {
				attempt = { ...activeAttempt("queued"), attemptId: "attempt-observer", taskId: record.laneId };
				agent = { ...agent, activeAttemptId: attempt.attemptId };
				return { record, attempt };
			}),
		} as unknown as WorkerLifecycle;
		const drain = vi.fn();
		const dropQueued = vi.fn();
		const cancelLane = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-observer",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain, track: vi.fn(), dropQueued },
			statusChanged: () => {
				throw new Error("simulated notification observer failure");
			},
			abortLane: vi.fn(),
			cancelLane,
		});
		(
			coordinator as unknown as {
				stateListeners: Set<() => void>;
			}
		).stateListeners.add(() => {
			throw new Error("simulated state listener failure");
		});

		expect(coordinator.startWorkerAgentTask("agent-1", "accepted despite observer failure")).toMatchObject({
			started: true,
			record,
		});
		expect(drain).toHaveBeenCalledOnce();
		expect(dropQueued).not.toHaveBeenCalled();
		expect(cancelLane).not.toHaveBeenCalled();
	});

	it("keeps committed controls and terminal handoffs accepted when one state listener throws", () => {
		let parent = registeredAgent({ agentId: "parent", rootAgentId: "parent" });
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		const runningRecord = { laneId: "parent-task", type: "worker" as const, status: "running" as const };
		const canceledRecord = { ...runningRecord, status: "canceled" as const };
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === "parent" ? parent : agentId === "child" ? child : undefined),
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({ agents: { parent, child }, attempts: {} }),
			getRecord: () => runningRecord,
			suspendAgent: vi.fn(),
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const drain = vi.fn();
		const track = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-committed-observers",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: true }),
			scheduler: { enqueue, drain, track, dropQueued: vi.fn() },
			statusChanged: () => {
				throw new Error("simulated status observer failure");
			},
			abortLane: vi.fn(),
			cancelLane: vi.fn(() => canceledRecord),
		});
		const observed = vi.fn();
		(
			coordinator as unknown as {
				stateListeners: Set<() => void>;
			}
		).stateListeners.add(() => {
			throw new Error("simulated state listener failure");
		});
		(
			coordinator as unknown as {
				stateListeners: Set<() => void>;
			}
		).stateListeners.add(observed);

		expect(coordinator.sendWorkerAgentMessage("parent", "durable message")).toMatchObject({ queued: true });
		attempt = { ...activeAttempt("running"), attemptId: "attempt-parent", taskId: runningRecord.laneId };
		parent = { ...parent, activeAttemptId: attempt.attemptId };
		expect(coordinator.followUpWorkerAgent("parent", "steer active parent")).toMatchObject({ steering: true });
		expect(coordinator.interruptWorkerAgent("parent")).toEqual({ interrupted: true });

		attempt = { ...attempt, status: "suspended" };
		expect(coordinator.resumeWorkerAgent("parent")).toMatchObject({ started: true, record: runningRecord });
		expect(enqueue).toHaveBeenCalledWith(runningRecord, { instructions: "recovered" }, true, false);
		expect(drain).toHaveBeenCalledOnce();
		expect(track).not.toHaveBeenCalled();
		expect(coordinator.cancelWorkerAgent("parent")).toEqual(canceledRecord);

		attempt = { ...attempt, status: "running" };
		expect(
			coordinator.deliverWorkerTerminalHandoff({
				parentAgentId: "parent",
				childAgentId: "child",
				terminalAttemptId: "attempt-child-terminal",
				record: { laneId: "child-task", type: "worker", status: "succeeded" },
			}),
		).toMatchObject({ accepted: true, started: false, messageId: expect.stringMatching(/^worker-message-/) });
		expect(observed).toHaveBeenCalledTimes(6);
	});

	it("accepts a terminal handoff before wake startup and retains it across a recoverable wake failure", () => {
		const agentDir = root();
		let parent = registeredAgent({ agentId: "parent", rootAgentId: "parent" });
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		let failPrepare = true;
		const record = { laneId: "parent:terminal-turn", type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn(() => {
			if (failPrepare) {
				failPrepare = false;
				throw new Error("simulated terminal handoff prepare failure");
			}
			attempt = { ...activeAttempt("queued"), attemptId: "attempt-terminal-parent", taskId: record.laneId };
			parent = { ...parent, activeAttemptId: attempt.attemptId };
			return { record, attempt };
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({ agents: { parent, child }, attempts: {} }),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-terminal-transaction",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const mailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-terminal-transaction",
			agentId: "parent",
		});
		const handoff = {
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-terminal-child",
			record: { laneId: "child-task", type: "worker" as const, status: "succeeded" as const },
		};

		const accepted = coordinator.deliverWorkerTerminalHandoff(handoff);
		expect(accepted).toMatchObject({ started: false, accepted: true });
		expect(mailbox.pending()).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("childAgentId=child"),
				task: { kind: "terminal_handoff", sourceAttemptId: "attempt-terminal-child" },
			}),
		]);
		coordinator.signalStateChanged();
		expect(mailbox.pending()).toHaveLength(1);
		expect(prepareAgentTurn).toHaveBeenCalledTimes(2);
		coordinator.signalStateChanged();
		expect(prepareAgentTurn).toHaveBeenCalledTimes(2);
		mailbox.acknowledgeDelivered(accepted.messageId);
		attempt = {
			...activeAttempt("cancelled"),
			attemptId: "attempt-terminal-parent",
			taskId: record.laneId,
		};
		expect(coordinator.deliverWorkerTerminalHandoff(handoff)).toMatchObject({
			messageId: accepted.messageId,
			started: false,
			accepted: true,
		});
		expect(prepareAgentTurn).toHaveBeenCalledTimes(2);
	});

	it("wakes an idle parent exactly once when a task-bearing steer missed its final active poll", () => {
		const agentDir = root();
		let parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			status: "active",
			activeAttemptId: "attempt-parent-active",
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined = {
			...activeAttempt("running"),
			attemptId: "attempt-parent-active",
			taskId: "parent:turn:1",
			dispatch: { ...activeAttempt("running").dispatch, logicalLaneId: "parent" },
		};
		const wakeAttempt = {
			...activeAttempt("queued"),
			attemptId: "attempt-parent-wake",
			taskId: "mailbox-turn-parent",
			dispatch: {
				...activeAttempt("queued").dispatch,
				logicalLaneId: "parent",
				controlMessageId: "worker-message-terminal",
			},
		};
		const record = { laneId: wakeAttempt.taskId, type: "worker" as const, status: "queued" as const };
		const prepareAgentTurn = vi.fn(() => {
			attempt = wakeAttempt;
			parent = { ...parent, status: "registered", activeAttemptId: undefined };
			return { record, attempt: wakeAttempt };
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({ agents: { parent, child }, attempts: {} }),
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId: "parent-missed-steer",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});

		const accepted = coordinator.deliverWorkerTerminalHandoff({
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-terminal",
			record: { laneId: "child-task", type: "worker", status: "succeeded" },
		});
		expect(accepted).toMatchObject({ accepted: true, started: false });
		expect(prepareAgentTurn).not.toHaveBeenCalled();

		attempt = { ...attempt!, status: "completed" };
		parent = { ...parent, status: "registered", activeAttemptId: undefined };
		coordinator.signalStateChanged();
		coordinator.signalStateChanged();
		expect(prepareAgentTurn).toHaveBeenCalledOnce();
		expect(prepareAgentTurn).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "parent", controlMessageId: accepted.messageId }),
		);

		const passivePrepare = prepareAgentTurn.mock.calls.length;
		coordinator.sendWorkerAgentMessage("parent", "queue only");
		coordinator.signalStateChanged();
		expect(prepareAgentTurn).toHaveBeenCalledTimes(passivePrepare);
	});

	it("reopens an accepted active-parent handoff and schedules its correlated turn after restart", () => {
		const agentDir = root();
		let parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			status: "active",
			activeAttemptId: "attempt-parent-active",
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined = {
			...activeAttempt("running"),
			attemptId: "attempt-parent-active",
			taskId: "parent:turn:1",
			dispatch: { ...activeAttempt("running").dispatch, logicalLaneId: "parent" },
		};
		const prepareAgentTurn = vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
			attempt = {
				...activeAttempt("queued"),
				attemptId: "attempt-parent-restarted-wake",
				taskId: "mailbox-turn-restarted-parent",
				dispatch: {
					...activeAttempt("queued").dispatch,
					instructions: args.instructions,
					logicalLaneId: args.agentId,
					...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
				},
			};
			return {
				record: { laneId: attempt.taskId, type: "worker" as const, status: "queued" as const },
				attempt,
			};
		});
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "parent" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents: { parent, child },
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: (laneId: string) =>
				attempt?.taskId === laneId ? { laneId, type: "worker" as const, status: "queued" as const } : undefined,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const options = {
			agentDir,
			parentSessionId: "parent-restarted-handoff",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false as const, skipReason: "unused" }),
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		};
		const beforeRestart = new WorkerAgentControlCoordinator({
			...options,
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
		});
		beforeRestart.sendWorkerAgentMessage("parent", "passive context only");
		const accepted = beforeRestart.deliverWorkerTerminalHandoff({
			parentAgentId: "parent",
			childAgentId: "child",
			terminalAttemptId: "attempt-child-restart",
			record: { laneId: "child-task", type: "worker", status: "succeeded" },
		});
		expect(accepted).toMatchObject({ accepted: true, started: false });
		expect(prepareAgentTurn).not.toHaveBeenCalled();

		attempt = { ...attempt, status: "completed" };
		parent = { ...parent, status: "registered", activeAttemptId: undefined };
		const enqueue = vi.fn();
		const afterRestart = new WorkerAgentControlCoordinator({
			...options,
			scheduler: { enqueue, drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
		});
		afterRestart.reconcileTaskBearingMailboxTurns();
		afterRestart.reconcileTaskBearingMailboxTurns();

		expect(prepareAgentTurn).toHaveBeenCalledOnce();
		expect(prepareAgentTurn).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "parent", controlMessageId: accepted.messageId }),
		);
		expect(enqueue).toHaveBeenCalled();
		expect(
			new WorkerAgentMailbox({
				agentDir,
				parentSessionId: "parent-restarted-handoff",
				agentId: "parent",
			}).pendingTaskBearing(),
		).toHaveLength(1);
	});
});
