import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import {
	DelegationOrchestrationLedger,
	type StartedDelegationAttempt,
} from "../src/core/orchestration/delegation-ledger.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, reduceOrchestrationEvent } from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
const NOW = Date.now();

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-dag-dispatch-"));
	roots.push(directory);
	return directory;
}

function runtimeHarness(sessionId: string): {
	store: OrchestrationEventStore;
	runtime: DurableTaskRuntime;
} {
	let nextId = 1;
	const store = new OrchestrationEventStore({
		agentDir: root(),
		sessionId,
		now: () => new Date(NOW).toISOString(),
		createEventId: () => `event-${nextId++}`,
	});
	return {
		store,
		runtime: new DurableTaskRuntime({ store, now: () => NOW, createId: () => String(nextId++) }),
	};
}

function dispatch(taskId: string) {
	return {
		taskId,
		profileId: "implementer",
		instructions: `Execute ${taskId}`,
		resourcePointerIds: [],
	};
}

function completedResult(handle: StartedDelegationAttempt): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${handle.attemptId}`,
		objectiveId: handle.objectiveId,
		taskId: handle.taskId,
		attemptId: handle.attemptId,
		leaseId: handle.leaseId,
		fencingToken: handle.fencingToken,
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

function executionContract(profile: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
		},
	});
}

function bindGrant(runtime: DurableTaskRuntime, attemptId: string): void {
	const snapshot = runtime.getSnapshot();
	const attempt = snapshot.attempts[attemptId];
	const task = attempt ? snapshot.tasks[attempt.taskId] : undefined;
	if (!attempt || !task) throw new Error(`Missing test attempt '${attemptId}'.`);
	runtime.bindAttemptGrant(
		attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId,
			role: task.task.role,
		}),
	);
}

function finishTask(runtime: DurableTaskRuntime, taskId: string): StartedDelegationAttempt {
	const attempt = runtime.queueAttempt(taskId, dispatch(taskId), `grant-${taskId}`);
	const lease = runtime.leaseAttempt(attempt.attemptId, `owner-${taskId}`, 60_000);
	const handle = {
		objectiveId: runtime.getSnapshot().tasks[taskId]!.task.objectiveId,
		taskId,
		attemptId: attempt.attemptId,
		leaseId: lease.leaseId,
		fencingToken: lease.fencingToken,
		expiresAt: lease.expiresAt,
	};
	runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
	runtime.finishAttempt(completedResult(handle));
	return handle;
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable dependency-gated dispatch", () => {
	it("owns one queued attempt while dependencies finish out of order and leases only after durable promotion", () => {
		const { runtime, store } = runtimeHarness("runtime-ordering");
		const objective = runtime.createObjective({
			objectiveId: "objective-dag",
			title: "DAG",
			description: "Dispatch dependency-gated work",
		});
		for (const taskId of ["dependency-a", "dependency-b"]) {
			runtime.createTask({
				taskId,
				objectiveId: objective.objectiveId,
				title: taskId,
				description: taskId,
				role: "implementer",
			});
		}
		const dependent = runtime.createTask({
			taskId: "dependent",
			objectiveId: objective.objectiveId,
			title: "Dependent",
			description: "Wait for both inputs",
			role: "implementer",
			dependsOn: ["dependency-a", "dependency-b"],
		});

		const queued = runtime.queueAttempt(dependent.taskId, dispatch(dependent.taskId), "grant-dependent");
		expect(runtime.getSnapshot().tasks[dependent.taskId]).toMatchObject({
			task: { status: "pending" },
			attemptIds: [queued.attemptId],
		});
		expect(runtime.getAttemptDispatchReadiness(queued.attemptId)).toEqual({
			state: "waiting",
			reasonCode: "dependencies_incomplete",
			attemptId: queued.attemptId,
			taskId: dependent.taskId,
			dependencyTaskIds: ["dependency-a", "dependency-b"],
		});
		expect(() => runtime.queueAttempt(dependent.taskId, dispatch(dependent.taskId))).toThrow(
			"already owns active attempt",
		);
		expect(() => runtime.leaseAttempt(queued.attemptId, "too-early", 60_000)).toThrow("dependencies are incomplete");

		finishTask(runtime, "dependency-b");
		expect(runtime.getSnapshot().tasks[dependent.taskId]?.task.status).toBe("pending");
		expect(runtime.getAttemptDispatchReadiness(queued.attemptId)).toMatchObject({
			state: "waiting",
			dependencyTaskIds: ["dependency-a"],
		});

		let reopenedId = 1;
		const reopened = new DurableTaskRuntime({
			store,
			now: () => NOW,
			createId: () => `reopened-${reopenedId++}`,
		});
		expect(reopened.getSnapshot().tasks[dependent.taskId]?.attemptIds).toEqual([queued.attemptId]);
		expect(reopened.getAttemptDispatchReadiness(queued.attemptId)).toMatchObject({
			state: "waiting",
			dependencyTaskIds: ["dependency-a"],
		});

		finishTask(reopened, "dependency-a");
		expect(reopened.getSnapshot().tasks[dependent.taskId]?.task.status).toBe("ready");
		expect(reopened.getAttemptDispatchReadiness(queued.attemptId)).toEqual({
			state: "ready",
			attemptId: queued.attemptId,
			taskId: dependent.taskId,
		});
		const lease = reopened.leaseAttempt(queued.attemptId, "dependent-owner", 60_000);
		expect(reopened.getSnapshot()).toMatchObject({
			tasks: { [dependent.taskId]: { task: { status: "running" } } },
			attempts: {
				[queued.attemptId]: { status: "leased", lease: { leaseId: lease.leaseId } },
			},
		});
	});

	it("keeps a queued attempt waiting while its objective is paused and makes it ready on resume", () => {
		const { runtime } = runtimeHarness("paused-objective");
		const objective = runtime.createObjective({ title: "Paused", description: "Pause without cancellation" });
		const task = runtime.createTask({
			taskId: "paused-task",
			objectiveId: objective.objectiveId,
			title: "Paused task",
			description: "Must survive the pause",
			role: "implementer",
		});
		const queued = runtime.queueAttempt(task.taskId, dispatch(task.taskId));

		runtime.pauseObjective(objective.objectiveId);
		expect(runtime.getAttemptDispatchReadiness(queued.attemptId)).toEqual({
			state: "waiting",
			reasonCode: "objective_paused",
			attemptId: queued.attemptId,
			taskId: task.taskId,
			objectiveStatus: "paused",
		});
		runtime.resumeObjective(objective.objectiveId);
		expect(runtime.getAttemptDispatchReadiness(queued.attemptId)).toEqual({
			state: "ready",
			attemptId: queued.attemptId,
			taskId: task.taskId,
		});
	});

	it("keeps a suspended agent attempt nonterminal while paused and resumes the same attempt afterward", () => {
		const { runtime } = runtimeHarness("paused-suspended-objective");
		const agent = runtime.registerAgent({
			agentId: "paused-agent",
			role: "implementer",
			resumeContext: {
				provider: "pi",
				sessionId: "paused-agent-session",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const objective = runtime.createObjective({ title: "Paused resume", description: "Retain suspension" });
		const task = runtime.createTask({
			taskId: "paused-suspended-task",
			objectiveId: objective.objectiveId,
			title: "Paused suspended task",
			description: "Resume only after objective activation",
			role: "implementer",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		bindGrant(runtime, attempt.attemptId);
		const lease = runtime.leaseAttempt(attempt.attemptId, agent.agentId, 60_000, agent.agentId);
		runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: lease.ownerId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			reasonCode: "agent_interrupted",
		});

		runtime.pauseObjective(objective.objectiveId);
		expect(runtime.getAttemptDispatchReadiness(attempt.attemptId)).toMatchObject({
			state: "waiting",
			reasonCode: "objective_paused",
			attemptId: attempt.attemptId,
		});
		expect(() => runtime.requestAgentResume(agent.agentId, attempt.attemptId)).toThrow("is not active");
		expect(runtime.getSnapshot().attempts[attempt.attemptId]?.status).toBe("suspended");

		runtime.resumeObjective(objective.objectiveId);
		expect(runtime.getAttemptDispatchReadiness(attempt.attemptId)).toMatchObject({ state: "ready" });
		runtime.requestAgentResume(agent.agentId, attempt.attemptId);
		runtime.resumeAttempt(attempt.attemptId, agent.agentId, 60_000, agent.agentId);
		expect(runtime.getSnapshot().attempts[attempt.attemptId]?.status).toBe("leased");
	});

	it("rejects an early or duplicate lease transition in the reducer without mutating the source projection", () => {
		const { runtime } = runtimeHarness("reducer-guard");
		const objective = runtime.createObjective({ title: "Reducer", description: "Guard replay" });
		const dependency = runtime.createTask({
			taskId: "dependency",
			objectiveId: objective.objectiveId,
			title: "Dependency",
			description: "Dependency",
			role: "implementer",
		});
		const dependent = runtime.createTask({
			taskId: "dependent",
			objectiveId: objective.objectiveId,
			title: "Dependent",
			description: "Dependent",
			role: "implementer",
			dependsOn: [dependency.taskId],
		});
		const queued = runtime.queueAttempt(dependent.taskId, dispatch(dependent.taskId), "grant-dependent");
		const projection = runtime.getSnapshot();

		expect(() =>
			reduceOrchestrationEvent(projection, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: projection.lastOrdinal + 1,
				eventId: "early-lease",
				type: "attempt.leased",
				aggregateId: queued.attemptId,
				actor: "runtime",
				occurredAt: new Date(NOW).toISOString(),
				payload: {
					lease: {
						leaseId: "lease-early",
						attemptId: queued.attemptId,
						ownerId: "owner",
						fencingToken: 1,
						issuedAt: new Date(NOW).toISOString(),
						expiresAt: new Date(NOW + 60_000).toISOString(),
					},
				},
			}),
		).toThrow("dependencies are incomplete");
		expect(projection).toEqual(runtime.getSnapshot());

		expect(() =>
			reduceOrchestrationEvent(projection, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: projection.lastOrdinal + 1,
				eventId: "duplicate-queue",
				type: "attempt.queued",
				aggregateId: dependent.taskId,
				actor: "runtime",
				occurredAt: new Date(NOW).toISOString(),
				payload: {
					attemptId: "attempt-duplicate",
					taskId: dependent.taskId,
					dispatch: dispatch(dependent.taskId),
				},
			}),
		).toThrow("already owns active attempt");
	});

	it("reports failed and cancelled dependencies as a stable non-runnable result across restart", () => {
		const { runtime, store } = runtimeHarness("terminal-dependencies");
		const objective = runtime.createObjective({ title: "Blocked DAG", description: "Surface terminal inputs" });
		for (const taskId of ["failed-input", "cancelled-input"]) {
			runtime.createTask({
				taskId,
				objectiveId: objective.objectiveId,
				title: taskId,
				description: taskId,
				role: "implementer",
			});
		}
		const dependent = runtime.createTask({
			taskId: "blocked-dependent",
			objectiveId: objective.objectiveId,
			title: "Blocked dependent",
			description: "Cannot run after terminal dependency failure",
			role: "implementer",
			dependsOn: ["failed-input", "cancelled-input"],
		});
		const queued = runtime.queueAttempt(dependent.taskId, dispatch(dependent.taskId), "grant-dependent");
		runtime.failTask("failed-input", "dependency_failed");
		const cancelled = runtime.queueAttempt("cancelled-input", dispatch("cancelled-input"));
		runtime.cancelAttempt(cancelled.attemptId, "dependency_cancelled");

		const expected = {
			state: "blocked" as const,
			reasonCode: "dependency_failed_or_cancelled" as const,
			attemptId: queued.attemptId,
			taskId: dependent.taskId,
			dependencyTaskIds: ["failed-input", "cancelled-input"],
			failedDependencyTaskIds: ["failed-input"],
			cancelledDependencyTaskIds: ["cancelled-input"],
		};
		expect(runtime.getAttemptDispatchReadiness(queued.attemptId)).toEqual(expected);
		expect(() => runtime.leaseAttempt(queued.attemptId, "owner", 60_000)).toThrow(
			"has failed or cancelled dependencies",
		);
		expect(new DurableTaskRuntime({ store, now: () => NOW }).getAttemptDispatchReadiness(queued.attemptId)).toEqual(
			expected,
		);
	});

	it("bounds dependency identities and rejects cross-objective ledger input before any mutation", () => {
		const { runtime } = runtimeHarness("validation");
		const objective = runtime.createObjective({ title: "Bounds", description: "Validate DAG inputs" });
		const beforeInvalid = runtime.getSnapshot();
		for (const dependsOn of [
			Array.from({ length: 65 }, (_, index) => `dependency-${index}`),
			["x".repeat(513)],
			["duplicate", "duplicate"],
		]) {
			expect(() =>
				runtime.createTask({
					objectiveId: objective.objectiveId,
					title: "Invalid",
					description: "Invalid dependency set",
					role: "implementer",
					dependsOn,
				}),
			).toThrow("task.dependsOn");
			expect(runtime.getSnapshot()).toEqual(beforeInvalid);
		}

		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "ledger-cross-objective" });
		const foreignObjective = ledger.runtime.createObjective({
			objectiveId: "foreign-objective",
			title: "Foreign",
			description: "Foreign",
		});
		ledger.runtime.createTask({
			taskId: "foreign-task",
			objectiveId: foreignObjective.objectiveId,
			title: "Foreign task",
			description: "Foreign task",
			role: "implementer",
		});
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "implementer",
			model: { provider: "test", id: "model" },
		});
		const beforeLedger = ledger.runtime.getSnapshot();
		expect(() =>
			ledger.prepare({
				laneId: "dependent-worker",
				instructions: "Use the foreign task",
				executionContract: executionContract(profile),
				requiredCapabilities: [],
				taskContext: {
					requirementIds: [],
					dependsOnTaskIds: ["foreign-task"],
					acceptanceCriterionIds: [],
					resourcePointerIds: [],
				},
			}),
		).toThrow("not in objective 'session:ledger-cross-objective'");
		expect(ledger.runtime.getSnapshot()).toEqual(beforeLedger);
	});

	it("replays the same ledger attempt and exposes readiness through the lifecycle boundary", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "implementer",
			model: { provider: "test", id: "model" },
		});
		const contract = executionContract(profile);
		const first = new WorkerLifecycle({ agentDir, sessionId: "lifecycle-restart", now: () => NOW });
		const prerequisite = first.prepare(
			{
				instructions: "Prepare input",
				executionContract: contract,
				requiredCapabilities: [],
			},
			"prerequisite",
		);
		const request = {
			instructions: "Consume input",
			executionContract: contract,
			requiredCapabilities: [] as const,
			taskContext: {
				requirementIds: [],
				dependsOnTaskIds: [prerequisite.attempt.taskId],
				acceptanceCriterionIds: [],
				resourcePointerIds: [],
			},
		};
		const dependent = first.prepare(request, "dependent");
		expect(first.getAttemptDispatchReadiness(dependent.attempt.attemptId)).toMatchObject({
			state: "waiting",
			dependencyTaskIds: ["prerequisite"],
		});

		const reopened = new WorkerLifecycle({ agentDir, sessionId: "lifecycle-restart", now: () => NOW });
		const replay = reopened.prepare(request, "dependent");
		expect(replay.attempt.attemptId).toBe(dependent.attempt.attemptId);
		expect(reopened.getTask("dependent")?.attemptIds).toEqual([dependent.attempt.attemptId]);
		expect(reopened.recoverQueued().map(({ attempt }) => attempt.attemptId)).toEqual(
			expect.arrayContaining([prerequisite.attempt.attemptId, dependent.attempt.attemptId]),
		);
		expect(() => reopened.start("dependent", 60_000)).toThrow("dependencies are incomplete");

		bindGrant(reopened.ledger.runtime, prerequisite.attempt.attemptId);
		const prerequisiteHandle = reopened.start("prerequisite", 60_000);
		reopened.finish(completedResult(prerequisiteHandle), { notify: false });
		expect(reopened.getAttemptDispatchReadiness(dependent.attempt.attemptId)).toMatchObject({ state: "ready" });
		bindGrant(reopened.ledger.runtime, dependent.attempt.attemptId);
		reopened.start("dependent", 60_000);
		expect(reopened.getTask("dependent")?.task.status).toBe("running");
	});

	it("persists exact reused-agent dependency identity and rejects replay order drift", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "implementer",
			model: { provider: "test", id: "model" },
		});
		const contract = executionContract(profile);
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "reused-dependencies", now: () => NOW });
		for (const dependencyId of ["dependency-a", "dependency-b"]) {
			const dependency = lifecycle.prepare(
				{ instructions: `Prepare ${dependencyId}`, executionContract: contract, requiredCapabilities: [] },
				dependencyId,
			);
			bindGrant(lifecycle.ledger.runtime, dependency.attempt.attemptId);
			const handle = lifecycle.start(dependency.record.laneId, 60_000);
			lifecycle.finish(completedResult(handle), { notify: false });
		}
		const initial = lifecycle.prepare(
			{ instructions: "Initial persistent turn", executionContract: contract, requiredCapabilities: [] },
			"persistent-agent",
		);
		lifecycle.ensureAgent({
			agentId: "persistent-agent",
			role: "implementer",
			resumeContext: {
				provider: "pi",
				sessionId: "persistent-agent-session",
				cwd: agentDir,
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		bindGrant(lifecycle.ledger.runtime, initial.attempt.attemptId);
		const initialHandle = lifecycle.startAgent("persistent-agent", "persistent-agent", 60_000);
		lifecycle.finish(completedResult(initialHandle), { notify: false });

		const input = {
			agentId: "persistent-agent",
			instructions: "Consume both dependencies",
			controlMessageId: "control-message",
			dependsOnTaskIds: ["dependency-a", "dependency-b"],
		};
		const prepared = lifecycle.prepareAgentTurn(input);

		expect(lifecycle.getTask(prepared.record.laneId)?.task.dependsOn).toEqual(["dependency-a", "dependency-b"]);
		expect(lifecycle.prepareAgentTurn(input).attempt.attemptId).toBe(prepared.attempt.attemptId);
		expect(() =>
			lifecycle.prepareAgentTurn({
				...input,
				dependsOnTaskIds: ["dependency-b", "dependency-a"],
			}),
		).toThrow("conflicting task identity");
		expect(lifecycle.getTask(prepared.record.laneId)?.attemptIds).toEqual([prepared.attempt.attemptId]);
	});
});
