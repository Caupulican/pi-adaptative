import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/core/autonomy/contracts.ts";
import {
	type AgentBindingContract,
	type AppendOrchestrationEventInput,
	type ApprovalRequestContract,
	type AttemptCheckpoint,
	type EvidenceContract,
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_APPROVALS,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH,
	MAX_ORCHESTRATION_CHECKPOINTS,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_EVIDENCE,
	MAX_ORCHESTRATION_NOTIFICATIONS,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_PROJECTION_BYTES,
	MAX_ORCHESTRATION_RETAINED_RECORD_BYTES,
	MAX_ORCHESTRATION_TASKS,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
	type OrchestrationEventType,
	type TaskContract,
	toJsonObject,
} from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import type { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import {
	type ApprovalRuntimeState,
	type AttemptRuntimeState,
	DurableTaskRuntime,
	type NotificationRuntimeState,
	type ObjectiveRuntimeState,
	reduceOrchestrationEvent,
	type TaskRuntimeProjection,
	type TaskRuntimeState,
} from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
const NOW = "2026-08-07T15:00:00.000Z";

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-orchestration-projection-limits-"));
	roots.push(directory);
	return directory;
}

function objective(taskIds: readonly string[] = []): ObjectiveRuntimeState {
	return {
		objective: {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			objectiveId: "objective",
			title: "Projection bounds",
			description: "Keep the durable hot projection bounded",
			status: "active",
			constraints: [],
			acceptanceCriteria: [],
			riskBudget: {},
			createdAt: NOW,
			updatedAt: NOW,
		},
		taskIds: [...taskIds],
		evidence: [],
	};
}

function taskContract(
	taskId: string,
	options: { verifierOf?: string; status?: TaskContract["status"] } = {},
): TaskContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		taskId,
		objectiveId: "objective",
		title: taskId,
		description: taskId,
		role: options.verifierOf ? "verifier" : "implementer",
		status: options.status ?? "ready",
		dependsOn: [],
		requiredCapabilities: [],
		acceptanceCriterionIds: [],
		...(options.verifierOf ? { verificationOfTaskId: options.verifierOf } : {}),
		riskBudget: {},
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function taskState(
	taskId: string,
	options: { verifierOf?: string; attemptIds?: readonly string[]; status?: TaskContract["status"] } = {},
): TaskRuntimeState {
	return { task: taskContract(taskId, options), attemptIds: [...(options.attemptIds ?? [])] };
}

function attemptState(attemptId: string, taskId = "subject"): AttemptRuntimeState {
	return {
		attemptId,
		taskId,
		dispatch: {
			taskId,
			profileId: "implementer",
			instructions: `Execute ${taskId}`,
			resourcePointerIds: [],
			requirementIds: [],
		},
		status: "cancelled",
		checkpointIds: [],
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function checkpointState(checkpointId: string, attemptId = "attempt-live"): AttemptCheckpoint {
	return {
		checkpointId,
		attemptId,
		fencingToken: 1,
		summary: checkpointId,
		artifactIds: [],
		evidenceIds: [],
		createdAt: NOW,
	};
}

function liveAttempt(checkpointIds: readonly string[] = []): AttemptRuntimeState {
	return {
		...attemptState("attempt-live"),
		status: "running",
		grantId: "grant-live",
		lease: {
			leaseId: "lease-live",
			attemptId: "attempt-live",
			ownerId: "worker-live",
			fencingToken: 1,
			issuedAt: NOW,
			expiresAt: "2026-08-07T16:00:00.000Z",
		},
		checkpointIds: [...checkpointIds],
	};
}

function evidenceState(evidenceId: string): EvidenceContract {
	return {
		evidenceId,
		kind: "observation",
		summary: evidenceId,
		artifactIds: [],
		trusted: true,
		createdAt: NOW,
	};
}

function approvalRequest(approvalId: string): ApprovalRequestContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		approvalId,
		objectiveId: "objective",
		reasonCode: "policy",
		summary: approvalId,
		requestedCapabilities: ["filesystem.read"],
		reversible: true,
		createdAt: NOW,
	};
}

function approvalState(approvalId: string): ApprovalRuntimeState {
	return { request: approvalRequest(approvalId), status: "pending" };
}

function notificationState(notificationId: string): NotificationRuntimeState {
	return {
		notificationId,
		objectiveId: "objective",
		status: "pending",
		message: notificationId,
		createdAt: NOW,
	};
}

function objectiveWithEvidence(objectiveId: string, evidenceCount: number): ObjectiveRuntimeState {
	return {
		...objective(),
		objective: { ...objective().objective, objectiveId },
		evidence: Array.from({ length: evidenceCount }, (_, index) => evidenceState(`${objectiveId}-${index}`)),
	};
}

function agentBinding(agentId: string, role: AgentBindingContract["role"] = "implementer"): AgentBindingContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		agentId,
		resumeContext: {
			provider: "pi",
			sessionId: `session-${agentId}`,
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		},
		rootAgentId: agentId,
		depth: 0,
		role,
		status: "registered",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function projection(overrides: Partial<TaskRuntimeProjection> = {}): TaskRuntimeProjection {
	return {
		lastOrdinal: 1,
		agents: {},
		objectives: {},
		tasks: {},
		attempts: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
		...overrides,
	};
}

