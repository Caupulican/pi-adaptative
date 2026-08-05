import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
