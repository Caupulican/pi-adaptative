import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../src/core/autonomy/contracts.ts";
import { buildPiResumeLaunchSpec } from "../src/core/orchestration/agent-resume.ts";
import {
	type ApprovalRequestContract,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
	type OrchestrationEventType,
	toJsonObject,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import {
	DurableTaskRuntime,
	DurableTaskRuntimeError,
	reduceOrchestrationEvent,
	type TaskRuntimeProjection,
} from "../src/core/orchestration/task-runtime.ts";
import { projectionFromSnapshot } from "../src/core/orchestration/task-runtime-codecs.ts";
import { buildResumablePiAgentWakePrompt } from "../src/core/process-matrix/resume-launcher.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

interface Harness {
	agentDir: string;
	clock: { ms: number };
	store: OrchestrationEventStore;
	runtime: DurableTaskRuntime;
}

const tempDirs: string[] = [];
const T0 = Date.parse("2026-07-23T12:00:00.000Z");

function dispatch(taskId: string, profileId = "worker-default") {
	return { taskId, profileId, instructions: `Execute ${taskId}`, resourcePointerIds: [] };
}

function createHarness(): Harness {
	const agentDir = join(tmpdir(), `pi-durable-runtime-${process.pid}-${tempDirs.length}-${Date.now()}`);
	mkdirSync(agentDir, { recursive: true });
	tempDirs.push(agentDir);
	const clock = { ms: T0 };
	let nextId = 1;
	const store = new OrchestrationEventStore({
		agentDir,
		sessionId: "session-1",
		now: () => new Date(clock.ms).toISOString(),
		createEventId: () => `event-${nextId++}`,
	});
	const runtime = new DurableTaskRuntime({
		store,
		now: () => clock.ms,
		createId: () => String(nextId++),
	});
	return { agentDir, clock, store, runtime };
}

function completedResult(args: {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
	status?: WorkerResultContract["status"];
	evidence?: WorkerResultContract["evidence"];
}): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${args.attemptId}`,
		objectiveId: args.objectiveId,
		taskId: args.taskId,
		attemptId: args.attemptId,
		leaseId: args.leaseId,
		fencingToken: args.fencingToken,
		status: args.status ?? "completed",
		reasonCode: `worker_${args.status ?? "completed"}`,
		summary: "worker finished",
		artifacts: [],
		evidence: args.evidence ?? [],
		errors: [],
		usage: { wallClockMs: 10, toolCalls: 1 },
		createdAt: new Date(T0).toISOString(),
	};
}

function forgedEvent(
	projection: TaskRuntimeProjection,
	type: OrchestrationEventType,
	aggregateId: string,
	payload: JsonObject,
): OrchestrationEvent {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		ordinal: projection.lastOrdinal + 1,
		eventId: `forged-${type}-${projection.lastOrdinal + 1}`,
		type,
		aggregateId,
		actor: "runtime",
		occurredAt: new Date(T0).toISOString(),
		payload,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("DurableTaskRuntime", () => {
	it("adopts every intervening ordinal when an append resolves to an exact idempotent replay", () => {
		const harness = createHarness();
		const append = harness.store.append.bind(harness.store);
		const peer = new OrchestrationEventStore({ agentDir: harness.agentDir, sessionId: "session-1" });
		vi.spyOn(harness.store, "append").mockImplementationOnce((input, options) => {
			append(input);
			const firstObjective = input.payload.objective as JsonObject;
			peer.append({
				type: "objective.created",
				aggregateId: "objective-intervening",
				actor: "kernel",
				idempotencyKey: "objective-created:objective-intervening",
				payload: toJsonObject({
					objective: {
						...firstObjective,
						objectiveId: "objective-intervening",
						title: "Intervening writer",
					},
				}),
			});
			return append(input, options);
		});

		harness.runtime.createObjective({
			objectiveId: "objective-requested",
			title: "Requested writer",
			description: "Race an exact replay with an intervening commit",
		});
		const snapshot = harness.runtime.getSnapshot();
		expect(snapshot.lastOrdinal).toBe(2);
		expect(Object.keys(snapshot.objectives).sort()).toEqual(["objective-intervening", "objective-requested"]);
		expect(() =>
			reduceOrchestrationEvent(
				{ ...snapshot, lastOrdinal: 0, objectives: {} },
				{ ...harness.store.readAll()[1]!, ordinal: 2 },
			),
		).toThrow(/ordinal 2 is not contiguous after 0/i);
	});

	it("rejects oversized persisted dispatch fields before appending an attempt event", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			title: "Bound dispatch",
			description: "Keep durable dispatch compact",
		});
		const task = runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Bounded worker",
			description: "Reject unbounded worker input before persistence",
			role: "implementer",
		});

		expect(() =>
			runtime.queueAttempt(task.taskId, {
				taskId: task.taskId,
				profileId: "worker-default",
				instructions: "x".repeat(16 * 1024 + 1),
				resourcePointerIds: Array.from({ length: 65 }, (_, index) => `resource-${index}`),
			}),
		).toThrow("dispatch.instructions exceeds its durable size bound");
		expect(() =>
			runtime.queueAttempt(task.taskId, {
				taskId: task.taskId,
				profileId: "worker-default",
				instructions: "bounded instructions",
				resourcePointerIds: Array.from({ length: 65 }, (_, index) => `resource-${index}`),
			}),
		).toThrow("dispatch.resourcePointerIds must be a bounded identifier array");
		expect(runtime.getSnapshot().attempts).toEqual({});
	});

	it("rejects forged lifecycle events at the reducer boundary without mutating their source projection", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-authority",
			title: "Reducer authority",
			description: "Reject transitions that bypass command admission",
			acceptanceCriteria: [{ id: "criterion", description: "Required proof", required: true }],
		});
		const task = runtime.createTask({
			taskId: "task-authority",
			objectiveId: objective.objectiveId,
			title: "Owned task",
			description: "Keep lifecycle ownership centralized",
			role: "implementer",
			acceptanceCriterionIds: ["criterion"],
		});
		const queued = runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-authority");
		const queuedProjection = runtime.getSnapshot();

		const queuedCases: Array<{ event: OrchestrationEvent; message: RegExp }> = [
			{
				event: forgedEvent(
					queuedProjection,
					"objective.completed",
					objective.objectiveId,
					toJsonObject({ completionPolicy: "task_evidence" }),
				),
				message: /incomplete tasks/i,
			},
			{
				event: forgedEvent(
					queuedProjection,
					"task.failed",
					task.taskId,
					toJsonObject({ taskId: task.taskId, reasonCode: "forged" }),
				),
				message: /still owns active attempt/i,
			},
			{
				event: forgedEvent(
					queuedProjection,
					"attempt.started",
					queued.attemptId,
					toJsonObject({ attemptId: queued.attemptId, leaseId: "lease-forged", fencingToken: 1 }),
				),
				message: /is not leased/i,
			},
			{
				event: forgedEvent(
					queuedProjection,
					"objective.evidence_recorded",
					objective.objectiveId,
					toJsonObject({
						evidence: {
							evidenceId: "evidence-forged",
							criterionId: "criterion-unknown",
							kind: "test",
							summary: "forged",
							artifactIds: [],
							trusted: true,
							createdAt: new Date(T0).toISOString(),
						},
					}),
				),
				message: /unknown acceptance criterion/i,
			},
			{
				event: forgedEvent(
					queuedProjection,
					"objective.updated",
					objective.objectiveId,
					toJsonObject({
						objective: {
							...queuedProjection.objectives[objective.objectiveId]!.objective,
							acceptanceCriteria: [],
						},
					}),
				),
				message: /acceptance criteria referenced by tasks/i,
			},
		];
		for (const candidate of queuedCases) {
			const before = structuredClone(queuedProjection);
			expect(() => reduceOrchestrationEvent(queuedProjection, candidate.event)).toThrow(candidate.message);
			expect(queuedProjection).toEqual(before);
		}

		const dispatchProjection = structuredClone(queuedProjection);
		delete (dispatchProjection.attempts as Record<string, unknown>)[queued.attemptId];
		(dispatchProjection.tasks[task.taskId] as { attemptIds: readonly string[] }).attemptIds = [];
		const invalidDispatch = {
			...dispatch(task.taskId),
			executionContract: null,
		};
		expect(() =>
			reduceOrchestrationEvent(
				dispatchProjection,
				forgedEvent(
					dispatchProjection,
					"attempt.queued",
					task.taskId,
					toJsonObject({
						attemptId: "attempt-null-contract",
						taskId: task.taskId,
						dispatch: invalidDispatch,
					}),
				),
			),
		).toThrow(/execution contract is invalid/i);
	});

	it("rejects forged result and verification ownership while preserving inconclusive no-result recovery", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-verifier-authority",
			title: "Verification authority",
			description: "Only reconcile independently owned verifier outcomes",
		});
		const subject = runtime.createTask({
			taskId: "task-subject-authority",
			objectiveId: objective.objectiveId,
			title: "Subject",
			description: "Implementation subject",
			role: "implementer",
		});
		const unrelated = runtime.createTask({
			taskId: "task-unrelated-authority",
			objectiveId: objective.objectiveId,
			title: "Unrelated",
			description: "Different result owner",
			role: "implementer",
		});
		const subjectAttempt = runtime.queueAttempt(subject.taskId, dispatch(subject.taskId), "grant-subject");
		const subjectLease = runtime.leaseAttempt(subjectAttempt.attemptId, "subject-worker", 60_000);
		runtime.startAttempt(subjectAttempt.attemptId, subjectLease.leaseId, subjectLease.fencingToken);
		const running = runtime.getSnapshot();
		const crossResult = completedResult({
			objectiveId: objective.objectiveId,
			taskId: unrelated.taskId,
			attemptId: subjectAttempt.attemptId,
			leaseId: subjectLease.leaseId,
			fencingToken: subjectLease.fencingToken,
		});
		expect(() =>
			reduceOrchestrationEvent(
				running,
				forgedEvent(running, "attempt.finished", subjectAttempt.attemptId, toJsonObject({ result: crossResult })),
			),
		).toThrow(/taskId does not match attempt/i);

		runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: subject.taskId,
				attemptId: subjectAttempt.attemptId,
				leaseId: subjectLease.leaseId,
				fencingToken: subjectLease.fencingToken,
				status: "partial",
			}),
		);
		const verifier = runtime.createTask({
			taskId: "task-verifier-authority",
			objectiveId: objective.objectiveId,
			title: "Verifier",
			description: "Independent verifier",
			role: "verifier",
			verificationOfTaskId: subject.taskId,
		});
		const verifierAttempt = runtime.queueAttempt(verifier.taskId, dispatch(verifier.taskId, "verifier"), "grant-v");
		const queuedVerifier = runtime.getSnapshot();
		expect(() =>
			reduceOrchestrationEvent(
				queuedVerifier,
				forgedEvent(
					queuedVerifier,
					"task.verification_finished",
					subject.taskId,
					toJsonObject({
						taskId: subject.taskId,
						verifierTaskId: verifier.taskId,
						verifierAttemptId: verifierAttempt.attemptId,
						verdict: "accepted",
						reasonCode: "forged",
					}),
				),
			),
		).toThrow(/not terminal/i);

		runtime.cancelAttempt(verifierAttempt.attemptId, "verifier_transport_failed");
		runtime.finishVerification({
			taskId: subject.taskId,
			verifierTaskId: verifier.taskId,
			verifierAttemptId: verifierAttempt.attemptId,
			verdict: "inconclusive",
			reasonCode: "verifier_no_result",
		});
		expect(runtime.getSnapshot().tasks[subject.taskId]?.verification?.verdict).toBe("inconclusive");
	});

	it("rejects invalid objective and task budgets through the shared contract", () => {
		const { runtime } = createHarness();
		expect(() =>
			runtime.createObjective({
				title: "Invalid",
				description: "Invalid objective budget",
				riskBudget: { maxCostUsd: -1 },
			}),
		).toThrow("objective.riskBudget.maxCostUsd must be non-negative");

		const objective = runtime.createObjective({ title: "Valid", description: "Valid objective" });
		expect(() =>
			runtime.createTask({
				objectiveId: objective.objectiveId,
				title: "Invalid task",
				description: "Invalid task budget",
				role: "operator",
				riskBudget: { maxWallClockMs: Number.NaN },
			}),
		).toThrow("task.riskBudget.maxWallClockMs must be non-negative");
		expect(() =>
			runtime.createTask({
				objectiveId: objective.objectiveId,
				title: "Fractional attempts",
				description: "Invalid discrete budget",
				role: "operator",
				riskBudget: { maxAttempts: 1.5 },
			}),
		).toThrow("task.riskBudget.maxAttempts must be a non-negative safe integer");
	});

	it("runs a dependency DAG through leased attempts and unlocks dependents", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-1",
			title: "Overhaul harness",
			description: "Make orchestration durable",
			acceptanceCriteria: [{ id: "criterion-1", description: "Replay succeeds", required: true }],
			riskBudget: { maxAttempts: 2 },
		});
		const explore = runtime.createTask({
			taskId: "task-explore",
			objectiveId: objective.objectiveId,
			title: "Explore",
			description: "Collect evidence",
			role: "explorer",
			requiredCapabilities: ["filesystem.read"],
		});
		const build = runtime.createTask({
			taskId: "task-build",
			objectiveId: objective.objectiveId,
			title: "Build",
			description: "Implement changes",
			role: "implementer",
			dependsOn: [explore.taskId],
			requiredCapabilities: ["worktree.mutate"],
		});
		expect(build.status).toBe("pending");

		const attempt = runtime.queueAttempt(explore.taskId, dispatch(explore.taskId), "grant-1");
		const lease = runtime.leaseAttempt(attempt.attemptId, "worker-1", 60_000);
		runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		const checkpoint = runtime.checkpointAttempt({
			attemptId: attempt.attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			summary: "Repository inspected",
			evidenceIds: ["evidence-1"],
		});
		runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: explore.taskId,
				attemptId: attempt.attemptId,
				leaseId: lease.leaseId,
				fencingToken: lease.fencingToken,
			}),
		);

		const snapshot = runtime.getSnapshot();
		expect(snapshot.tasks[explore.taskId]?.task.status).toBe("completed");
		expect(snapshot.tasks[build.taskId]?.task.status).toBe("ready");
		expect(snapshot.attempts[attempt.attemptId]?.checkpointIds).toEqual([checkpoint.checkpointId]);
	});

	it("persists one complete fenced cumulative usage snapshot and rejects malformed checkpoints", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({ title: "Usage", description: "Persist active usage" });
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Measure",
			description: "Checkpoint cumulative worker usage",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-usage");
		const lease = harness.runtime.leaseAttempt(attempt.attemptId, "worker-usage", 60_000);
		harness.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);

		const usage = {
			toolCalls: 2,
			inputTokens: 11,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 2,
			totalTokens: 23,
			costUsd: 0.25,
			activeWallClockMs: 350,
		};
		const checkpoint = harness.runtime.checkpointAttempt({
			attemptId: attempt.attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			summary: "Usage persisted before restart",
			usage,
		});
		expect(checkpoint.usage).toEqual(usage);
		expect(
			new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms }).getSnapshot().checkpoints[
				checkpoint.checkpointId
			]?.usage,
		).toEqual(usage);

		expect(() =>
			harness.runtime.checkpointAttempt({
				attemptId: attempt.attemptId,
				leaseId: lease.leaseId,
				fencingToken: lease.fencingToken,
				summary: "Malformed usage",
				usage: { ...usage, inputTokens: -1 },
			}),
		).toThrow("checkpoint.usage.inputTokens");
	});

	it("reopens and catches up from a compacted projection while keeping the event tail bounded", () => {
		const agentDir = join(tmpdir(), `pi-durable-runtime-bounded-${process.pid}-${Date.now()}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		const store = new OrchestrationEventStore({
			agentDir,
			sessionId: "bounded-session",
			maxTailEvents: 3,
			maxTailBytes: 1_000_000,
		});
		const stale = new DurableTaskRuntime({ store });
		const runtime = new DurableTaskRuntime({ store });
		const objective = runtime.createObjective({
			objectiveId: "bounded-objective",
			title: "Bound history",
			description: "Retain current truth without retaining the full event prefix",
		});
		const task = runtime.createTask({
			taskId: "bounded-task",
			objectiveId: objective.objectiveId,
			title: "Run",
			description: "Run after compaction",
			role: "implementer",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId));

		// A read boundary performs maintenance once the configured tail threshold is reached.
		expect(runtime.getSnapshot().lastOrdinal).toBe(3);
		expect(readdirSync(store.eventsDir)).toEqual([]);
		expect(store.readProjectionSnapshot()?.throughOrdinal).toBe(3);

		const reopened = new DurableTaskRuntime({ store });
		expect(reopened.getSnapshot()).toMatchObject({
			lastOrdinal: 3,
			objectives: { [objective.objectiveId]: { objective: { title: "Bound history" } } },
			tasks: { [task.taskId]: { attemptIds: [attempt.attemptId] } },
		});
		expect(stale.getSnapshot().lastOrdinal).toBe(3);

		const grant = createTestExecutionGrant({
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
		});
		reopened.bindAttemptGrant(attempt.attemptId, grant);
		expect(reopened.getSnapshot().attempts[attempt.attemptId]?.grant).toEqual(grant);
		expect(reopened.getSnapshot().lastOrdinal).toBe(4);
	});

	it("rebuilds from a snapshot installed between the initial snapshot read and tail read", () => {
		const { runtime, store } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "startup-race-objective",
			title: "Preserve baseline",
			description: "Compaction must not erase the replay prefix during construction",
		});
		store.compactIfNeeded(runtime.getSnapshot().lastOrdinal, () => runtime.getSnapshot() as unknown as JsonObject);
		runtime.createTask({
			taskId: "startup-race-task",
			objectiveId: objective.objectiveId,
			title: "Tail event",
			description: "Arrives after compaction",
			role: "implementer",
		});
		const originalReadProjectionSnapshot = store.readProjectionSnapshot.bind(store);
		let hideInitialSnapshot = true;
		vi.spyOn(store, "readProjectionSnapshot").mockImplementation(() => {
			if (hideInitialSnapshot) {
				hideInitialSnapshot = false;
				return undefined;
			}
			return originalReadProjectionSnapshot();
		});

		const reopened = new DurableTaskRuntime({ store });
		expect(reopened.getSnapshot()).toMatchObject({
			objectives: { [objective.objectiveId]: { objective: { title: "Preserve baseline" } } },
			tasks: { "startup-race-task": { task: { title: "Tail event" } } },
		});
	});

	it("requires trusted evidence before completing criterion-bound tasks and objectives", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-proof",
			title: "Prove acceptance",
			description: "Require deterministic evidence",
			acceptanceCriteria: [{ id: "criterion-1", description: "Focused test passes", required: true }],
		});
		expect(() =>
			runtime.createTask({
				objectiveId: objective.objectiveId,
				title: "Unknown criterion",
				description: "Invalid reference",
				role: "verifier",
				acceptanceCriterionIds: ["missing"],
			}),
		).toThrow("unknown acceptance criteria");
		const task = runtime.createTask({
			taskId: "task-proof",
			objectiveId: objective.objectiveId,
			title: "Verify",
			description: "Run focused proof",
			role: "verifier",
			acceptanceCriterionIds: ["criterion-1"],
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-proof");
		const lease = runtime.leaseAttempt(attempt.attemptId, "verifier-1", 60_000);
		runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		const resultBase = {
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
		};
		expect(() => runtime.finishAttempt(completedResult(resultBase))).toThrow(
			"lacks trusted evidence for acceptance criteria",
		);
		runtime.finishAttempt(
			completedResult({
				...resultBase,
				evidence: [
					{
						evidenceId: "evidence-1",
						criterionId: "criterion-1",
						kind: "test",
						summary: "Focused test passed",
						artifactIds: [],
						trusted: true,
						createdAt: new Date(T0).toISOString(),
					},
				],
			}),
		);
		runtime.completeObjective(objective.objectiveId);
		expect(runtime.getSnapshot().objectives[objective.objectiveId]?.objective.status).toBe("completed");
	});

	it("persists owner evidence per criterion and completes by cancelling remaining execution", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({
			objectiveId: "objective-owner-proof",
			title: "Owner acceptance",
			description: "Use the canonical goal evidence",
			acceptanceCriteria: [
				{ id: "criterion-1", description: "First proof", required: true },
				{ id: "criterion-2", description: "Second proof", required: true },
			],
		});
		const task = harness.runtime.createTask({
			taskId: "task-still-running",
			objectiveId: objective.objectiveId,
			title: "Residual work",
			description: "Must stop after owner acceptance",
			role: "operator",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		for (const criterionId of ["criterion-1", "criterion-2"] as const) {
			harness.runtime.recordObjectiveEvidence(objective.objectiveId, {
				evidenceId: `evidence-${criterionId}`,
				criterionId,
				kind: "external",
				summary: `Owner proved ${criterionId}`,
				artifactIds: [],
				trusted: true,
				createdAt: new Date(T0).toISOString(),
			});
		}

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		reopened.completeObjectiveFromOwner(objective.objectiveId, false);

		const snapshot = reopened.getSnapshot();
		expect(snapshot.objectives[objective.objectiveId]).toMatchObject({
			objective: { status: "completed" },
			evidence: [{ criterionId: "criterion-1" }, { criterionId: "criterion-2" }],
		});
		expect(snapshot.tasks[task.taskId]?.task.status).toBe("cancelled");
		expect(snapshot.attempts[attempt.attemptId]?.status).toBe("cancelled");
	});

	it("rejects owner completion when any required criterion lacks trusted evidence", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			title: "Incomplete owner acceptance",
			description: "Reject partial proof",
			acceptanceCriteria: [
				{ id: "criterion-1", description: "First proof", required: true },
				{ id: "criterion-2", description: "Second proof", required: true },
			],
		});
		runtime.recordObjectiveEvidence(objective.objectiveId, {
			evidenceId: "evidence-1",
			criterionId: "criterion-1",
			kind: "external",
			summary: "Only the first criterion is proven",
			artifactIds: [],
			trusted: true,
			createdAt: new Date(T0).toISOString(),
		});

		expect(() => runtime.completeObjectiveFromOwner(objective.objectiveId, false)).toThrow("criterion-2");
	});

	it("reconciles an implementation only after a separate verifier attempt records trusted review evidence", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-verification",
			title: "Verify independently",
			description: "Keep implementation blocked until a verifier accepts it",
			acceptanceCriteria: [{ id: "criterion-1", description: "Implementation is proven", required: true }],
		});
		const implementation = runtime.createTask({
			taskId: "task-implementation",
			objectiveId: objective.objectiveId,
			title: "Implement",
			description: "Implement the change",
			role: "implementer",
			acceptanceCriterionIds: ["criterion-1"],
		});
		const implementationAttempt = runtime.queueAttempt(
			implementation.taskId,
			dispatch(implementation.taskId),
			"grant-implementation",
		);
		const implementationLease = runtime.leaseAttempt(implementationAttempt.attemptId, "implementer", 60_000);
		runtime.startAttempt(
			implementationAttempt.attemptId,
			implementationLease.leaseId,
			implementationLease.fencingToken,
		);
		runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: implementation.taskId,
				attemptId: implementationAttempt.attemptId,
				leaseId: implementationLease.leaseId,
				fencingToken: implementationLease.fencingToken,
				status: "partial",
			}),
		);
		const verifier = runtime.createTask({
			taskId: "task-verifier",
			objectiveId: objective.objectiveId,
			title: "Verify",
			description: "Independently verify the implementation",
			role: "verifier",
			verificationOfTaskId: implementation.taskId,
			acceptanceCriterionIds: ["criterion-1"],
		});
		const verifierAttempt = runtime.queueAttempt(
			verifier.taskId,
			dispatch(verifier.taskId, "verifier"),
			"grant-verifier",
		);
		const verifierLease = runtime.leaseAttempt(verifierAttempt.attemptId, "verifier", 60_000);
		runtime.startAttempt(verifierAttempt.attemptId, verifierLease.leaseId, verifierLease.fencingToken);
		runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: verifier.taskId,
				attemptId: verifierAttempt.attemptId,
				leaseId: verifierLease.leaseId,
				fencingToken: verifierLease.fencingToken,
				evidence: [
					{
						evidenceId: "review-1",
						criterionId: "criterion-1",
						kind: "review",
						summary: "Focused verification passed",
						artifactIds: [],
						trusted: true,
						createdAt: new Date(T0).toISOString(),
						metadata: { subjectTaskId: implementation.taskId, verdict: "accepted" },
					},
				],
			}),
		);

		runtime.finishVerification({
			taskId: implementation.taskId,
			verifierTaskId: verifier.taskId,
			verifierAttemptId: verifierAttempt.attemptId,
			verdict: "accepted",
			reasonCode: "independent_verification_accepted",
		});
		runtime.completeObjective(objective.objectiveId);

		const snapshot = runtime.getSnapshot();
		expect(snapshot.tasks[implementation.taskId]).toMatchObject({
			task: { status: "completed" },
			verification: { verifierTaskId: verifier.taskId, verdict: "accepted" },
		});
		expect(snapshot.objectives[objective.objectiveId]?.objective.status).toBe("completed");
	});

	it("recovers from restart, expires a lease, and fences the stale worker", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({
			objectiveId: "objective-1",
			title: "Recover",
			description: "Recover attempts",
			riskBudget: { maxAttempts: 2 },
		});
		const task = harness.runtime.createTask({
			taskId: "task-1",
			objectiveId: objective.objectiveId,
			title: "Run",
			description: "Run a worker",
			role: "operator",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-recovery");
		const lease = harness.runtime.leaseAttempt(attempt.attemptId, "worker-1", 1_000);
		harness.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		harness.clock.ms += 2_000;

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		expect(reopened.expireLeases()).toEqual([attempt.attemptId]);
		expect(reopened.getSnapshot().attempts[attempt.attemptId]?.status).toBe("expired");
		expect(() =>
			reopened.finishAttempt(
				completedResult({
					objectiveId: objective.objectiveId,
					taskId: task.taskId,
					attemptId: attempt.attemptId,
					leaseId: lease.leaseId,
					fencingToken: lease.fencingToken,
				}),
			),
		).toThrow(DurableTaskRuntimeError);
		expect(reopened.queueAttempt(task.taskId, dispatch(task.taskId)).attemptId).not.toBe(attempt.attemptId);
	});

	it("persists a notification outbox until explicit delivery", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({
			objectiveId: "objective-1",
			title: "Notify",
			description: "Notify the parent",
		});
		const notification = harness.runtime.enqueueNotification({
			objectiveId: objective.objectiveId,
			message: "worker completed",
		});

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		expect(reopened.getSnapshot().notifications[notification.notificationId]?.status).toBe("pending");
		reopened.markNotificationDelivered(notification.notificationId);
		expect(reopened.getSnapshot().notifications[notification.notificationId]?.status).toBe("delivered");
	});

	it("persists approval decisions, notifies the owner, and requires a new grant after approval", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({
			objectiveId: "objective-approval",
			title: "Approve authority",
			description: "Require an explicit owner decision",
		});
		const task = harness.runtime.createTask({
			taskId: "task-approval",
			objectiveId: objective.objectiveId,
			title: "Execute",
			description: "Execute an approved process",
			role: "operator",
			requiredCapabilities: ["process.exec"],
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		const approval: ApprovalRequestContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			approvalId: "approval-1",
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			reasonCode: "required_capability_needs_authority",
			summary: "Owner approval is required for process execution.",
			requestedCapabilities: ["process.exec"],
			reversible: true,
			createdAt: new Date(T0).toISOString(),
		};

		harness.runtime.requestApproval(approval);
		expect(() => harness.runtime.leaseAttempt(attempt.attemptId, "worker-1", 60_000)).toThrow("awaiting approval");
		expect(() =>
			harness.runtime.bindAttemptGrant(
				attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: objective.objectiveId,
					taskId: task.taskId,
					attemptId: attempt.attemptId,
					role: task.role,
					grantId: "grant-before-owner",
				}),
			),
		).toThrow("awaiting approval");

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		expect(reopened.getSnapshot()).toMatchObject({
			approvals: { "approval-1": { status: "pending", request: { attemptId: attempt.attemptId } } },
			notifications: {
				"approval-requested:approval-1": {
					status: "pending",
					message: approval.summary,
				},
			},
		});

		reopened.resolveApproval(approval.approvalId, "approved", "owner_approved_process_execution");
		expect(() => reopened.leaseAttempt(attempt.attemptId, "worker-1", 60_000)).toThrow("requires an execution grant");
		const approvedGrant = createTestExecutionGrant({
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			role: task.role,
			grantId: "grant-after-owner",
		});
		reopened.bindAttemptGrant(attempt.attemptId, approvedGrant);
		expect(
			new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms }).getSnapshot().attempts[
				attempt.attemptId
			]?.grant,
		).toEqual(approvedGrant);
		expect(reopened.leaseAttempt(attempt.attemptId, "worker-1", 60_000).attemptId).toBe(attempt.attemptId);
	});

	it("blocks a rejected approval attempt and replays the human decision", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({ title: "Reject", description: "Reject elevated work" });
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Mutate",
			description: "Mutate policy",
			role: "orchestrator",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		harness.runtime.requestApproval({
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			approvalId: "approval-rejected",
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			reasonCode: "owner_authority_required",
			summary: "Policy mutation requires owner authority.",
			requestedCapabilities: ["policy.modify"],
			reversible: false,
			createdAt: new Date(T0).toISOString(),
		});
		harness.runtime.resolveApproval("approval-rejected", "rejected", "owner_rejected_policy_change");

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		expect(reopened.getSnapshot()).toMatchObject({
			approvals: {
				"approval-rejected": {
					status: "rejected",
					resolution: { reasonCode: "owner_rejected_policy_change" },
				},
			},
			attempts: { [attempt.attemptId]: { status: "blocked", reasonCode: "approval_rejected" } },
			tasks: { [task.taskId]: { task: { status: "blocked" } } },
		});
	});

	it("enforces objective pause at lease, start, and agent-resume boundaries", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({ title: "Pause", description: "Pause all new execution" });
		const task = runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Work",
			description: "Work after resume",
			role: "operator",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-pause");
		runtime.pauseObjective(objective.objectiveId);
		expect(() => runtime.leaseAttempt(attempt.attemptId, "worker", 60_000)).toThrow("is not active");
		runtime.resumeObjective(objective.objectiveId);
		const lease = runtime.leaseAttempt(attempt.attemptId, "worker", 60_000);
		runtime.pauseObjective(objective.objectiveId);
		expect(() => runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken)).toThrow("is not active");
		runtime.resumeObjective(objective.objectiveId);
		expect(runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken).status).toBe("running");
	});

	it("resumes the same logical Pi agent, session context, attempt, and checkpoint after interruption", () => {
		const harness = createHarness();
		const agent = harness.runtime.registerAgent({
			agentId: "agent-explorer-1",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-session-123",
				sessionDir: "/agent/sessions",
				sessionFile: "/agent/sessions/pi-session-123.jsonl",
				cwd: "/repo/worktrees/explorer-1",
				worktreeLaneKey: "lane-explorer-1",
				orchestrationProfileId: "explorer-fast",
				resourceProfileNames: ["worker-explorer"],
				modelRef: "openai-codex/gpt-5.5",
				contextPointers: [],
			},
		});
		const objective = harness.runtime.createObjective({
			objectiveId: "objective-1",
			title: "Resume",
			description: "Resume the same agent",
		});
		const task = harness.runtime.createTask({
			taskId: "task-1",
			objectiveId: objective.objectiveId,
			title: "Inspect",
			description: "Inspect repository",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-resume");
		const firstLease = harness.runtime.leaseAttempt(attempt.attemptId, agent.agentId, 1_000, agent.agentId);
		harness.runtime.startAttempt(attempt.attemptId, firstLease.leaseId, firstLease.fencingToken);
		const checkpoint = harness.runtime.checkpointAttempt({
			attemptId: attempt.attemptId,
			leaseId: firstLease.leaseId,
			fencingToken: firstLease.fencingToken,
			summary: "Inspection reached package boundary",
			artifactIds: ["artifact-1"],
		});
		harness.runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: firstLease.ownerId,
			leaseId: firstLease.leaseId,
			fencingToken: firstLease.fencingToken,
			reasonCode: "agent_process_interrupted",
		});
		expect(() =>
			harness.runtime.suspendBoundAttempt({
				attemptId: attempt.attemptId,
				ownerId: firstLease.ownerId,
				leaseId: firstLease.leaseId,
				fencingToken: firstLease.fencingToken,
				reasonCode: "agent_process_interrupted",
			}),
		).toThrow("not a live agent-bound attempt");

		const interrupted = harness.runtime.getSnapshot();
		expect(interrupted.attempts[attempt.attemptId]?.status).toBe("suspended");
		expect(interrupted.agents[agent.agentId]).toMatchObject({
			status: "suspended",
			resumeContext: { sessionId: "pi-session-123", latestCheckpointId: checkpoint.checkpointId },
		});

		const resuming = harness.runtime.requestAgentResume(agent.agentId, attempt.attemptId);
		const launch = buildPiResumeLaunchSpec(resuming, {
			parentPid: 1234,
			parentSessionId: "parent-session",
			taskRef: "goal-1",
		});
		expect(launch).toEqual({
			executable: "pi",
			args: [
				"--session-dir",
				"/agent/sessions",
				"--session",
				"/agent/sessions/pi-session-123.jsonl",
				"--parent-pid",
				"1234",
				"--parent-session",
				"parent-session",
				"--task-ref",
				"goal-1",
				"--worktree-lane",
				"lane-explorer-1",
				"--orchestration-profile",
				"explorer-fast",
			],
			cwd: "/repo/worktrees/explorer-1",
			env: { PI_SESSION_ROLE: "worker", PI_ORCHESTRATION_AGENT_ID: "agent-explorer-1" },
		});
		expect(
			buildResumablePiAgentWakePrompt({
				lastCode: "resumable",
				agent: {
					agentId: agent.agentId,
					resumeContext: {
						...resuming.resumeContext,
						contextPointers: [
							{ id: "artifact-1", kind: "artifact", uri: "artifact://inspection", readOnly: true },
						],
					},
				},
				taskSummary: "Inspect repository",
			}),
		).toContain(`Latest checkpoint: ${checkpoint.checkpointId}`);

		const resumedLease = harness.runtime.resumeAttempt(attempt.attemptId, agent.agentId, 60_000);
		expect(resumedLease.fencingToken).toBe(firstLease.fencingToken + 1);
		expect(harness.runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "leased",
			agentId: agent.agentId,
		});
		expect(() =>
			harness.runtime.startAttempt(attempt.attemptId, firstLease.leaseId, firstLease.fencingToken),
		).toThrow("lease or fencing token is stale");
		harness.runtime.startAttempt(attempt.attemptId, resumedLease.leaseId, resumedLease.fencingToken);

		const reopened = new DurableTaskRuntime({ store: harness.store, now: () => harness.clock.ms });
		expect(reopened.getSnapshot().agents[agent.agentId]?.resumeContext.sessionId).toBe("pi-session-123");
	});

	it("rejects public and forged resume transitions before a persisted retry backoff elapses", () => {
		const harness = createHarness();
		const agent = harness.runtime.registerAgent({
			agentId: "agent-retry-backoff",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-retry-backoff",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const objective = harness.runtime.createObjective({ title: "Retry", description: "Honor retry backoff" });
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Retry safely",
			description: "Do not resume early",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-retry-backoff");
		const firstLease = harness.runtime.leaseAttempt(attempt.attemptId, agent.agentId, 60_000, agent.agentId);
		const notBeforeMs = T0 + 60_000;
		harness.runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: firstLease.ownerId,
			leaseId: firstLease.leaseId,
			fencingToken: firstLease.fencingToken,
			reasonCode: "transient_transport",
			retry: { retriesUsed: 1, notBefore: new Date(notBeforeMs).toISOString() },
		});

		const suspended = harness.runtime.getSnapshot();
		expect(() => harness.runtime.requestAgentResume(agent.agentId, attempt.attemptId)).toThrow(/retry backoff/i);
		expect(harness.runtime.getSnapshot().lastOrdinal).toBe(suspended.lastOrdinal);
		expect(() =>
			reduceOrchestrationEvent(suspended, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: suspended.lastOrdinal + 1,
				eventId: "event-forged-resume-request",
				type: "agent.resume_requested",
				aggregateId: agent.agentId,
				actor: "runtime",
				occurredAt: new Date(T0).toISOString(),
				payload: { agentId: agent.agentId, attemptId: attempt.attemptId },
			}),
		).toThrow(/retry backoff/i);

		harness.clock.ms = notBeforeMs;
		harness.runtime.requestAgentResume(agent.agentId, attempt.attemptId);
		const resuming = harness.runtime.getSnapshot();
		const forgedAtMs = T0 + 1_000;
		expect(() =>
			reduceOrchestrationEvent(resuming, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: resuming.lastOrdinal + 1,
				eventId: "event-forged-attempt-resume",
				type: "attempt.resumed",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				occurredAt: new Date(forgedAtMs).toISOString(),
				payload: {
					agentId: agent.agentId,
					lease: {
						leaseId: "lease-forged-early",
						attemptId: attempt.attemptId,
						ownerId: agent.agentId,
						fencingToken: firstLease.fencingToken + 1,
						issuedAt: new Date(forgedAtMs).toISOString(),
						expiresAt: new Date(forgedAtMs + 60_000).toISOString(),
					},
				},
			}),
		).toThrow(/retry backoff/i);

		const resumedLease = harness.runtime.resumeAttempt(attempt.attemptId, agent.agentId, 60_000);
		expect(resumedLease.fencingToken).toBe(firstLease.fencingToken + 1);
		expect(harness.runtime.getSnapshot().attempts[attempt.attemptId]?.status).toBe("leased");
	});

	it("reopens compacted retry state through resumed execution and clears it only at terminal", () => {
		const agentDir = join(tmpdir(), `pi-durable-runtime-retry-compaction-${process.pid}-${Date.now()}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		let now = T0;
		let nextId = 1;
		const store = new OrchestrationEventStore({
			agentDir,
			sessionId: "retry-compaction-session",
			now: () => new Date(now).toISOString(),
			createEventId: () => `retry-event-${nextId++}`,
			maxTailEvents: 1,
			maxTailBytes: 1_000_000,
		});
		const openRuntime = () =>
			new DurableTaskRuntime({ store, now: () => now, createId: () => `retry-id-${nextId++}` });
		let runtime = openRuntime();
		const agent = runtime.registerAgent({
			agentId: "agent-retry-compaction",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-retry-compaction",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const objective = runtime.createObjective({
			objectiveId: "objective-retry-compaction",
			title: "Retry compaction",
			description: "Keep the durable retry ladder through active resumed execution",
		});
		const task = runtime.createTask({
			taskId: "task-retry-compaction",
			objectiveId: objective.objectiveId,
			title: "Resume safely",
			description: "Reopen every retry lifecycle state from a compacted projection",
			role: "explorer",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId), "grant-retry-compaction");
		const firstLease = runtime.leaseAttempt(attempt.attemptId, "owner-retry-compaction", 60_000, agent.agentId);
		runtime.startAttempt(attempt.attemptId, firstLease.leaseId, firstLease.fencingToken);
		const notBefore = new Date(now + 1_000).toISOString();
		runtime.suspendBoundAttempt({
			attemptId: attempt.attemptId,
			ownerId: firstLease.ownerId,
			leaseId: firstLease.leaseId,
			fencingToken: firstLease.fencingToken,
			reasonCode: "retry_scheduled:server_error",
			retry: { retriesUsed: 1, notBefore },
		});

		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "suspended",
			retry: { retriesUsed: 1, notBefore },
		});
		runtime = openRuntime();
		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "suspended",
			retry: { retriesUsed: 1, notBefore },
		});

		now += 1_000;
		runtime.requestAgentResume(agent.agentId, attempt.attemptId);
		const resumedLease = runtime.resumeAttempt(attempt.attemptId, agent.agentId, 60_000, firstLease.ownerId);
		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "leased",
			retry: { retriesUsed: 1, notBefore },
		});
		runtime = openRuntime();
		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "leased",
			retry: { retriesUsed: 1, notBefore },
		});

		runtime.startAttempt(attempt.attemptId, resumedLease.leaseId, resumedLease.fencingToken);
		const runningSnapshot = runtime.getSnapshot();
		expect(runningSnapshot.attempts[attempt.attemptId]).toMatchObject({
			status: "running",
			retry: { retriesUsed: 1, notBefore },
		});
		runtime = openRuntime();
		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({
			status: "running",
			retry: { retriesUsed: 1, notBefore },
		});
		const unboundRetry = structuredClone(runningSnapshot);
		delete (unboundRetry.attempts[attempt.attemptId] as { agentId?: string }).agentId;
		expect(() => projectionFromSnapshot(toJsonObject(unboundRetry), unboundRetry.lastOrdinal)).toThrow(
			/outside the resumable agent lifecycle/i,
		);

		runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: task.taskId,
				attemptId: attempt.attemptId,
				leaseId: resumedLease.leaseId,
				fencingToken: resumedLease.fencingToken,
			}),
		);
		const completedSnapshot = runtime.getSnapshot();
		expect(completedSnapshot.attempts[attempt.attemptId]).toMatchObject({ status: "completed" });
		expect(completedSnapshot.attempts[attempt.attemptId]?.retry).toBeUndefined();
		runtime = openRuntime();
		expect(runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({ status: "completed" });
		expect(runtime.getSnapshot().attempts[attempt.attemptId]?.retry).toBeUndefined();
		const terminalRetry = structuredClone(completedSnapshot);
		(terminalRetry.attempts[attempt.attemptId] as { retry?: { retriesUsed: number; notBefore: string } }).retry = {
			retriesUsed: 1,
			notBefore,
		};
		expect(() => projectionFromSnapshot(toJsonObject(terminalRetry), terminalRetry.lastOrdinal)).toThrow(
			/outside the resumable agent lifecycle/i,
		);
	});

	it("immediately suspends only bound in-process attempts on a known process restart", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({ title: "Restart", description: "Fence stopped workers" });
		const agent = harness.runtime.registerAgent({
			agentId: "agent-restart-1",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-restart-1",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const boundTask = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Bound",
			description: "Resume this worker",
			role: "explorer",
		});
		const unboundTask = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Unbound",
			description: "Requeue this worker separately",
			role: "explorer",
		});
		const managedTask = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Managed",
			description: "Keep external supervision",
			role: "explorer",
		});
		const bound = harness.runtime.queueAttempt(boundTask.taskId, dispatch(boundTask.taskId));
		const unbound = harness.runtime.queueAttempt(unboundTask.taskId, dispatch(unboundTask.taskId));
		const managed = harness.runtime.queueAttempt(managedTask.taskId, {
			...dispatch(managedTask.taskId),
			executionKind: "managed-process",
		});
		for (const [attempt, task] of [
			[bound, boundTask],
			[unbound, unboundTask],
			[managed, managedTask],
		] as const) {
			harness.runtime.bindAttemptGrant(
				attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: objective.objectiveId,
					taskId: task.taskId,
					attemptId: attempt.attemptId,
					role: "explorer",
				}),
			);
		}
		const boundLease = harness.runtime.leaseAttempt(bound.attemptId, agent.agentId, 60_000, agent.agentId);
		const unboundLease = harness.runtime.leaseAttempt(unbound.attemptId, "worker-unbound", 60_000);
		const managedLease = harness.runtime.leaseAttempt(managed.attemptId, "worker-managed", 60_000);
		harness.runtime.startAttempt(bound.attemptId, boundLease.leaseId, boundLease.fencingToken);
		harness.runtime.startAttempt(unbound.attemptId, unboundLease.leaseId, unboundLease.fencingToken);
		harness.runtime.startAttempt(managed.attemptId, managedLease.leaseId, managedLease.fencingToken);

		harness.runtime.suspendBoundAttempt({
			attemptId: bound.attemptId,
			ownerId: boundLease.ownerId,
			leaseId: boundLease.leaseId,
			fencingToken: boundLease.fencingToken,
			reasonCode: "agent_process_interrupted",
		});
		expect(harness.runtime.getSnapshot()).toMatchObject({
			agents: { [agent.agentId]: { status: "suspended", activeAttemptId: bound.attemptId } },
			attempts: {
				[bound.attemptId]: { status: "suspended", agentId: agent.agentId },
				[unbound.attemptId]: { status: "running" },
				[managed.attemptId]: { status: "running" },
			},
		});
	});

	it("requires the exact owner and current lease fence to suspend one bound attempt", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({ title: "Fence", description: "Do not steal work" });
		const agent = harness.runtime.registerAgent({
			agentId: "agent-fence",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-fence",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Bound",
			description: "Require exact ownership",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		harness.runtime.bindAttemptGrant(
			attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: objective.objectiveId,
				taskId: task.taskId,
				attemptId: attempt.attemptId,
				role: "explorer",
			}),
		);
		const lease = harness.runtime.leaseAttempt(attempt.attemptId, "pi-worker:42:owner-a", 60_000, agent.agentId);
		harness.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);

		expect(() =>
			harness.runtime.suspendBoundAttempt({
				attemptId: attempt.attemptId,
				ownerId: "pi-worker:42:owner-b",
				leaseId: lease.leaseId,
				fencingToken: lease.fencingToken,
				reasonCode: "owner_stopped",
			}),
		).toThrow("not owned");
		expect(() =>
			harness.runtime.suspendBoundAttempt({
				attemptId: attempt.attemptId,
				ownerId: lease.ownerId,
				leaseId: "stale-lease",
				fencingToken: lease.fencingToken,
				reasonCode: "owner_stopped",
			}),
		).toThrow("lease or fencing token is stale");
		expect(harness.runtime.getSnapshot().attempts[attempt.attemptId]).toMatchObject({ status: "running" });
	});

	it("releases the same logical agent after both cancellation and completion without weakening lease fences", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({
			title: "Release agent",
			description: "Make terminal attempts return one logical agent to the idle pool",
		});
		const agent = harness.runtime.registerAgent({
			agentId: "agent-release",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-release",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const taskIds = ["task-cancel", "task-finish"] as const;
		for (const taskId of taskIds) {
			harness.runtime.createTask({
				taskId,
				objectiveId: objective.objectiveId,
				title: taskId,
				description: `Exercise ${taskId}`,
				role: "explorer",
			});
		}

		const cancelledAttempt = harness.runtime.queueAttempt(taskIds[0], dispatch(taskIds[0]));
		harness.runtime.bindAttemptGrant(
			cancelledAttempt.attemptId,
			createTestExecutionGrant({
				objectiveId: objective.objectiveId,
				taskId: taskIds[0],
				attemptId: cancelledAttempt.attemptId,
				role: "explorer",
			}),
		);
		const cancelledLease = harness.runtime.leaseAttempt(
			cancelledAttempt.attemptId,
			"owner-cancel",
			60_000,
			agent.agentId,
		);
		harness.runtime.startAttempt(cancelledAttempt.attemptId, cancelledLease.leaseId, cancelledLease.fencingToken);
		harness.runtime.cancelAttempt(cancelledAttempt.attemptId, "owner_cancelled");
		expect(harness.runtime.getSnapshot().agents[agent.agentId]).toMatchObject({ status: "registered" });
		expect(harness.runtime.getSnapshot().agents[agent.agentId]?.activeAttemptId).toBeUndefined();

		const finishedAttempt = harness.runtime.queueAttempt(taskIds[1], dispatch(taskIds[1]));
		harness.runtime.bindAttemptGrant(
			finishedAttempt.attemptId,
			createTestExecutionGrant({
				objectiveId: objective.objectiveId,
				taskId: taskIds[1],
				attemptId: finishedAttempt.attemptId,
				role: "explorer",
			}),
		);
		const finishedLease = harness.runtime.leaseAttempt(
			finishedAttempt.attemptId,
			"owner-finish",
			60_000,
			agent.agentId,
		);
		harness.runtime.startAttempt(finishedAttempt.attemptId, finishedLease.leaseId, finishedLease.fencingToken);
		harness.runtime.finishAttempt(
			completedResult({
				objectiveId: objective.objectiveId,
				taskId: taskIds[1],
				attemptId: finishedAttempt.attemptId,
				leaseId: finishedLease.leaseId,
				fencingToken: finishedLease.fencingToken,
			}),
		);
		expect(harness.runtime.getSnapshot().agents[agent.agentId]).toMatchObject({ status: "registered" });
		expect(harness.runtime.getSnapshot().agents[agent.agentId]?.activeAttemptId).toBeUndefined();
	});

	it("rejects replayed suspension events with a stale lease or fence", () => {
		const harness = createHarness();
		const objective = harness.runtime.createObjective({ title: "Replay", description: "Reject stale suspend" });
		const agent = harness.runtime.registerAgent({
			agentId: "agent-replay",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "pi-replay",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const task = harness.runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Replay",
			description: "Validate event fence",
			role: "explorer",
		});
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
		harness.runtime.bindAttemptGrant(
			attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: objective.objectiveId,
				taskId: task.taskId,
				attemptId: attempt.attemptId,
				role: "explorer",
			}),
		);
		const lease = harness.runtime.leaseAttempt(attempt.attemptId, "pi-worker:43:owner", 60_000, agent.agentId);
		harness.runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		const snapshot = harness.runtime.getSnapshot();

		expect(() =>
			reduceOrchestrationEvent(snapshot, {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal: snapshot.lastOrdinal + 1,
				eventId: "event-stale-suspend",
				type: "attempt.suspended",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				occurredAt: new Date(T0).toISOString(),
				payload: {
					attemptId: attempt.attemptId,
					leaseId: lease.leaseId,
					fencingToken: lease.fencingToken + 1,
					reasonCode: "stale_replay",
				},
			}),
		).toThrow("lease or fencing token is stale");
	});

	it("cancels non-terminal tasks and attempts as one replayable objective transition", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "objective-1",
			title: "Cancel",
			description: "Cancel safely",
		});
		const task = runtime.createTask({
			taskId: "task-1",
			objectiveId: objective.objectiveId,
			title: "Work",
			description: "Pending work",
			role: "planner",
		});
		const attempt = runtime.queueAttempt(task.taskId, dispatch(task.taskId));

		runtime.cancelObjective(objective.objectiveId);
		const snapshot = runtime.getSnapshot();
		expect(snapshot.objectives[objective.objectiveId]?.objective.status).toBe("cancelled");
		expect(snapshot.tasks[task.taskId]?.task.status).toBe("cancelled");
		expect(snapshot.attempts[attempt.attemptId]?.status).toBe("cancelled");
	});
});

describe("DurableTaskRuntime snapshots", () => {
	it("shares one frozen projection until the next event", () => {
		const { runtime } = createHarness();
		const objective = runtime.createObjective({
			objectiveId: "shared-objective",
			title: "Share",
			description: "One immutable value for every reader",
		});
		const first = runtime.getSnapshot();
		expect(runtime.getSnapshot()).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.objectives[objective.objectiveId]?.objective)).toBe(true);
		expect(() => {
			(first.objectives as Record<string, unknown>).intruder = {};
		}).toThrow(TypeError);

		runtime.createTask({
			taskId: "shared-task",
			objectiveId: objective.objectiveId,
			title: "Run",
			description: "A later event yields a new object",
			role: "implementer",
		});
		const second = runtime.getSnapshot();
		expect(second).not.toBe(first);
		expect(first.lastOrdinal).toBe(1);
		expect(first.tasks["shared-task"]).toBeUndefined();
		expect(second.lastOrdinal).toBe(2);
		expect(second.tasks["shared-task"]?.task.objectiveId).toBe(objective.objectiveId);
	});

	it("adopts a peer runtime's append on the next read", () => {
		const { agentDir, runtime } = createHarness();
		const before = runtime.getSnapshot();
		const peer = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir, sessionId: "session-1" }),
		});
		peer.createObjective({ objectiveId: "peer-objective", title: "Peer", description: "Appended elsewhere" });

		const after = runtime.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.objectives["peer-objective"]?.objective.title).toBe("Peer");
		expect(runtime.getSnapshot()).toBe(after);
	});
});