function recordOf<T>(count: number, create: (index: number) => readonly [string, T]): Record<string, T> {
	const values: Record<string, T> = {};
	for (let index = 0; index < count; index += 1) {
		const [key, value] = create(index);
		values[key] = value;
	}
	return values;
}

function event(
	ordinal: number,
	type: OrchestrationEventType,
	aggregateId: string,
	payload: JsonObject,
): OrchestrationEvent {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		ordinal,
		eventId: `event-${ordinal}`,
		type,
		aggregateId,
		actor: "runtime",
		occurredAt: NOW,
		payload,
	};
}

class StaticProjectionStore {
	appendCalls = 0;
	private readonly allowAppend: boolean;
	private readonly snapshot: TaskRuntimeProjection;

	constructor(snapshot: TaskRuntimeProjection, allowAppend = false) {
		this.snapshot = structuredClone(snapshot);
		this.allowAppend = allowAppend;
	}

	readProjectionSnapshot(): { throughOrdinal: number; projection: JsonObject } {
		return { throughOrdinal: this.snapshot.lastOrdinal, projection: toJsonObject(this.snapshot) };
	}

	readAll(): OrchestrationEvent[] {
		return [];
	}

	readAfter(): OrchestrationEvent[] {
		return [];
	}

	compactIfNeeded(): boolean {
		return false;
	}

	append(input: AppendOrchestrationEventInput): OrchestrationEvent {
		this.appendCalls += 1;
		if (!this.allowAppend) throw new Error("append must not be reached after projection admission fails");
		return {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			ordinal: this.snapshot.lastOrdinal + this.appendCalls,
			eventId: `appended-${this.appendCalls}`,
			type: input.type,
			aggregateId: input.aggregateId,
			actor: input.actor,
			occurredAt: NOW,
			...(input.correlationId ? { correlationId: input.correlationId } : {}),
			...(input.causationId ? { causationId: input.causationId } : {}),
			...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
			payload: structuredClone(input.payload),
		};
	}
}

