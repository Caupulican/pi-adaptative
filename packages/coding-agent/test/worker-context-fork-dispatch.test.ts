import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationDispatchRequest,
	type OrchestrationProfile,
	toJsonObject,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, reduceOrchestrationEvent } from "../src/core/orchestration/task-runtime.ts";
import {
	MAX_WORKER_CONTEXT_FORK_BYTES,
	MAX_WORKER_CONTEXT_FORK_MESSAGES,
	normalizeWorkerContextForkReference,
	type WorkerContextForkReference,
} from "../src/core/orchestration/worker-context-fork-reference.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
const NOW = Date.now();

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-context-fork-dispatch-"));
	roots.push(directory);
	return directory;
}

function reference(seed = "a"): WorkerContextForkReference {
	return {
		schemaVersion: 1,
		identityDigest: seed.repeat(64),
		contentDigest: seed === "a" ? "b".repeat(64) : "c".repeat(64),
		messageCount: 3,
		messageBytes: 128,
	};
}

function dispatch(taskId: string, birthContextForkReference?: WorkerContextForkReference) {
	return {
		taskId,
		profileId: "implementer",
		instructions: `Execute ${taskId}`,
		resourcePointerIds: [],
		...(birthContextForkReference ? { birthContextForkReference } : {}),
	};
}

function profile(): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId: "implementer",
		model: { provider: "test", id: "model" },
	});
}

function executionContract(worker: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile: worker,
			modelBinding: worker.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(worker),
		},
	});
}

