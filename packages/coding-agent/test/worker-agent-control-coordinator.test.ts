import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentMailbox, workerAgentMessageId } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { type WorkerConversation, WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { type AgentBindingContract, ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
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
		expect(coordinator.resumeWorkerAgent("agent-1")).toMatchObject({ started: true, record });
		expect(track).toHaveBeenCalledWith("worker-1", expect.any(Promise));

		expect(coordinator.cancelWorkerAgent("agent-1", "owner_cancelled")).toMatchObject({ status: "canceled" });
		expect(abortLane).toHaveBeenLastCalledWith("worker-1", "owner_cancelled");
		expect(cancelLane).toHaveBeenCalledWith("worker-1", "owner_cancelled");
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

	it("limits peer visibility to one tree and destructive control to the caller's subtree", () => {
		const rootAgent = registeredAgent({ agentId: "root", rootAgentId: "root" });
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "root",
			rootAgentId: "root",
			depth: 1,
		});
		const sibling = registeredAgent({
			agentId: "sibling",
			parentAgentId: "root",
			rootAgentId: "root",
			depth: 1,
		});
		const foreign = registeredAgent({ agentId: "foreign", rootAgentId: "foreign" });
		const agents = { root: rootAgent, child, sibling, foreign };
		const attempts = {
			"attempt-root": { ...activeAttempt("running"), attemptId: "attempt-root", taskId: "root" },
			"attempt-child": { ...activeAttempt("running"), attemptId: "attempt-child", taskId: "child" },
			"attempt-sibling": { ...activeAttempt("running"), attemptId: "attempt-sibling", taskId: "sibling" },
		};
		const lifecycle = {
			getAgent: (agentId: string) => agents[agentId as keyof typeof agents],
			getTaskRuntimeSnapshot: () => ({ agents, attempts }),
			getLatestAgentAttempt: (agentId: string) =>
				attempts[`attempt-${agentId}` as keyof typeof attempts] as AttemptRuntimeState | undefined,
		} as unknown as WorkerLifecycle;
		const cancelLane = vi.fn(() => ({ laneId: "child", type: "worker" as const, status: "canceled" as const }));
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
			cancelLane,
		});

		expect(coordinator.listWorkerAgents({ callerAgentId: "child" }).map((agent) => agent.agentId)).toEqual([
			"root",
			"child",
			"sibling",
		]);
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

	it("waits on a queued stable agent id while yielding and restoring the caller's scheduler slot", async () => {
		const parent = registeredAgent({
			agentId: "parent",
			rootAgentId: "parent",
			status: "active",
			activeAttemptId: "attempt-parent",
		});
		const child = registeredAgent({
			agentId: "child",
			parentAgentId: "parent",
			rootAgentId: "parent",
			depth: 1,
		});
		let childAttempt = {
			...activeAttempt("queued"),
			attemptId: "attempt-child",
			taskId: "child",
			dispatch: { ...activeAttempt("queued").dispatch, logicalLaneId: "child" },
		};
		const lifecycle = {
			getAgent: (agentId: string) => ({ parent, child })[agentId as "parent" | "child"],
			getLatestAgentAttempt: (agentId: string) => (agentId === "child" ? childAttempt : activeAttempt("running")),
			getTaskRuntimeSnapshot: () => ({ agents: { parent, child }, attempts: { "attempt-child": childAttempt } }),
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

		const waiting = coordinator.waitForWorkerAgent("child", 10_000, { callerAgentId: "parent" });
		expect(yieldCapacity).toHaveBeenCalledWith("parent", "child");
		childAttempt = { ...childAttempt, status: "completed" };
		coordinator.signalStateChanged();

		await expect(waiting).resolves.toEqual({ status: "idle" });
		expect(releaseYield).toHaveBeenCalledOnce();
	});

	it("reports activity without yielding capacity and atomically rejects a competing task start", () => {
		const agentDir = root();
		let agent = registeredAgent();
		const otherAgent = registeredAgent({ agentId: "agent-2" });
		let attempt: AttemptRuntimeState | undefined;
		const record = { laneId: "worker-1:turn:2", type: "worker" as const, status: "queued" as const };
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
		const lifecycle = {
			getAgent: (agentId: string) =>
				agentId === agent.agentId ? agent : agentId === otherAgent.agentId ? otherAgent : undefined,
			getLatestAgentAttempt: () => attempt,
			getTaskRuntimeSnapshot: () => ({
				agents: { [agent.agentId]: agent, [otherAgent.agentId]: otherAgent },
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
		});
		expect(first).toMatchObject({
			started: true,
			steering: false,
			record,
		});
		expect(
			coordinator.startWorkerAgentTask("agent-1", "first task", { idempotencyKey: "host-start-call-1" }),
		).toEqual(first);
		expect(() =>
			coordinator.startWorkerAgentTask("agent-1", "drifted task", { idempotencyKey: "host-start-call-1" }),
		).toThrow("idempotency identity conflicts");
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
		// Explicit follow-up remains the intentional steering path for an active task.
		expect(coordinator.followUpWorkerAgent("agent-1", "steer active task")).toMatchObject({
			started: false,
			steering: true,
		});
		if (!attempt) throw new Error("Expected active attempt.");
		attempt = { ...attempt, status: "completed" };
		expect(
			coordinator.startWorkerAgentTask("agent-1", "first task", { idempotencyKey: "host-start-call-1" }),
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
			coordinator.startWorkerAgentTask("agent-1", "first task", { idempotencyKey: "host-start-call-1" }),
		).toEqual(first);
		expect(() =>
			coordinator.startWorkerAgentTask("agent-1", "drifted after eviction", {
				idempotencyKey: "host-start-call-1",
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
				(args: { agentId: string; instructions: string; controlMessageId?: string }) => {
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

			const accepted = coordinator.startWorkerAgentTask(agent.agentId, `survive ${failurePoint}`);
			expect(accepted.messageId).toMatch(/^worker-message-/);
			expect(accepted.skipReason).toContain(`simulated ${failurePoint} failure`);
			expect(mailbox.pendingTaskBearing()).toEqual([
				expect.objectContaining({ messageId: accepted.messageId, task: { kind: "agent_turn" } }),
			]);
			expect(abortLane).not.toHaveBeenCalled();
			expect(cancelLane).not.toHaveBeenCalled();
			expect(dropQueued).not.toHaveBeenCalled();

			coordinator.signalStateChanged();
			coordinator.signalStateChanged();
			expect(prepareAgentTurn).toHaveBeenCalledTimes(failurePoint === "prepare" ? 2 : 1);
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
				content: expect.stringContaining("childAgentId=child"),
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
		const track = vi.fn();
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir: root(),
			parentSessionId: "parent-committed-observers",
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: true }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track, dropQueued: vi.fn() },
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
		expect(track).toHaveBeenCalledOnce();
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
