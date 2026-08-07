import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	type AgentResumeContext,
	isOrchestrationEvent,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
} from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, reduceOrchestrationEvent } from "../src/core/orchestration/task-runtime.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-08-07T12:00:00.000Z");

interface RuntimeHarness {
	agentDir: string;
	store: OrchestrationEventStore;
	runtime: DurableTaskRuntime;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-worker-retirement-"));
	roots.push(root);
	return root;
}

function createRuntime(sessionId = "retirement-session"): RuntimeHarness {
	const agentDir = createRoot();
	let nextId = 1;
	const store = new OrchestrationEventStore({
		agentDir,
		sessionId,
		now: () => new Date(NOW).toISOString(),
		createEventId: () => `event-${nextId++}`,
	});
	const runtime = new DurableTaskRuntime({ store, now: () => NOW, createId: () => String(nextId++) });
	return { agentDir, store, runtime };
}

function resumeContext(agentDir: string, agentId: string): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `session-${agentId}`,
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	};
}

function expectRejectedWithoutMutation(harness: RuntimeHarness, retire: () => unknown, expectedMessage: string): void {
	const projectionBefore = harness.runtime.getSnapshot();
	const eventsBefore = harness.store.readAll();
	expect(retire).toThrow(expectedMessage);
	expect(harness.runtime.getSnapshot()).toEqual(projectionBefore);
	expect(harness.store.readAll()).toEqual(eventsBefore);
}

function createRunningAgentAttempt(harness: RuntimeHarness, agentId: string) {
	const objective = harness.runtime.createObjective({
		objectiveId: `objective-${agentId}`,
		title: "Retirement guard",
		description: "Keep active workers alive",
	});
	const task = harness.runtime.createTask({
		taskId: `task-${agentId}`,
		objectiveId: objective.objectiveId,
		title: "Active work",
		description: "Exercise an active agent binding",
		role: "explorer",
	});
	const attempt = harness.runtime.queueAttempt(task.taskId, {
		taskId: task.taskId,
		profileId: "explorer",
		instructions: "Inspect the repository",
		resourcePointerIds: [],
		logicalLaneId: agentId,
	});
	harness.runtime.bindAttemptGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			role: "explorer",
		}),
	);
	const lease = harness.runtime.leaseAttempt(attempt.attemptId, agentId, 60_000, agentId);
	harness.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
	return { attempt, lease };
}