function completedResult(args: {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
}): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${args.attemptId}`,
		objectiveId: args.objectiveId,
		taskId: args.taskId,
		attemptId: args.attemptId,
		leaseId: args.leaseId,
		fencingToken: args.fencingToken,
		status: "completed",
		reasonCode: "worker_completed",
		summary: "completed",
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
		createdAt: new Date(NOW).toISOString(),
	};
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkerContextForkReference", () => {
	it("normalizes to a detached provider-neutral value", () => {
		const source = reference();
		const normalized = normalizeWorkerContextForkReference(source);
		const emptyReference = { ...reference(), messageCount: 0, messageBytes: 2 };

		expect(normalized).toEqual(source);
		expect(normalized).not.toBe(source);
		expect(normalizeWorkerContextForkReference(emptyReference)).toEqual(emptyReference);
		source.contentDigest = "f".repeat(64);
		expect(normalized.contentDigest).toBe("b".repeat(64));
	});

	it("rejects unsupported fields and malformed digests, counts, or byte bounds", () => {
		const invalid: unknown[] = [
			{ ...reference(), extra: true },
			{ ...reference(), identityDigest: "A".repeat(64) },
			{ ...reference(), contentDigest: "a".repeat(63) },
			{ ...reference(), messageCount: -1 },
			{ ...reference(), messageCount: 1.5 },
			{ ...reference(), messageCount: MAX_WORKER_CONTEXT_FORK_MESSAGES + 1 },
			{ ...reference(), messageBytes: 0 },
			{ ...reference(), messageBytes: 1 },
			{ ...reference(), messageCount: 1, messageBytes: 2 },
			{ ...reference(), messageBytes: 1.5 },
			{ ...reference(), messageBytes: MAX_WORKER_CONTEXT_FORK_BYTES + 1 },
		];
		for (const candidate of invalid) expect(() => normalizeWorkerContextForkReference(candidate)).toThrow();
	});
});

describe("durable context-fork dispatch", () => {
	it("persists and normalizes one detached reference through event and compacted snapshot replay", () => {
		const store = new OrchestrationEventStore({
			agentDir: root(),
			sessionId: "snapshot-replay",
			maxTailEvents: 3,
			maxTailBytes: 1_000_000,
		});
		let nextId = 1;
		const runtime = new DurableTaskRuntime({ store, now: () => NOW, createId: () => String(nextId++) });
		const objective = runtime.createObjective({ title: "Fork", description: "Persist fork identity" });
		const task = runtime.createTask({
			taskId: "worker-1",
			objectiveId: objective.objectiveId,
			title: "Worker",
			description: "Worker",
			role: "implementer",
		});
		const source = reference();
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId, source));
		source.contentDigest = "f".repeat(64);
		expect(runtime.getSnapshot().attempts[attempt.attemptId]?.dispatch.birthContextForkReference).toEqual(
			reference(),
		);
		expect(store.readProjectionSnapshot()?.throughOrdinal).toBe(3);

		const reopened = new DurableTaskRuntime({ store, now: () => NOW });
		// The shared projection is immutable: a reader cannot corrupt what a later read returns.
		const first = reopened.getSnapshot().attempts[attempt.attemptId]!.dispatch.birthContextForkReference!;
		expect(() => {
			first.contentDigest = "f".repeat(64);
		}).toThrow(TypeError);
		expect(reopened.getSnapshot().attempts[attempt.attemptId]?.dispatch.birthContextForkReference).toEqual(
			reference(),
		);
	});

	it("rejects malformed dispatch references before mutation and in forged reducer events", () => {
		const store = new OrchestrationEventStore({ agentDir: root(), sessionId: "invalid-dispatch" });
		const runtime = new DurableTaskRuntime({ store, now: () => NOW });
		const objective = runtime.createObjective({ title: "Invalid", description: "Reject invalid fork" });
		const task = runtime.createTask({
			taskId: "worker-invalid",
			objectiveId: objective.objectiveId,
			title: "Invalid worker",
			description: "Invalid worker",
			role: "implementer",
		});
		const before = runtime.getSnapshot();
		const invalidReference = { ...reference(), unsupported: "field" };
		const invalidDispatch = {
			...dispatch(task.taskId),
			birthContextForkReference: invalidReference,
		};

		expect(() =>
			runtime.queueAttempt(task.taskId, invalidDispatch as unknown as OrchestrationDispatchRequest),
		).toThrow("unsupported shape");
		expect(runtime.getSnapshot()).toEqual(before);
		expect(() =>
			reduceOrchestrationEvent(before, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: before.lastOrdinal + 1,
				eventId: "forged-invalid-fork",
				type: "attempt.queued",
				aggregateId: task.taskId,
				actor: "runtime",
				occurredAt: new Date(NOW).toISOString(),
				payload: {
					attemptId: "attempt-forged",
					taskId: task.taskId,
					dispatch: invalidDispatch,
				},
			}),
		).toThrow("unsupported shape");
		expect(before).toEqual(runtime.getSnapshot());
	});

	it("rejects a malformed reference restored from a compacted projection", () => {
		const store = new OrchestrationEventStore({ agentDir: root(), sessionId: "invalid-snapshot" });
		const runtime = new DurableTaskRuntime({ store, now: () => NOW });
		const objective = runtime.createObjective({ title: "Invalid", description: "Reject invalid snapshot" });
		const task = runtime.createTask({
			taskId: "worker-invalid-snapshot",
			objectiveId: objective.objectiveId,
			title: "Invalid snapshot worker",
			description: "Invalid snapshot worker",
			role: "implementer",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId, reference()));
		// Forge the malformed snapshot on a copy; the runtime's own projection is frozen.
		const projection = structuredClone(runtime.getSnapshot());
		projection.attempts[attempt.attemptId]!.dispatch.birthContextForkReference!.messageBytes = 1;
		const malformedSnapshotStore = {
			readProjectionSnapshot: () => ({
				throughOrdinal: projection.lastOrdinal,
				projection: toJsonObject(projection),
			}),
		} as unknown as OrchestrationEventStore;

		expect(() => new DurableTaskRuntime({ store: malformedSnapshotStore, now: () => NOW })).toThrow("byte count");
	});

	it("adopts an exact replay, rejects a conflicting reference, and inherits the original on follow-up", () => {
		const agentDir = root();
		const workerProfile = profile();
		const contract = executionContract(workerProfile);
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "ledger-reference", now: () => NOW });
		const agent = lifecycle.ensureAgent({
			agentId: "agent-persistent",
			role: "implementer",
			resumeContext: {
				provider: "pi",
				sessionId: "worker-session",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const originalReference = reference();
		const request = {
			laneId: agent.agentId,
			instructions: "Initial task",
			executionContract: contract,
			requiredCapabilities: [] as const,
			birthContextForkReference: originalReference,
		};
		const beforeMalformed = lifecycle.getTaskRuntimeSnapshot();
		expect(() =>
			lifecycle.ledger.prepare({
				...request,
				birthContextForkReference: { ...originalReference, messageBytes: 1 },
			}),
		).toThrow("byte count");
		expect(lifecycle.getTaskRuntimeSnapshot()).toEqual(beforeMalformed);
		const original = lifecycle.ledger.prepare(request);
		const replay = new DelegationOrchestrationLedger({ agentDir, sessionId: "ledger-reference", now: () => NOW });
		expect(replay.prepare(request).attemptId).toBe(original.attemptId);
		const beforeConflict = replay.runtime.getSnapshot();
		expect(() => replay.prepare({ ...request, birthContextForkReference: reference("d") })).toThrow(
			"conflicting birth context",
		);
		expect(replay.runtime.getSnapshot()).toEqual(beforeConflict);

		const task = lifecycle.getTask(original.taskId)!;
		lifecycle.bindGrant(
			original.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: task.task.taskId,
				attemptId: original.attemptId,
				role: task.task.role,
			}),
		);
		const handle = lifecycle.startAgent(original.taskId, agent.agentId, 60_000);
		lifecycle.finish(completedResult(handle), { notify: false });
		const followUp = lifecycle.prepareAgentTurn({
			agentId: agent.agentId,
			instructions: "Follow-up task",
			controlMessageId: "message-follow-up",
		});
		expect(followUp.attempt.dispatch.birthContextForkReference).toEqual(reference());
	});

	it("peeks the next lane candidate without consuming it", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "lane-candidate", now: () => NOW });
		const first = lifecycle.getNextAvailableLaneIdCandidate();
		expect(first).toBe("worker-1");
		expect(lifecycle.getNextAvailableLaneIdCandidate()).toBe(first);
		expect(lifecycle.getTaskRuntimeSnapshot().tasks).toEqual({});

		const workerProfile = profile();
		const prepared = lifecycle.prepare({
			instructions: "Use captured candidate",
			executionContract: executionContract(workerProfile),
			requiredCapabilities: [],
		});
		expect(prepared.record.laneId).toBe(first);
		expect(lifecycle.getNextAvailableLaneIdCandidate()).toBe("worker-2");
	});
});