function runtimeForProjection(
	snapshot: TaskRuntimeProjection,
	allowAppend = false,
): {
	runtime: DurableTaskRuntime;
	store: StaticProjectionStore;
} {
	const store = new StaticProjectionStore(snapshot, allowAppend);
	let nextId = 0;
	return {
		runtime: new DurableTaskRuntime({
			store: store as unknown as OrchestrationEventStore,
			now: () => Date.parse(NOW),
			createId: () => {
				nextId += 1;
				return `new-${nextId}`;
			},
		}),
		store,
	};
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable orchestration projection ceilings", () => {
	it("rejects over-cap compacted snapshots before they become the runtime baseline", () => {
		const cases: Array<{ label: string; snapshot: TaskRuntimeProjection }> = [
			{
				label: "agent binding",
				snapshot: projection({
					agents: recordOf(MAX_ORCHESTRATION_AGENT_BINDINGS + 1, (index) => {
						const id = `agent-${index}`;
						return [id, agentBinding(id)];
					}),
				}),
			},
			{
				label: "task",
				snapshot: projection({
					objectives: { objective: objective() },
					tasks: recordOf(MAX_ORCHESTRATION_TASKS + 1, (index) => {
						const id = `task-${index}`;
						return [id, taskState(id)];
					}),
				}),
			},
			{
				label: "attempt",
				snapshot: projection({
					objectives: { objective: objective(["subject"]) },
					tasks: { subject: taskState("subject") },
					attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS + 1, (index) => {
						const id = `attempt-${index}`;
						return [id, attemptState(id)];
					}),
				}),
			},
		];

		for (const { label, snapshot } of cases) {
			expect(
				() =>
					new DurableTaskRuntime({
						store: new StaticProjectionStore(snapshot) as unknown as OrchestrationEventStore,
					}),
			).toThrow(new RegExp(`${label}.*limit`, "i"));
		}
	});

	it("rejects oversized records and stops repeated near-max records below the compact projection ceiling", () => {
		const oversizedMessage = "x".repeat(4 * 1024 * 1024);
		const oversized = notificationState("notification-oversized");
		oversized.message = oversizedMessage;
		expect(
			() =>
				new DurableTaskRuntime({
					store: new StaticProjectionStore(
						projection({ notifications: { "notification-oversized": oversized } }),
					) as unknown as OrchestrationEventStore,
				}),
		).toThrow(/notification.*retained record.*limit/i);

		const initial = projection({ objectives: { objective: objective() } });
		const before = structuredClone(initial);
		expect(() =>
			reduceOrchestrationEvent(
				initial,
				event(
					2,
					"notification.enqueued",
					"objective",
					toJsonObject({
						notificationId: "notification-oversized",
						objectiveId: "objective",
						message: oversizedMessage,
					}),
				),
			),
		).toThrow(/notification.*retained record.*limit/i);
		expect(initial).toEqual(before);

		const nearMaxMessage = "x".repeat(MAX_ORCHESTRATION_RETAINED_RECORD_BYTES - 512);
		let retained = initial;
		let accepted = 0;
		for (let ordinal = 2; ordinal < MAX_ORCHESTRATION_NOTIFICATIONS + 2; ordinal++) {
			const notificationId = `notification-${ordinal}`;
			try {
				retained = reduceOrchestrationEvent(
					retained,
					event(
						ordinal,
						"notification.enqueued",
						"objective",
						toJsonObject({ notificationId, objectiveId: "objective", message: nearMaxMessage }),
					),
				);
				accepted += 1;
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toMatch(/projection.*byte limit/i);
				break;
			}
		}
		expect(accepted).toBeGreaterThan(1);
		expect(accepted).toBeLessThan(MAX_ORCHESTRATION_NOTIFICATIONS);
		expect(Buffer.byteLength(JSON.stringify(retained), "utf8")).toBeLessThanOrEqual(
			MAX_ORCHESTRATION_PROJECTION_BYTES,
		);
	});

	it("rejects forged task dependency cycles in events and compacted snapshots while admitting a prior DAG edge", () => {
		const cyclic = taskState("task-cycle");
		cyclic.task = { ...cyclic.task, status: "pending", dependsOn: ["task-cycle"] };
		expect(
			() =>
				new DurableTaskRuntime({
					store: new StaticProjectionStore(
						projection({
							objectives: { objective: objective(["task-cycle"]) },
							tasks: { "task-cycle": cyclic },
						}),
					) as unknown as OrchestrationEventStore,
				}),
		).toThrow(/task graph.*cycle/i);

		const initial = projection({ objectives: { objective: objective() } });
		expect(() =>
			reduceOrchestrationEvent(
				initial,
				event(
					2,
					"task.created",
					"objective",
					toJsonObject({ task: { ...taskContract("task-cycle"), status: "pending", dependsOn: ["task-cycle"] } }),
				),
			),
		).toThrow(/depend on itself/i);
		const rejected = runtimeForProjection(initial);
		expect(() =>
			rejected.runtime.createTask({
				taskId: "task-cycle",
				objectiveId: "objective",
				title: "Cycle",
				description: "Reject a self edge",
				role: "implementer",
				dependsOn: ["task-cycle"],
			}),
		).toThrow(/dependency.*not in objective/i);
		expect(rejected.store.appendCalls).toBe(0);

		const dag = runtimeForProjection(
			projection({
				objectives: { objective: objective(["task-prior"]) },
				tasks: { "task-prior": taskState("task-prior") },
			}),
			true,
		);
		expect(
			dag.runtime.createTask({
				taskId: "task-after",
				objectiveId: "objective",
				title: "After",
				description: "A valid edge to a prior task",
				role: "implementer",
				dependsOn: ["task-prior"],
			}).dependsOn,
		).toEqual(["task-prior"]);
	});

	it("rejects forged snapshot ownership gaps and cross-links while preserving exact public relationships", () => {
		const valid = projection({
			objectives: { objective: objective(["task-1", "task-2"]) },
			tasks: {
				"task-1": taskState("task-1"),
				"task-2": taskState("task-2", { attemptIds: ["attempt-2"] }),
			},
			attempts: { "attempt-2": attemptState("attempt-2", "task-2") },
		});
		const secondObjective = objective();
		secondObjective.objective = { ...secondObjective.objective, objectiveId: "objective-2" };
		const unsupportedTaskState = structuredClone(valid);
		(unsupportedTaskState.tasks["task-1"] as unknown as Record<string, unknown>).shadowOwner = true;
		const nullExecutionContract = structuredClone(valid);
		(nullExecutionContract.attempts["attempt-2"]!.dispatch as unknown as Record<string, unknown>).executionContract =
			null;
		const cases: TaskRuntimeProjection[] = [
			{
				...structuredClone(valid),
				objectives: { objective: objective(["task-2"]) },
			},
			{
				...structuredClone(valid),
				objectives: { objective: objective(["task-1", "task-2", "task-unknown"]) },
			},
			{
				...structuredClone(valid),
				objectives: { objective: objective(["task-1", "task-1", "task-2"]) },
			},
			{
				...structuredClone(valid),
				objectives: {
					objective: objective(["task-2"]),
					"objective-2": { ...secondObjective, taskIds: ["task-1"] },
				},
			},
			{
				...structuredClone(valid),
				tasks: {
					"task-1": taskState("task-1", { attemptIds: ["attempt-2"] }),
					"task-2": taskState("task-2"),
				},
			},
			{
				...structuredClone(valid),
				tasks: { "task-1": taskState("task-1"), "task-2": taskState("task-2") },
			},
			{
				...structuredClone(valid),
				attempts: {
					"attempt-2": { ...attemptState("attempt-2", "task-2"), attemptId: "attempt-mismatch" },
				},
			},
			{
				...structuredClone(valid),
				attempts: {
					"attempt-2": {
						...attemptState("attempt-2", "task-2"),
						dispatch: { ...attemptState("attempt-2", "task-2").dispatch, taskId: "task-1" },
					},
				},
			},
			unsupportedTaskState,
			nullExecutionContract,
		];

		for (const forged of cases) {
			expect(
				() =>
					new DurableTaskRuntime({
						store: new StaticProjectionStore(forged) as unknown as OrchestrationEventStore,
					}),
			).toThrow(/projection snapshot/i);
		}

		const validHarness = runtimeForProjection(valid, true);
		expect(() => validHarness.runtime.completeObjective("objective")).toThrow(/incomplete tasks/i);
		expect(validHarness.runtime.getSnapshot()).toMatchObject({
			objectives: { objective: { objective: { status: "active" }, taskIds: ["task-1", "task-2"] } },
			tasks: {
				"task-1": { task: { status: "ready" }, attemptIds: [] },
				"task-2": { attemptIds: ["attempt-2"] },
			},
			attempts: { "attempt-2": { taskId: "task-2", dispatch: { taskId: "task-2" } } },
		});
		expect(validHarness.store.appendCalls).toBe(0);

		const attemptA = liveAttempt(["checkpoint-cross"]);
		attemptA.attemptId = "attempt-a";
		attemptA.taskId = "task-a";
		attemptA.dispatch = { ...attemptA.dispatch, taskId: "task-a" };
		attemptA.lease = { ...attemptA.lease!, attemptId: "attempt-a", leaseId: "lease-a" };
		const attemptB = liveAttempt();
		attemptB.attemptId = "attempt-b";
		attemptB.taskId = "task-b";
		attemptB.dispatch = { ...attemptB.dispatch, taskId: "task-b" };
		attemptB.lease = { ...attemptB.lease!, attemptId: "attempt-b", leaseId: "lease-b" };
		const crossCheckpoint = checkpointState("checkpoint-cross", "attempt-b");
		expect(
			() =>
				new DurableTaskRuntime({
					store: new StaticProjectionStore(
						projection({
							objectives: { objective: objective(["task-a", "task-b"]) },
							tasks: {
								"task-a": taskState("task-a", { attemptIds: ["attempt-a"], status: "running" }),
								"task-b": taskState("task-b", { attemptIds: ["attempt-b"], status: "running" }),
							},
							attempts: { "attempt-a": attemptA, "attempt-b": attemptB },
							checkpoints: { "checkpoint-cross": crossCheckpoint },
						}),
					) as unknown as OrchestrationEventStore,
				}),
		).toThrow(/checkpoint|cross-attempt/i);
	});

	it("fails command admission at each exact ceiling without appending or changing the snapshot", () => {
		const agentSnapshot = projection({
			agents: recordOf(MAX_ORCHESTRATION_AGENT_BINDINGS, (index) => {
				const id = `agent-${index}`;
				return [id, agentBinding(id)];
			}),
		});
		const agentHarness = runtimeForProjection(agentSnapshot);
		const agentBefore = agentHarness.runtime.getSnapshot();
		expect(() =>
			agentHarness.runtime.registerAgent({
				agentId: "agent-overflow",
				role: "implementer",
				resumeContext: {
					provider: "pi",
					sessionId: "agent-overflow",
					cwd: "/repo",
					resourceProfileNames: [],
					contextPointers: [],
				},
			}),
		).toThrow(/agent binding.*limit/i);
		expect(agentHarness.store.appendCalls).toBe(0);
		expect(agentHarness.runtime.getSnapshot()).toEqual(agentBefore);

		const taskIds = Array.from({ length: MAX_ORCHESTRATION_TASKS }, (_, index) => `task-${index}`);
		const taskHarness = runtimeForProjection(
			projection({
				objectives: { objective: objective(taskIds) },
				tasks: Object.fromEntries(taskIds.map((taskId) => [taskId, taskState(taskId)])),
			}),
		);
		const taskBefore = taskHarness.runtime.getSnapshot();
		expect(() =>
			taskHarness.runtime.createTask({
				taskId: "task-overflow",
				objectiveId: "objective",
				title: "overflow",
				description: "overflow",
				role: "implementer",
			}),
		).toThrow(/task.*limit/i);
		expect(taskHarness.store.appendCalls).toBe(0);
		expect(taskHarness.runtime.getSnapshot()).toEqual(taskBefore);

		const saturatedAttemptIds = Array.from({ length: MAX_ORCHESTRATION_ATTEMPTS }, (_, index) => `attempt-${index}`);
		const attemptHarness = runtimeForProjection(
			projection({
				objectives: { objective: objective(["subject"]) },
				tasks: { subject: taskState("subject", { attemptIds: saturatedAttemptIds }) },
				attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS, (index) => {
					const id = `attempt-${index}`;
					return [id, attemptState(id)];
				}),
			}),
		);
		const attemptBefore = attemptHarness.runtime.getSnapshot();
		expect(() =>
			attemptHarness.runtime.queueAttempt("subject", {
				taskId: "subject",
				profileId: "implementer",
				instructions: "overflow",
				resourcePointerIds: [],
			}),
		).toThrow(/attempt.*limit/i);
		expect(attemptHarness.store.appendCalls).toBe(0);
		expect(attemptHarness.runtime.getSnapshot()).toEqual(attemptBefore);
	});

	it("enforces the same ceilings during forged event reduction while preserving the input projection", () => {
		const agents = recordOf(MAX_ORCHESTRATION_AGENT_BINDINGS, (index) => {
			const id = `agent-${index}`;
			return [id, agentBinding(id)];
		});
		const agentProjection = projection({ agents });
		const agentBefore = structuredClone(agentProjection);
		expect(() =>
			reduceOrchestrationEvent(
				agentProjection,
				event(2, "agent.registered", "agent-overflow", toJsonObject({ agent: agentBinding("agent-overflow") })),
			),
		).toThrow(/agent binding.*limit/i);
		expect(agentProjection).toEqual(agentBefore);

		const taskIds = Array.from({ length: MAX_ORCHESTRATION_TASKS }, (_, index) => `task-${index}`);
		const taskProjection = projection({
			objectives: { objective: objective(taskIds) },
			tasks: Object.fromEntries(taskIds.map((taskId) => [taskId, taskState(taskId)])),
		});
		const taskBefore = structuredClone(taskProjection);
		expect(() =>
			reduceOrchestrationEvent(
				taskProjection,
				event(2, "task.created", "objective", toJsonObject({ task: taskContract("task-overflow") })),
			),
		).toThrow(/task.*limit/i);
		expect(taskProjection).toEqual(taskBefore);

		const attemptProjection = projection({
			objectives: { objective: objective(["subject"]) },
			tasks: { subject: taskState("subject") },
			attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS, (index) => {
				const id = `attempt-${index}`;
				return [id, attemptState(id)];
			}),
		});
		const attemptBefore = structuredClone(attemptProjection);
		expect(() =>
			reduceOrchestrationEvent(
				attemptProjection,
				event(
					2,
					"attempt.queued",
					"subject",
					toJsonObject({
						attemptId: "attempt-overflow",
						taskId: "subject",
						dispatch: {
							taskId: "subject",
							profileId: "implementer",
							instructions: "overflow",
							resourcePointerIds: [],
						},
					}),
				),
			),
		).toThrow(/attempt.*limit/i);
		expect(attemptProjection).toEqual(attemptBefore);
	});

	it("keeps a two-slot implementation and verifier edge usable at every ceiling", () => {
		let agentProjection = projection({
			agents: recordOf(MAX_ORCHESTRATION_AGENT_BINDINGS - 2, (index) => {
				const id = `agent-${index}`;
				return [id, agentBinding(id)];
			}),
		});
		agentProjection = reduceOrchestrationEvent(
			agentProjection,
			event(2, "agent.registered", "implementation", toJsonObject({ agent: agentBinding("implementation") })),
		);
		agentProjection = reduceOrchestrationEvent(
			agentProjection,
			event(3, "agent.registered", "verifier", toJsonObject({ agent: agentBinding("verifier", "verifier") })),
		);
		expect(Object.keys(agentProjection.agents)).toHaveLength(MAX_ORCHESTRATION_AGENT_BINDINGS);

		const fillerTaskIds = Array.from({ length: MAX_ORCHESTRATION_TASKS - 2 }, (_, index) => `task-${index}`);
		let taskProjection = projection({
			objectives: { objective: objective(fillerTaskIds) },
			tasks: Object.fromEntries(fillerTaskIds.map((taskId) => [taskId, taskState(taskId)])),
		});
		taskProjection = reduceOrchestrationEvent(
			taskProjection,
			event(2, "task.created", "objective", toJsonObject({ task: taskContract("implementation") })),
		);
		taskProjection = reduceOrchestrationEvent(
			taskProjection,
			event(
				3,
				"task.created",
				"objective",
				toJsonObject({ task: taskContract("verifier", { verifierOf: "implementation" }) }),
			),
		);
		expect(Object.keys(taskProjection.tasks)).toHaveLength(MAX_ORCHESTRATION_TASKS);

		let attemptProjection = projection({
			objectives: { objective: objective(["implementation", "verifier", "overflow"]) },
			tasks: {
				implementation: taskState("implementation"),
				verifier: taskState("verifier", { verifierOf: "implementation" }),
				overflow: taskState("overflow"),
			},
			attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS - 2, (index) => {
				const id = `attempt-${index}`;
				return [id, attemptState(id)];
			}),
		});
		for (const [ordinal, taskId] of ["implementation", "verifier"].entries()) {
			attemptProjection = reduceOrchestrationEvent(
				attemptProjection,
				event(
					ordinal + 2,
					"attempt.queued",
					taskId,
					toJsonObject({
						attemptId: `attempt-${taskId}`,
						taskId,
						dispatch: {
							taskId,
							profileId: taskId === "verifier" ? "verifier" : "implementer",
							instructions: taskId,
							resourcePointerIds: [],
						},
					}),
				),
			);
		}
		expect(Object.keys(attemptProjection.attempts)).toHaveLength(MAX_ORCHESTRATION_ATTEMPTS);
	});

	it("preflights task and attempt slots together before a multi-event dispatch changes state", () => {
		const attemptIds = Array.from({ length: MAX_ORCHESTRATION_ATTEMPTS }, (_, index) => `attempt-${index}`);
		const harness = runtimeForProjection(
			projection({
				objectives: { objective: objective(["subject"]) },
				tasks: { subject: taskState("subject", { attemptIds }) },
				attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS, (index) => {
					const id = `attempt-${index}`;
					return [id, attemptState(id)];
				}),
			}),
		);
		const before = harness.runtime.getSnapshot();
		const capacity = harness.runtime.getProjectionCapacity();
		expect(capacity.counts).toMatchObject({ agents: 0, tasks: 1, attempts: MAX_ORCHESTRATION_ATTEMPTS });
		expect(capacity.headroom).toMatchObject({
			agents: MAX_ORCHESTRATION_AGENT_BINDINGS,
			tasks: MAX_ORCHESTRATION_TASKS - 1,
			attempts: 0,
		});
		expect(() => harness.runtime.assertProjectionHeadroom({ tasks: 1, attempts: 1 })).toThrow(/attempt.*limit/i);
		expect(harness.store.appendCalls).toBe(0);
		expect(harness.runtime.getSnapshot()).toEqual(before);
	});

	it("exposes two-slot task and attempt headroom for an implementation and mandatory verifier pair", () => {
		const taskIds = Array.from({ length: MAX_ORCHESTRATION_TASKS - 2 }, (_, index) => `task-${index}`);
		const attemptIds = Array.from({ length: MAX_ORCHESTRATION_ATTEMPTS - 2 }, (_, index) => `attempt-${index}`);
		const harness = runtimeForProjection(
			projection({
				objectives: { objective: objective(taskIds) },
				tasks: Object.fromEntries(
					taskIds.map((taskId, index) => [taskId, taskState(taskId, index === 0 ? { attemptIds } : {})]),
				),
				attempts: recordOf(MAX_ORCHESTRATION_ATTEMPTS - 2, (index) => {
					const id = `attempt-${index}`;
					return [id, attemptState(id, taskIds[0]!)];
				}),
			}),
		);

		expect(harness.runtime.assertProjectionHeadroom({ tasks: 2, attempts: 2 }).headroom).toMatchObject({
			tasks: 2,
			attempts: 2,
		});
	});

	it("rejects forged retained-collection snapshots before cloning them into the runtime", () => {
		const globalEvidenceObjectives: Record<string, ObjectiveRuntimeState> = {};
		let remainingEvidence = MAX_ORCHESTRATION_EVIDENCE + 1;
		for (let index = 0; remainingEvidence > 0; index += 1) {
			const count = Math.min(remainingEvidence, MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE);
			const objectiveId = `objective-${index}`;
			globalEvidenceObjectives[objectiveId] = objectiveWithEvidence(objectiveId, count);
			remainingEvidence -= count;
		}
		const cases: Array<{ label: string; snapshot: TaskRuntimeProjection }> = [
			{
				label: "objective",
				snapshot: projection({
					objectives: recordOf(MAX_ORCHESTRATION_OBJECTIVES + 1, (index) => {
						const id = `objective-${index}`;
						return [id, objectiveWithEvidence(id, 0)];
					}),
				}),
			},
			{
				label: "checkpoint",
				snapshot: projection({
					checkpoints: recordOf(MAX_ORCHESTRATION_CHECKPOINTS + 1, (index) => {
						const id = `checkpoint-${index}`;
						return [id, checkpointState(id)];
					}),
				}),
			},
			{
				label: "approval",
				snapshot: projection({
					approvals: recordOf(MAX_ORCHESTRATION_APPROVALS + 1, (index) => {
						const id = `approval-${index}`;
						return [id, approvalState(id)];
					}),
				}),
			},
			{
				label: "notification",
				snapshot: projection({
					notifications: recordOf(MAX_ORCHESTRATION_NOTIFICATIONS + 1, (index) => {
						const id = `notification-${index}`;
						return [id, notificationState(id)];
					}),
				}),
			},
			{
				label: "objective evidence",
				snapshot: projection({
					objectives: {
						objective: objectiveWithEvidence("objective", MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE + 1),
					},
				}),
			},
			{
				label: "evidence",
				snapshot: projection({ objectives: globalEvidenceObjectives }),
			},
		];

		for (const { label, snapshot } of cases) {
			expect(
				() =>
					new DurableTaskRuntime({
						store: new StaticProjectionStore(snapshot) as unknown as OrchestrationEventStore,
					}),
			).toThrow(new RegExp(`${label}.*limit`, "i"));
		}
	});

	it("rejects forged retained-collection events without changing their input projections", () => {
		const objectiveProjection = projection({
			objectives: recordOf(MAX_ORCHESTRATION_OBJECTIVES, (index) => {
				const id = `objective-${index}`;
				return [id, objectiveWithEvidence(id, 0)];
			}),
		});
		const objectiveBefore = structuredClone(objectiveProjection);
		expect(() =>
			reduceOrchestrationEvent(
				objectiveProjection,
				event(
					2,
					"objective.created",
					"objective-overflow",
					toJsonObject({
						objective: { ...objective().objective, objectiveId: "objective-overflow" },
					}),
				),
			),
		).toThrow(/objective.*limit/i);
		expect(objectiveProjection).toEqual(objectiveBefore);

		const evidenceProjection = projection({
			objectives: {
				objective: objectiveWithEvidence("objective", MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE),
			},
		});
		const evidenceBefore = structuredClone(evidenceProjection);
		expect(() =>
			reduceOrchestrationEvent(
				evidenceProjection,
				event(2, "objective.evidence_recorded", "objective", toJsonObject({ evidence: evidenceState("overflow") })),
			),
		).toThrow(/objective evidence.*limit/i);
		expect(evidenceProjection).toEqual(evidenceBefore);

		const checkpointIds = Array.from({ length: MAX_ORCHESTRATION_CHECKPOINTS }, (_, index) => `checkpoint-${index}`);
		const checkpointProjection = projection({
			objectives: { objective: objective(["subject"]) },
			tasks: { subject: taskState("subject") },
			attempts: { "attempt-live": liveAttempt(checkpointIds) },
			checkpoints: Object.fromEntries(checkpointIds.map((id) => [id, checkpointState(id)])),
		});
		const checkpointBefore = structuredClone(checkpointProjection);
		expect(() =>
			reduceOrchestrationEvent(
				checkpointProjection,
				event(
					2,
					"attempt.checkpointed",
					"attempt-live",
					toJsonObject({ checkpoint: checkpointState("checkpoint-overflow"), leaseId: "lease-live" }),
				),
			),
		).toThrow(/checkpoint.*limit/i);
		expect(checkpointProjection).toEqual(checkpointBefore);

		const notificationProjection = projection({
			objectives: { objective: objective() },
			notifications: recordOf(MAX_ORCHESTRATION_NOTIFICATIONS, (index) => {
				const id = `notification-${index}`;
				return [id, notificationState(id)];
			}),
		});
		const notificationBefore = structuredClone(notificationProjection);
		expect(() =>
			reduceOrchestrationEvent(
				notificationProjection,
				event(
					2,
					"approval.requested",
					"objective",
					toJsonObject({ approval: approvalRequest("approval-overflow") }),
				),
			),
		).toThrow(/notification.*limit/i);
		expect(notificationProjection).toEqual(notificationBefore);
	});

	it("preflights direct retained-record admissions before their first append", () => {
		const objectivesHarness = runtimeForProjection(
			projection({
				objectives: recordOf(MAX_ORCHESTRATION_OBJECTIVES, (index) => {
					const id = `objective-${index}`;
					return [id, objectiveWithEvidence(id, 0)];
				}),
			}),
		);
		const objectivesBefore = objectivesHarness.runtime.getSnapshot();
		expect(() => objectivesHarness.runtime.createObjective({ title: "overflow", description: "overflow" })).toThrow(
			/objective.*limit/i,
		);
		expect(objectivesHarness.store.appendCalls).toBe(0);
		expect(objectivesHarness.runtime.getSnapshot()).toEqual(objectivesBefore);

		const evidenceHarness = runtimeForProjection(
			projection({
				objectives: {
					objective: objectiveWithEvidence("objective", MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE),
				},
			}),
		);
		const evidenceBefore = evidenceHarness.runtime.getSnapshot();
		expect(() => evidenceHarness.runtime.recordObjectiveEvidence("objective", evidenceState("overflow"))).toThrow(
			/objective evidence.*limit/i,
		);
		expect(evidenceHarness.store.appendCalls).toBe(0);
		expect(evidenceHarness.runtime.getSnapshot()).toEqual(evidenceBefore);

		const notifications = recordOf(MAX_ORCHESTRATION_NOTIFICATIONS, (index) => {
			const id = `notification-${index}`;
			return [id, notificationState(id)];
		});
		const approvalHarness = runtimeForProjection(
			projection({ objectives: { objective: objective() }, notifications }),
		);
		const approvalBefore = approvalHarness.runtime.getSnapshot();
		expect(() => approvalHarness.runtime.requestApproval(approvalRequest("approval-overflow"))).toThrow(
			/notification.*limit/i,
		);
		expect(approvalHarness.store.appendCalls).toBe(0);
		expect(approvalHarness.runtime.getSnapshot()).toEqual(approvalBefore);

		const notificationHarness = runtimeForProjection(
			projection({ objectives: { objective: objective() }, notifications }),
		);
		const notificationBefore = notificationHarness.runtime.getSnapshot();
		expect(() =>
			notificationHarness.runtime.enqueueNotification({
				objectiveId: "objective",
				message: "overflow",
			}),
		).toThrow(/notification.*limit/i);
		expect(notificationHarness.store.appendCalls).toBe(0);
		expect(notificationHarness.runtime.getSnapshot()).toEqual(notificationBefore);
	});

	it("bounds repeated checkpoints on one live lease and validates checkpoint payload size before append", () => {
		const checkpointIds = Array.from(
			{ length: MAX_ORCHESTRATION_CHECKPOINTS - 1 },
			(_, index) => `checkpoint-${index}`,
		);
		const harness = runtimeForProjection(
			projection({
				objectives: { objective: objective(["subject"]) },
				tasks: { subject: taskState("subject", { attemptIds: ["attempt-live"], status: "running" }) },
				attempts: { "attempt-live": liveAttempt(checkpointIds) },
				checkpoints: Object.fromEntries(checkpointIds.map((id) => [id, checkpointState(id)])),
			}),
			true,
		);

		expect(() =>
			harness.runtime.checkpointAttempt({
				attemptId: "attempt-live",
				leaseId: "lease-live",
				fencingToken: 1,
				summary: "x".repeat(MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH + 1),
			}),
		).toThrow(/summary.*size bound/i);
		expect(() =>
			harness.runtime.checkpointAttempt({
				attemptId: "attempt-live",
				leaseId: "lease-live",
				fencingToken: 1,
				summary: "bounded",
				artifactIds: Array.from(
					{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH + 1 },
					(_, index) => `artifact-${index}`,
				),
			}),
		).toThrow(/artifactIds.*bounded identifier array/i);
		expect(harness.store.appendCalls).toBe(0);

		harness.runtime.checkpointAttempt({
			attemptId: "attempt-live",
			leaseId: "lease-live",
			fencingToken: 1,
			summary: "last admitted checkpoint",
		});
		expect(harness.store.appendCalls).toBe(1);
		const beforeOverflow = harness.runtime.getSnapshot();
		expect(() =>
			harness.runtime.checkpointAttempt({
				attemptId: "attempt-live",
				leaseId: "lease-live",
				fencingToken: 1,
				summary: "overflow",
			}),
		).toThrow(/checkpoint.*limit/i);
		expect(harness.store.appendCalls).toBe(1);
		expect(harness.runtime.getSnapshot()).toEqual(beforeOverflow);
	});

	it("preflights saturated nested retained lists before direct or reducer append paths", () => {
		const taskIds = Array.from({ length: MAX_ORCHESTRATION_TASKS }, (_, index) => `ghost-task-${index}`);
		const objectiveProjection = projection({
			objectives: { objective: objective(taskIds) },
			tasks: Object.fromEntries(taskIds.map((taskId) => [taskId, taskState(taskId)])),
		});
		const objectiveHarness = runtimeForProjection(objectiveProjection);
		expect(() =>
			objectiveHarness.runtime.createTask({
				objectiveId: "objective",
				title: "overflow",
				description: "overflow",
				role: "implementer",
			}),
		).toThrow(/task.*limit/i);
		expect(objectiveHarness.store.appendCalls).toBe(0);
		expect(() =>
			reduceOrchestrationEvent(
				objectiveProjection,
				event(2, "task.created", "objective", toJsonObject({ task: taskContract("task-overflow") })),
			),
		).toThrow(/task.*limit/i);

		const attemptIds = Array.from({ length: MAX_ORCHESTRATION_ATTEMPTS }, (_, index) => `ghost-attempt-${index}`);
		const saturatedTask = { ...taskState("subject"), attemptIds };
		const attemptProjection = projection({
			objectives: { objective: objective(["subject"]) },
			tasks: { subject: saturatedTask },
			attempts: Object.fromEntries(attemptIds.map((attemptId) => [attemptId, attemptState(attemptId)])),
		});
		const attemptHarness = runtimeForProjection(attemptProjection);
		expect(() =>
			attemptHarness.runtime.queueAttempt("subject", {
				taskId: "subject",
				profileId: "implementer",
				instructions: "overflow",
				resourcePointerIds: [],
			}),
		).toThrow(/attempt.*limit/i);
		expect(attemptHarness.store.appendCalls).toBe(0);
		expect(() =>
			reduceOrchestrationEvent(
				attemptProjection,
				event(
					2,
					"attempt.queued",
					"subject",
					toJsonObject({
						attemptId: "attempt-overflow",
						taskId: "subject",
						dispatch: {
							taskId: "subject",
							profileId: "implementer",
							instructions: "overflow",
							resourcePointerIds: [],
						},
					}),
				),
			),
		).toThrow(/attempt.*limit/i);

		const checkpointIds = Array.from(
			{ length: MAX_ORCHESTRATION_CHECKPOINTS },
			(_, index) => `ghost-checkpoint-${index}`,
		);
		const checkpointProjection = projection({
			objectives: { objective: objective(["subject"]) },
			tasks: { subject: taskState("subject", { attemptIds: ["attempt-live"], status: "running" }) },
			attempts: { "attempt-live": liveAttempt(checkpointIds) },
			checkpoints: Object.fromEntries(checkpointIds.map((id) => [id, checkpointState(id)])),
		});
		const checkpointHarness = runtimeForProjection(checkpointProjection);
		expect(() =>
			checkpointHarness.runtime.checkpointAttempt({
				attemptId: "attempt-live",
				leaseId: "lease-live",
				fencingToken: 1,
				summary: "overflow",
			}),
		).toThrow(/attempt checkpoint list.*limit/i);
		expect(checkpointHarness.store.appendCalls).toBe(0);
		expect(() =>
			reduceOrchestrationEvent(
				checkpointProjection,
				event(
					2,
					"attempt.checkpointed",
					"attempt-live",
					toJsonObject({ checkpoint: checkpointState("checkpoint-overflow"), leaseId: "lease-live" }),
				),
			),
		).toThrow(/attempt checkpoint list.*limit/i);
	});

	it("bounds sequential persistent follow-ups while leaving the rejected turn entirely uncommitted", () => {
		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "persistent-abuse" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "implementer",
			model: { provider: "test", id: "model" },
		});
		const contract = createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile),
			},
		});
		ledger.runtime.registerAgent({
			agentId: "persistent-agent",
			role: "implementer",
			resumeContext: {
				provider: "pi",
				sessionId: "persistent-agent-session",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const initial = ledger.prepare({
			laneId: "persistent-agent",
			instructions: "initial",
			executionContract: contract,
			requiredCapabilities: [],
		});
		ledger.runtime.cancelAttempt(initial.attemptId, "test_turn_complete");
		for (let index = 1; index < MAX_ORCHESTRATION_TASKS; index += 1) {
			const turn = ledger.prepareAgentTurn({
				agentId: "persistent-agent",
				instructions: `turn ${index}`,
				controlMessageId: `message-${index}`,
			});
			ledger.runtime.cancelAttempt(turn.attemptId, "test_turn_complete");
		}
		const before = ledger.runtime.getSnapshot();
		expect(Object.keys(before.agents)).toHaveLength(1);
		expect(Object.keys(before.tasks)).toHaveLength(MAX_ORCHESTRATION_TASKS);
		expect(Object.keys(before.attempts)).toHaveLength(MAX_ORCHESTRATION_ATTEMPTS);

		expect(() =>
			ledger.prepareAgentTurn({
				agentId: "persistent-agent",
				instructions: "overflow",
				controlMessageId: "message-overflow",
			}),
		).toThrow(/task.*limit/i);
		expect(ledger.runtime.getSnapshot()).toEqual(before);
	});
});
