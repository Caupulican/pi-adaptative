import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
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
		const prepareAgentTurn = vi.fn(() => {
			attempt = activeAttempt("queued");
			agent = registeredAgent({ activeAttemptId: attempt.attemptId });
			return { record, attempt };
		});
		const suspendAgent = vi.fn();
		const lifecycle = {
			getAgent: (agentId: string) => (agentId === agent.agentId ? agent : undefined),
			getTaskRuntimeSnapshot: () =>
				({ attempts: attempt ? { [attempt.attemptId]: attempt } : {} }) as TaskRuntimeProjection,
			prepareAgentTurn,
			getRecord: () => record,
			suspendAgent,
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const drain = vi.fn();
		const track = vi.fn();
		const scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "drain" | "track"> = { enqueue, drain, track };
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
		expect(prepareAgentTurn).toHaveBeenCalledWith({ agentId: "agent-1", instructions: "continue safely" });
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

	it("keeps an expected reply open until durable enqueue and reuses it after an interrupted acknowledgement", () => {
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
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn() },
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
			requesterMailbox.enqueue({ kind: "follow_up", content: `occupied ${index}` });
		}

		expect(() =>
			coordinator.sendWorkerAgentMessage("agent-1", "Exact evidence.", {
				senderAgentId: "agent-2",
				replyToMessageId: request.messageId,
			}),
		).toThrow("message limit");
		expect(responderMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);

		requesterMailbox.acknowledgeDelivered(requesterMailbox.pending()[0]!.messageId);
		const markReplied = vi.spyOn(WorkerAgentMailbox.prototype, "markReplied").mockImplementationOnce(() => {
			throw new Error("simulated reply acknowledgement interruption");
		});
		expect(() =>
			coordinator.sendWorkerAgentMessage("agent-1", "Exact evidence.", {
				senderAgentId: "agent-2",
				replyToMessageId: request.messageId,
			}),
		).toThrow("simulated reply acknowledgement interruption");
		markReplied.mockRestore();
		const committedReply = requesterMailbox.pending().find((message) => message.content === "Exact evidence.");
		expect(committedReply).toBeDefined();
		expect(responderMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);

		const retriedReply = coordinator.sendWorkerAgentMessage("agent-1", "Exact evidence.", {
			senderAgentId: "agent-2",
			replyToMessageId: request.messageId,
		});
		expect(retriedReply).toMatchObject({ queued: true, messageId: committedReply?.messageId });
		expect(requesterMailbox.pending().filter((message) => message.content === "Exact evidence.")).toHaveLength(1);
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
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn() },
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
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn() },
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
});