describe("durable logical-agent retirement", () => {
	it("persists one immutable retirement event and replays it idempotently after restart", () => {
		const harness = createRuntime();
		const context = resumeContext(harness.agentDir, "worker");
		const agent = harness.runtime.registerAgent({ agentId: "worker", role: "explorer", resumeContext: context });

		const retired = harness.runtime.retireAgent(agent.agentId);
		expect(retired).toMatchObject({ agentId: agent.agentId, status: "retired", resumeContext: context });
		expect(Object.keys(harness.runtime.getSnapshot().agents)).toEqual([agent.agentId]);
		expect(harness.store.readAll().at(-1)).toMatchObject({
			type: "agent.retired",
			aggregateId: agent.agentId,
			payload: { agentId: agent.agentId },
		});

		const replayed = new DurableTaskRuntime({ store: harness.store, now: () => NOW });
		const eventsBeforeReplay = harness.store.readAll();
		expect(replayed.getSnapshot().agents[agent.agentId]).toEqual(retired);
		expect(replayed.retireAgent(agent.agentId)).toEqual(retired);
		expect(harness.store.readAll()).toEqual(eventsBeforeReplay);
	});

	it("rejects active and suspended agents without appending or mutating their binding", () => {
		const harness = createRuntime("active-retirement-session");
		const agent = harness.runtime.registerAgent({
			agentId: "active-parent",
			role: "explorer",
			resumeContext: resumeContext(harness.agentDir, "active-parent"),
		});
		const { attempt, lease } = createRunningAgentAttempt(harness, agent.agentId);

		expectRejectedWithoutMutation(
			harness,
			() => harness.runtime.retireAgent(agent.agentId),
			"cannot retire from 'active'",
		);

		harness.runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: agent.agentId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			reasonCode: "test_suspension",
		});
		expectRejectedWithoutMutation(
			harness,
			() => harness.runtime.retireAgent(agent.agentId),
			"cannot retire from 'suspended'",
		);
	});

	it("rejects an idle binding that still owns queued work without mutation", () => {
		const harness = createRuntime("queued-retirement-session");
		const agent = harness.runtime.registerAgent({
			agentId: "queued-worker",
			role: "explorer",
			resumeContext: resumeContext(harness.agentDir, "queued-worker"),
		});
		const objective = harness.runtime.createObjective({ title: "Queued", description: "Queued work" });
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Queued task",
			description: "Remain associated with the logical worker",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, {
			taskId: task.taskId,
			profileId: "explorer",
			instructions: "Wait in the queue",
			resourcePointerIds: [],
			logicalLaneId: agent.agentId,
		});

		expectRejectedWithoutMutation(
			harness,
			() => harness.runtime.retireAgent(agent.agentId),
			`owns active '${attempt.status}' attempt '${attempt.attemptId}'`,
		);
	});

	it("accepts the event schema but independently rejects a forged ineligible retirement in the reducer", () => {
		const harness = createRuntime("forged-retirement-session");
		const agent = harness.runtime.registerAgent({
			agentId: "forged-worker",
			role: "explorer",
			resumeContext: resumeContext(harness.agentDir, "forged-worker"),
		});
		const { attempt } = createRunningAgentAttempt(harness, agent.agentId);
		const projection = harness.runtime.getSnapshot();
		const event: OrchestrationEvent = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			ordinal: projection.lastOrdinal + 1,
			eventId: "forged-retirement",
			type: "agent.retired",
			aggregateId: agent.agentId,
			actor: "runtime",
			occurredAt: new Date(NOW).toISOString(),
			payload: { agentId: agent.agentId },
		};

		expect(isOrchestrationEvent(event)).toBe(true);
		expect(() => reduceOrchestrationEvent(projection, event)).toThrow("cannot retire from 'active'");
		expect(projection.attempts[attempt.attemptId]).toMatchObject({ status: "running" });
		expect(projection.agents[agent.agentId]).toMatchObject({ status: "active" });
	});

	it("keeps retirement terminal when a stale agent-state event is replayed later", () => {
		const harness = createRuntime("terminal-retirement-session");
		const agent = harness.runtime.registerAgent({
			agentId: "terminal-worker",
			role: "explorer",
			resumeContext: resumeContext(harness.agentDir, "terminal-worker"),
		});
		harness.runtime.retireAgent(agent.agentId);
		const projection = harness.runtime.getSnapshot();
		const staleEvent: OrchestrationEvent = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			ordinal: projection.lastOrdinal + 1,
			eventId: "stale-agent-suspension",
			type: "agent.suspended",
			aggregateId: agent.agentId,
			actor: "runtime",
			occurredAt: new Date(NOW + 1_000).toISOString(),
			payload: { agentId: agent.agentId },
		};

		expect(isOrchestrationEvent(staleEvent)).toBe(true);
		expect(() => reduceOrchestrationEvent(projection, staleEvent)).toThrow("Agent 'terminal-worker' is retired");
		expect(projection.agents[agent.agentId]).toMatchObject({ status: "retired" });
	});

	it("requires every recursive descendant to retire before its parent", () => {
		const harness = createRuntime("descendant-retirement-session");
		const root = harness.runtime.registerAgent({
			agentId: "root",
			role: "orchestrator",
			resumeContext: resumeContext(harness.agentDir, "root"),
		});
		const child = harness.runtime.registerAgent({
			agentId: "child",
			parentAgentId: root.agentId,
			role: "implementer",
			resumeContext: resumeContext(harness.agentDir, "child"),
		});
		const grandchild = harness.runtime.registerAgent({
			agentId: "grandchild",
			parentAgentId: child.agentId,
			role: "verifier",
			resumeContext: resumeContext(harness.agentDir, "grandchild"),
		});

		expectRejectedWithoutMutation(
			harness,
			() => harness.runtime.retireAgent(root.agentId),
			"has non-retired descendant",
		);
		expectRejectedWithoutMutation(
			harness,
			() => harness.runtime.retireAgent(child.agentId),
			"has non-retired descendant 'grandchild'",
		);

		harness.runtime.retireAgent(grandchild.agentId);
		harness.runtime.retireAgent(child.agentId);
		harness.runtime.retireAgent(root.agentId);
		expect(harness.runtime.getSnapshot().agents).toMatchObject({
			root: { status: "retired" },
			child: { status: "retired" },
			grandchild: { status: "retired" },
		});
		expect(Object.keys(harness.runtime.getSnapshot().agents)).toHaveLength(3);
	});

	it("exposes the same durable transition through WorkerLifecycle", () => {
		const agentDir = createRoot();
		const sessionId = "lifecycle-retirement-session";
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const context = resumeContext(agentDir, "lifecycle-worker");
		const agent = lifecycle.ensureAgent({ agentId: "lifecycle-worker", role: "explorer", resumeContext: context });

		expect(lifecycle.retireAgent(agent.agentId)).toMatchObject({ status: "retired", resumeContext: context });
		const replayed = new WorkerLifecycle({ agentDir, sessionId });
		expect(replayed.getAgent(agent.agentId)).toMatchObject({ status: "retired", resumeContext: context });
		expect(replayed.retireAgent(agent.agentId)).toEqual(lifecycle.getAgent(agent.agentId));
	});
});
