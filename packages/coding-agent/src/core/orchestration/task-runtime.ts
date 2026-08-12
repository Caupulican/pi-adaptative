import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../autonomy/contracts.ts";
import { createAgentIdentity } from "./agent-resume.ts";
import {
	type AgentBindingContract,
	type AgentIdentityContract,
	type AppendOrchestrationEventInput,
	type ApprovalOutcome,
	type ApprovalRequestContract,
	type ApprovalResolutionContract,
	type AttemptCheckpoint,
	type AttemptLease,
	type AttemptRetryState,
	type EvidenceContract,
	type ExecutionGrant,
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_APPROVALS,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_CHECKPOINTS,
	MAX_ORCHESTRATION_NOTIFICATIONS,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_TASKS,
	type ObjectiveContract,
	type ObjectiveStatus,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationDispatchRequest,
	type OrchestrationEvent,
	type TaskContract,
	toJsonObject,
	type WorkerResultContract,
} from "./contracts.ts";
import { type OrchestrationEventStore, OrchestrationSnapshotRequiredError } from "./event-store.ts";
import {
	approvalFromPayload,
	assertAcceptanceCriteria,
	assertReferencedAcceptanceCriteriaRetained,
	assertRiskBudget,
	checkpointSummary,
	dispatchFromValue,
	dispatchIdentifier,
	dispatchIdentifierArray,
	executionGrantFromValue,
	MAX_DATE_EPOCH_MS,
	projectionFromSnapshot,
	retryStateFromValue,
	taskFromValue,
	usageFromPayload,
	validateTaskContractForState,
	validateTaskDependencyIds,
} from "./task-runtime-codecs.ts";
import {
	assertBoundedIdentifierList,
	assertIdentifierListHasCapacity,
	assertObjectiveEvidenceHasCapacity,
	assertProjectionRecordReplacementWithinLimits,
	assertRecordHasCapacity,
	cloneProjection,
	projectionCapacity,
	requestedProjectionSlots,
} from "./task-runtime-projection.ts";
import {
	activeTaskAttempt,
	assertAgentNotRetired,
	assertAgentRetirementEligible,
	assertApprovalRequestTransition,
	assertApprovalResolutionTransition,
	assertAttemptCheckpointTransition,
	assertAttemptFinishTransition,
	assertAttemptGrantTransition,
	assertAttemptLeaseRenewalTransition,
	assertAttemptLeaseTransition,
	assertAttemptStartTransition,
	assertNotificationTarget,
	assertObjectiveStatusTransition,
	assertRetryBackoffElapsedAt,
	assertTaskAttemptBudgetForState,
	assertTaskFailureTransition,
	assertVerificationTransition,
	attemptDispatchReadiness,
	type ObjectiveCompletionPolicy,
	projectOrchestrationEvents,
	reduceOrchestrationEvent,
	requireActiveObjectiveForAttemptInProjection,
	type VerificationTransitionInput,
} from "./task-runtime-reducer.ts";
import {
	type ApprovalRuntimeState,
	type AttemptDispatchReadiness,
	type AttemptRuntimeState,
	type CreateObjectiveInput,
	type CreateTaskInput,
	DurableTaskRuntimeError,
	type NotificationRuntimeState,
	type ObjectiveRuntimeState,
	type OrchestrationProjectionCapacity,
	type OrchestrationProjectionHeadroomRequest,
	type PreparedTaskAttempt,
	type RegisterAgentInput,
	type TaskRuntimeProjection,
	type TaskRuntimeState,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";

export { validateTaskDependencyIds } from "./task-runtime-codecs.ts";
export {
	projectOrchestrationEvents,
	reduceOrchestrationEvent,
} from "./task-runtime-reducer.ts";
export {
	type ApprovalRuntimeState,
	type AttemptDispatchReadiness,
	type AttemptRuntimeState,
	type CreateObjectiveInput,
	type CreateTaskInput,
	DurableTaskRuntimeError,
	type NotificationRuntimeState,
	type ObjectiveRuntimeState,
	type OrchestrationProjectionCapacity,
	type OrchestrationProjectionHeadroomRequest,
	type OrchestrationProjectionSlotCounts,
	type PreparedTaskAttempt,
	type RegisterAgentInput,
	type TaskRuntimeProjection,
	type TaskRuntimeState,
} from "./task-runtime-state.ts";

export interface DurableTaskRuntimeOptions {
	store: OrchestrationEventStore;
	now?: () => number;
	createId?: () => string;
}

export class DurableTaskRuntime {
	private readonly store: OrchestrationEventStore;
	private readonly now: () => number;
	private readonly createId: () => string;
	private state: TaskRuntimeProjection;

	constructor(options: DurableTaskRuntimeOptions) {
		this.store = options.store;
		this.now = options.now ?? (() => Date.now());
		this.createId = options.createId ?? randomUUID;
		const snapshot = this.store.readProjectionSnapshot();
		if (snapshot) {
			this.state = projectionFromSnapshot(snapshot.projection, snapshot.throughOrdinal);
		} else {
			const events = this.store.readAll();
			// Compaction may install a baseline between the first snapshot read and readAll(). In that
			// case readAll() returns only the new tail, which must be applied to that baseline rather
			// than projected as a standalone history.
			const snapshotAfterRead = this.store.readProjectionSnapshot();
			this.state = snapshotAfterRead
				? events
						.filter((event) => event.ordinal > snapshotAfterRead.throughOrdinal)
						.reduce(
							reduceOrchestrationEvent,
							projectionFromSnapshot(snapshotAfterRead.projection, snapshotAfterRead.throughOrdinal),
						)
				: projectOrchestrationEvents(events);
		}
		this.refresh();
	}

	getSnapshot(): TaskRuntimeProjection {
		this.refresh();
		return cloneProjection(this.state);
	}

	/** Read-only retained-record counts and remaining lifetime slots for orchestration admission. */
	getProjectionCapacity(): OrchestrationProjectionCapacity {
		this.refresh();
		return projectionCapacity(this.state);
	}

	/**
	 * Preflight every record needed by a multi-event operation before its first append. Callers use
	 * this to reserve implementation and mandatory-verifier task/attempt pairs atomically.
	 */
	assertProjectionHeadroom(required: OrchestrationProjectionHeadroomRequest): OrchestrationProjectionCapacity {
		this.refresh();
		const capacity = projectionCapacity(this.state);
		const agents = requestedProjectionSlots(required.agents, "Agent binding");
		const objectives = requestedProjectionSlots(required.objectives, "Objective");
		const tasks = requestedProjectionSlots(required.tasks, "Task");
		const attempts = requestedProjectionSlots(required.attempts, "Attempt");
		const checkpoints = requestedProjectionSlots(required.checkpoints, "Checkpoint");
		const approvals = requestedProjectionSlots(required.approvals, "Approval");
		const notifications = requestedProjectionSlots(required.notifications, "Notification");
		const evidence = requestedProjectionSlots(required.evidence, "Evidence");
		if (agents > capacity.headroom.agents) {
			throw new DurableTaskRuntimeError(
				`Orchestration agent binding limit (${capacity.limits.agents}) lacks ${agents} required slots.`,
			);
		}
		if (tasks > capacity.headroom.tasks) {
			throw new DurableTaskRuntimeError(
				`Orchestration task limit (${capacity.limits.tasks}) lacks ${tasks} required slots.`,
			);
		}
		if (attempts > capacity.headroom.attempts) {
			throw new DurableTaskRuntimeError(
				`Orchestration attempt limit (${capacity.limits.attempts}) lacks ${attempts} required slots.`,
			);
		}
		if (objectives > capacity.headroom.objectives) {
			throw new DurableTaskRuntimeError(
				`Orchestration objective limit (${capacity.limits.objectives}) lacks ${objectives} required slots.`,
			);
		}
		if (checkpoints > capacity.headroom.checkpoints) {
			throw new DurableTaskRuntimeError(
				`Orchestration checkpoint limit (${capacity.limits.checkpoints}) lacks ${checkpoints} required slots.`,
			);
		}
		if (approvals > capacity.headroom.approvals) {
			throw new DurableTaskRuntimeError(
				`Orchestration approval limit (${capacity.limits.approvals}) lacks ${approvals} required slots.`,
			);
		}
		if (notifications > capacity.headroom.notifications) {
			throw new DurableTaskRuntimeError(
				`Orchestration notification limit (${capacity.limits.notifications}) lacks ${notifications} required slots.`,
			);
		}
		if (evidence > capacity.headroom.evidence) {
			throw new DurableTaskRuntimeError(
				`Orchestration evidence limit (${capacity.limits.evidence}) lacks ${evidence} required slots.`,
			);
		}
		return capacity;
	}

	/**
	 * Preflight the idempotent evidence batch for one objective before synchronizing any member.
	 * The objective may be absent when its creation is part of the same compound operation.
	 */
	assertObjectiveEvidenceHeadroom(objectiveId: string, evidenceIds: readonly string[]): number {
		this.refresh();
		assertBoundedIdentifierList(evidenceIds, MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE, "Objective evidence ids");
		const objective = this.state.objectives[objectiveId];
		const existingIds = new Set(objective?.evidence.map((evidence) => evidence.evidenceId) ?? []);
		let required = 0;
		for (const evidenceId of evidenceIds) {
			if (!existingIds.has(evidenceId)) required += 1;
		}
		if ((objective?.evidence.length ?? 0) + required > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE) {
			throw new DurableTaskRuntimeError(
				`Orchestration objective evidence limit (${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE}) lacks ${required} required slots.`,
			);
		}
		const capacity = projectionCapacity(this.state);
		if (required > capacity.headroom.evidence) {
			throw new DurableTaskRuntimeError(
				`Orchestration evidence limit (${capacity.limits.evidence}) lacks ${required} required slots.`,
			);
		}
		return required;
	}

	/**
	 * Preflight the final retained objective record for a multi-event owner synchronization. This
	 * validates the objective metadata and the complete idempotently merged evidence batch before
	 * ensureObjective can append the first event, so a later byte rejection cannot leave a prefix.
	 */
	assertObjectiveSynchronizationHeadroom(
		input: CreateObjectiveInput & { objectiveId: string },
		evidence: readonly EvidenceContract[],
	): void {
		this.refresh();
		const objectiveId = dispatchIdentifier(input.objectiveId, "objective.objectiveId");
		const current = this.state.objectives[objectiveId];
		const requiredEvidence = this.assertObjectiveEvidenceHeadroom(
			objectiveId,
			evidence.map((item) => item.evidenceId),
		);
		this.assertProjectionHeadroom({ objectives: current ? 0 : 1, evidence: requiredEvidence });
		assertRiskBudget(input.riskBudget, "objective.riskBudget");
		const acceptanceCriteria = structuredClone(input.acceptanceCriteria ?? []);
		assertAcceptanceCriteria(acceptanceCriteria);
		const title = input.title.trim();
		const description = input.description.trim();
		if (!title || !description) throw new DurableTaskRuntimeError("Objective title and description are required.");
		const now = this.nowIso();
		const objective: ObjectiveContract = current
			? {
					...current.objective,
					title,
					description,
					constraints: [...(input.constraints ?? [])],
					acceptanceCriteria,
					riskBudget: { ...(input.riskBudget ?? {}) },
					updatedAt: now,
				}
			: {
					schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
					objectiveId,
					title,
					description,
					status: "active",
					constraints: [...(input.constraints ?? [])],
					acceptanceCriteria,
					riskBudget: { ...(input.riskBudget ?? {}) },
					createdAt: now,
					updatedAt: now,
				};
		if (current) {
			assertReferencedAcceptanceCriteriaRetained(this.state.tasks, current, acceptanceCriteria);
		}

		const mergedEvidence = current?.evidence.map((item) => structuredClone(item)) ?? [];
		const evidenceById = new Map(mergedEvidence.map((item) => [item.evidenceId, item]));
		for (const item of evidence) {
			const evidenceId = dispatchIdentifier(item.evidenceId, "objective evidence.evidenceId");
			if (!item.summary.trim() || !item.createdAt.trim()) {
				throw new DurableTaskRuntimeError("Objective evidence requires an id, summary, and creation time.");
			}
			if (item.criterionId && !objective.acceptanceCriteria.some((criterion) => criterion.id === item.criterionId)) {
				throw new DurableTaskRuntimeError(
					`Objective evidence references unknown acceptance criterion '${item.criterionId}'.`,
				);
			}
			const existing = evidenceById.get(evidenceId);
			if (existing) {
				if (!isDeepStrictEqual(existing, item)) {
					throw new DurableTaskRuntimeError(`Objective evidence '${evidenceId}' has conflicting content.`);
				}
				continue;
			}
			const retained = structuredClone(item);
			mergedEvidence.push(retained);
			evidenceById.set(evidenceId, retained);
		}
		assertProjectionRecordReplacementWithinLimits(this.state, "objectives", objectiveId, {
			objective,
			taskIds: current?.taskIds ?? [],
			evidence: mergedEvidence,
		});
	}

	registerAgent(input: RegisterAgentInput): AgentBindingContract {
		this.refresh();
		const now = this.nowIso();
		let identity: AgentIdentityContract;
		try {
			identity = createAgentIdentity(input.agentId ?? `agent-${this.createId()}`, input.resumeContext);
		} catch (error) {
			throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
		}
		const parentAgentId = input.parentAgentId?.trim();
		const parent = parentAgentId ? this.state.agents[parentAgentId] : undefined;
		if (parentAgentId && !parent) {
			throw new DurableTaskRuntimeError(`Unknown parent agent '${parentAgentId}'.`);
		}
		if (parent?.status === "retired") {
			throw new DurableTaskRuntimeError(`Parent agent '${parentAgentId}' is retired.`);
		}
		const depth = parent ? parent.depth + 1 : 0;
		if (!Number.isSafeInteger(depth)) {
			throw new DurableTaskRuntimeError("Agent lineage depth exceeds the durable numeric range.");
		}
		const agent: AgentBindingContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			...identity,
			...(parent ? { parentAgentId: parent.agentId } : {}),
			rootAgentId: parent?.rootAgentId ?? identity.agentId,
			depth,
			role: input.role,
			status: "registered",
			createdAt: now,
			updatedAt: now,
		};
		if (this.state.agents[agent.agentId])
			throw new DurableTaskRuntimeError(`Agent '${agent.agentId}' already exists.`);
		assertRecordHasCapacity(this.state.agents, MAX_ORCHESTRATION_AGENT_BINDINGS, "agent binding");
		this.commit({
			type: "agent.registered",
			aggregateId: agent.agentId,
			actor: "runtime",
			idempotencyKey: `agent-registered:${agent.agentId}`,
			payload: toJsonObject({ agent }),
		});
		return structuredClone(agent);
	}

	/**
	 * Retire one idle persistent identity without deleting its binding, lineage, transcript pointers,
	 * or attempt history. A repeated call is inert and returns the durable retired binding.
	 */
	retireAgent(agentId: string): AgentBindingContract {
		this.refresh();
		const normalizedAgentId = dispatchIdentifier(agentId.trim(), "agentId");
		const agent = assertAgentRetirementEligible(this.state, normalizedAgentId);
		if (agent.status === "retired") return structuredClone(agent);
		this.commit({
			type: "agent.retired",
			aggregateId: normalizedAgentId,
			actor: "runtime",
			idempotencyKey: `agent-retired:${normalizedAgentId}`,
			payload: toJsonObject({ agentId: normalizedAgentId }),
		});
		return structuredClone(this.state.agents[normalizedAgentId]!);
	}

	createObjective(input: CreateObjectiveInput): ObjectiveContract {
		this.refresh();
		assertRiskBudget(input.riskBudget, "objective.riskBudget");
		const now = this.nowIso();
		const objective: ObjectiveContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			objectiveId: input.objectiveId ?? `objective-${this.createId()}`,
			title: input.title.trim(),
			description: input.description.trim(),
			status: "active",
			constraints: [...(input.constraints ?? [])],
			acceptanceCriteria: structuredClone(input.acceptanceCriteria ?? []),
			riskBudget: { ...(input.riskBudget ?? {}) },
			createdAt: now,
			updatedAt: now,
		};
		if (!objective.title || !objective.description)
			throw new DurableTaskRuntimeError("Objective title and description are required.");
		assertAcceptanceCriteria(objective.acceptanceCriteria);
		if (this.state.objectives[objective.objectiveId]) {
			throw new DurableTaskRuntimeError(`Objective '${objective.objectiveId}' already exists.`);
		}
		assertRecordHasCapacity(this.state.objectives, MAX_ORCHESTRATION_OBJECTIVES, "objective");
		this.commit({
			type: "objective.created",
			aggregateId: objective.objectiveId,
			actor: "kernel",
			idempotencyKey: `objective-created:${objective.objectiveId}`,
			payload: toJsonObject({ objective }),
		});
		return structuredClone(objective);
	}

	/** Create or synchronize owner-authored objective metadata without disturbing lifecycle or task state. */
	ensureObjective(input: CreateObjectiveInput & { objectiveId: string }): ObjectiveContract {
		this.refresh();
		const current = this.state.objectives[input.objectiveId];
		if (!current) return this.createObjective(input);
		assertRiskBudget(input.riskBudget, "objective.riskBudget");
		const acceptanceCriteria = structuredClone(input.acceptanceCriteria ?? []);
		assertAcceptanceCriteria(acceptanceCriteria);
		const nextFields = {
			title: input.title.trim(),
			description: input.description.trim(),
			constraints: [...(input.constraints ?? [])],
			acceptanceCriteria,
			riskBudget: { ...(input.riskBudget ?? {}) },
		};
		if (!nextFields.title || !nextFields.description) {
			throw new DurableTaskRuntimeError("Objective title and description are required.");
		}
		const currentFields = {
			title: current.objective.title,
			description: current.objective.description,
			constraints: current.objective.constraints,
			acceptanceCriteria: current.objective.acceptanceCriteria,
			riskBudget: current.objective.riskBudget,
		};
		if (isDeepStrictEqual(currentFields, nextFields)) return structuredClone(current.objective);

		assertReferencedAcceptanceCriteriaRetained(this.state.tasks, current, acceptanceCriteria);
		const objective: ObjectiveContract = {
			...current.objective,
			...nextFields,
			updatedAt: this.nowIso(),
		};
		this.commit({
			type: "objective.updated",
			aggregateId: objective.objectiveId,
			actor: "kernel",
			payload: toJsonObject({ objective }),
		});
		return structuredClone(objective);
	}

	recordObjectiveEvidence(objectiveId: string, evidence: EvidenceContract): EvidenceContract {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		const existing = objective.evidence.find((candidate) => candidate.evidenceId === evidence.evidenceId);
		if (existing) {
			if (!isDeepStrictEqual(existing, evidence)) {
				throw new DurableTaskRuntimeError(`Objective evidence '${evidence.evidenceId}' has conflicting content.`);
			}
			return structuredClone(existing);
		}
		if (!evidence.evidenceId.trim() || !evidence.summary.trim() || !evidence.createdAt.trim()) {
			throw new DurableTaskRuntimeError("Objective evidence requires an id, summary, and creation time.");
		}
		if (
			evidence.criterionId &&
			!objective.objective.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)
		) {
			throw new DurableTaskRuntimeError(
				`Objective evidence references unknown acceptance criterion '${evidence.criterionId}'.`,
			);
		}
		assertObjectiveEvidenceHasCapacity(this.state.objectives, objective);
		this.commit({
			type: "objective.evidence_recorded",
			aggregateId: objectiveId,
			actor: "kernel",
			idempotencyKey: `objective-evidence-recorded:${objectiveId}:${evidence.evidenceId}`,
			payload: toJsonObject({ evidence }),
		});
		return structuredClone(evidence);
	}

	createTask(input: CreateTaskInput): TaskContract {
		this.refresh();
		const { task, objectiveState } = this.buildTask(input);
		assertRecordHasCapacity(this.state.tasks, MAX_ORCHESTRATION_TASKS, "task");
		assertIdentifierListHasCapacity(objectiveState.taskIds, MAX_ORCHESTRATION_TASKS, "objective task list");
		this.commit({
			type: "task.created",
			aggregateId: task.objectiveId,
			actor: "runtime",
			idempotencyKey: `task-created:${task.taskId}`,
			payload: toJsonObject({ task }),
		});
		return structuredClone(this.state.tasks[task.taskId]!.task);
	}

	/** Atomically create a new task and its first queued attempt in one durable transition. */
	prepareTaskAttempt(
		input: CreateTaskInput,
		dispatch: OrchestrationDispatchRequest,
		grantId?: string,
	): PreparedTaskAttempt {
		this.refresh();
		const { task, objectiveState } = this.buildTask(input);
		const taskState: TaskRuntimeState = { task, attemptIds: [] };
		const normalizedDispatch = this.normalizeDispatchForTask(taskState, dispatch);
		this.assertTaskAttemptBudget(taskState, objectiveState.objective);
		assertRecordHasCapacity(this.state.tasks, MAX_ORCHESTRATION_TASKS, "task");
		assertIdentifierListHasCapacity(objectiveState.taskIds, MAX_ORCHESTRATION_TASKS, "objective task list");
		assertRecordHasCapacity(this.state.attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
		const attemptId = `attempt-${this.createId()}`;
		this.commit({
			type: "task.attempt_prepared",
			aggregateId: task.taskId,
			actor: "runtime",
			idempotencyKey: `task-attempt-prepared:${task.taskId}:${attemptId}`,
			payload: toJsonObject({
				task,
				attemptId,
				taskId: task.taskId,
				dispatch: normalizedDispatch,
				...(grantId ? { grantId } : {}),
			}),
		});
		return {
			task: structuredClone(this.state.tasks[task.taskId]!.task),
			attempt: structuredClone(this.state.attempts[attemptId]!),
		};
	}

	queueAttempt(taskId: string, dispatch: OrchestrationDispatchRequest, grantId?: string): AttemptRuntimeState {
		this.refresh();
		const task = this.requireDispatchableTask(taskId);
		const pendingApproval = this.pendingApprovalForTask(taskId);
		if (pendingApproval) {
			throw new DurableTaskRuntimeError(
				`Task '${taskId}' is awaiting approval '${pendingApproval.request.approvalId}'.`,
			);
		}
		const normalizedDispatch = this.normalizeDispatchForTask(task, dispatch);
		this.assertTaskAttemptBudget(task, this.state.objectives[task.task.objectiveId]!.objective);
		assertRecordHasCapacity(this.state.attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
		assertIdentifierListHasCapacity(task.attemptIds, MAX_ORCHESTRATION_ATTEMPTS, "task attempt list");
		const attemptId = `attempt-${this.createId()}`;
		this.commit({
			type: "attempt.queued",
			aggregateId: taskId,
			actor: "runtime",
			idempotencyKey: `attempt-queued:${attemptId}`,
			payload: toJsonObject({ attemptId, taskId, dispatch: normalizedDispatch, ...(grantId ? { grantId } : {}) }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	/** Read-only controller seam for deciding whether one durable queued or suspended attempt may run. */
	getAttemptDispatchReadiness(attemptId: string): AttemptDispatchReadiness {
		this.refresh();
		return structuredClone(attemptDispatchReadiness(this.state, this.requireAttempt(attemptId)));
	}

	bindAttemptGrant(attemptId: string, grant: ExecutionGrant): AttemptRuntimeState {
		this.refresh();
		const normalizedGrant = executionGrantFromValue(grant, "grant");
		const attempt = assertAttemptGrantTransition(this.state, attemptId, attemptId, normalizedGrant);
		if (attempt.grantId === normalizedGrant.grantId) {
			if (attempt.grant && !isDeepStrictEqual(attempt.grant, normalizedGrant)) {
				throw new DurableTaskRuntimeError(`Attempt '${attemptId}' grant has conflicting content.`);
			}
			return structuredClone(attempt);
		}
		if (attempt.grantId) throw new DurableTaskRuntimeError(`Attempt '${attemptId}' already has a different grant.`);
		this.commit({
			type: "attempt.grant_bound",
			aggregateId: attemptId,
			actor: "policy",
			idempotencyKey: `attempt-grant-bound:${attemptId}:${normalizedGrant.grantId}`,
			payload: toJsonObject({ attemptId, grant: normalizedGrant }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	leaseAttempt(attemptId: string, ownerId: string, ttlMs: number, agentId?: string): AttemptLease {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		const lease = this.issueLease(attempt, ownerId, ttlMs);
		assertAttemptLeaseTransition(this.state, attemptId, lease, agentId, this.nowIso());
		this.commit({
			type: "attempt.leased",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-leased:${lease.leaseId}`,
			payload: toJsonObject({ lease, ...(agentId ? { agentId } : {}) }),
		});
		return structuredClone(lease);
	}

	startAttempt(attemptId: string, leaseId: string, fencingToken: number): AttemptRuntimeState {
		this.refresh();
		assertAttemptStartTransition(this.state, attemptId, attemptId, leaseId, fencingToken, this.nowIso());
		this.commit({
			type: "attempt.started",
			aggregateId: attemptId,
			actor: "worker",
			idempotencyKey: `attempt-started:${attemptId}:${fencingToken}`,
			payload: toJsonObject({ attemptId, leaseId, fencingToken }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	renewAttemptLease(attemptId: string, leaseId: string, fencingToken: number, ttlMs: number): AttemptLease {
		this.refresh();
		const attempt = this.requireLiveLease(attemptId, leaseId, fencingToken);
		if (attempt.status !== "leased" && attempt.status !== "running") {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' cannot renew from '${attempt.status}'.`);
		}
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new DurableTaskRuntimeError("Lease TTL must be positive.");
		const renewedAtMs = this.now();
		const expiresAtMs = renewedAtMs + Math.min(ttlMs, MAX_DATE_EPOCH_MS - renewedAtMs);
		if (expiresAtMs <= Date.parse(attempt.lease!.expiresAt)) return structuredClone(attempt.lease!);
		const expiresAt = new Date(expiresAtMs).toISOString();
		assertAttemptLeaseRenewalTransition(
			this.state,
			attemptId,
			attemptId,
			leaseId,
			fencingToken,
			expiresAt,
			this.nowIso(),
		);
		this.commit({
			type: "attempt.lease_renewed",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-lease-renewed:${leaseId}:${expiresAt}`,
			payload: toJsonObject({ attemptId, leaseId, fencingToken, expiresAt }),
		});
		return structuredClone(this.state.attempts[attemptId]!.lease!);
	}

	checkpointAttempt(args: {
		attemptId: string;
		leaseId: string;
		fencingToken: number;
		summary: string;
		artifactIds?: readonly string[];
		evidenceIds?: readonly string[];
		usage?: AttemptCheckpoint["usage"];
	}): AttemptCheckpoint {
		this.refresh();
		const attempt = this.requireLiveLease(args.attemptId, args.leaseId, args.fencingToken);
		if (attempt.status !== "running")
			throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' is not running.`);
		const summary = checkpointSummary(args.summary, "checkpoint.summary");
		const artifactIds = dispatchIdentifierArray(args.artifactIds ?? [], "checkpoint.artifactIds");
		const evidenceIds = dispatchIdentifierArray(args.evidenceIds ?? [], "checkpoint.evidenceIds");
		assertIdentifierListHasCapacity(attempt.checkpointIds, MAX_ORCHESTRATION_CHECKPOINTS, "attempt checkpoint list");
		assertRecordHasCapacity(this.state.checkpoints, MAX_ORCHESTRATION_CHECKPOINTS, "checkpoint");
		const checkpoint: AttemptCheckpoint = {
			checkpointId: `checkpoint-${this.createId()}`,
			attemptId: args.attemptId,
			fencingToken: args.fencingToken,
			summary,
			artifactIds,
			evidenceIds,
			...(args.usage ? { usage: usageFromPayload(args.usage, "checkpoint.usage") } : {}),
			createdAt: this.nowIso(),
		};
		assertAttemptCheckpointTransition(this.state, args.attemptId, checkpoint, args.leaseId, this.nowIso());
		this.commit({
			type: "attempt.checkpointed",
			aggregateId: args.attemptId,
			actor: "worker",
			idempotencyKey: `attempt-checkpointed:${checkpoint.checkpointId}`,
			payload: toJsonObject({ checkpoint, leaseId: args.leaseId }),
		});
		return structuredClone(checkpoint);
	}

	finishAttempt(result: WorkerResultContract): AttemptRuntimeState {
		this.refresh();
		assertAttemptFinishTransition(this.state, result.attemptId, result, this.nowIso());
		this.commit({
			type: "attempt.finished",
			aggregateId: result.attemptId,
			actor: "worker",
			idempotencyKey: `attempt-finished:${result.resultId}`,
			payload: toJsonObject({ result }),
		});
		return structuredClone(this.state.attempts[result.attemptId]!);
	}

	finishVerification(args: VerificationTransitionInput): TaskRuntimeState {
		this.refresh();
		assertVerificationTransition(this.state, args.taskId, args);
		this.commit({
			type: "task.verification_finished",
			aggregateId: args.taskId,
			actor: "runtime",
			idempotencyKey: `task-verification-finished:${args.taskId}:${args.verifierAttemptId}`,
			payload: toJsonObject({ ...args, reasonCode: args.reasonCode.trim() }),
		});
		return structuredClone(this.state.tasks[args.taskId]!);
	}

	cancelAttempt(attemptId: string, reasonCode: string): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		if (terminalAttemptStatus(attempt.status)) return structuredClone(attempt);
		if (!reasonCode.trim()) throw new DurableTaskRuntimeError("Cancellation reason is required.");
		this.commit({
			type: "attempt.cancelled",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-cancelled:${attemptId}`,
			payload: toJsonObject({ attemptId, reasonCode: reasonCode.trim() }),
		});
		return structuredClone(this.state.attempts[attemptId]!);
	}

	/**
	 * The only runtime suspension transition. Callers must present the exact current owner and lease
	 * fence; liveness/restart policy stays outside this deterministic runtime.
	 */
	suspendBoundAttempt(args: {
		attemptId: string;
		ownerId: string;
		leaseId: string;
		fencingToken: number;
		reasonCode: string;
		retry?: AttemptRetryState;
	}): AttemptRuntimeState {
		this.refresh();
		const attempt = this.requireAttempt(args.attemptId);
		if (!attempt.agentId || !attempt.lease || !["leased", "running"].includes(attempt.status)) {
			throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' is not a live agent-bound attempt.`);
		}
		if (attempt.lease.ownerId !== args.ownerId) {
			throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' is not owned by '${args.ownerId}'.`);
		}
		if (attempt.lease.leaseId !== args.leaseId || attempt.lease.fencingToken !== args.fencingToken) {
			throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' lease or fencing token is stale.`);
		}
		if (!args.reasonCode.trim()) throw new DurableTaskRuntimeError("Suspension reason is required.");
		const retry = args.retry ? retryStateFromValue(args.retry, "attempt.suspended.retry") : undefined;
		if (retry) {
			if (retry.retriesUsed !== (attempt.retry?.retriesUsed ?? 0) + 1) {
				throw new DurableTaskRuntimeError(`Attempt '${args.attemptId}' retry count is not monotonic.`);
			}
			if (Date.parse(retry.notBefore) <= this.now()) {
				throw new DurableTaskRuntimeError("Retry not-before deadline must be in the future.");
			}
		}
		this.commit({
			type: "attempt.suspended",
			aggregateId: args.attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-suspended:${args.attemptId}:${args.leaseId}:${args.fencingToken}`,
			payload: toJsonObject({
				attemptId: args.attemptId,
				leaseId: args.leaseId,
				fencingToken: args.fencingToken,
				reasonCode: args.reasonCode.trim(),
				...(retry ? { retry } : {}),
			}),
		});
		return structuredClone(this.state.attempts[args.attemptId]!);
	}

	failTask(taskId: string, reasonCode: string): TaskContract {
		this.refresh();
		const task = this.state.tasks[taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
		if (["completed", "failed", "cancelled"].includes(task.task.status)) return structuredClone(task.task);
		assertTaskFailureTransition(this.state, taskId, taskId, reasonCode);
		this.commit({
			type: "task.failed",
			aggregateId: taskId,
			actor: "runtime",
			idempotencyKey: `task-failed:${taskId}:${reasonCode.trim()}`,
			payload: toJsonObject({ taskId, reasonCode: reasonCode.trim() }),
		});
		return structuredClone(this.state.tasks[taskId]!.task);
	}

	/**
	 * Recover unbound in-process work after a process restart. A completion has no resumable model
	 * transcript, so its old lease is fenced and the task becomes dispatchable for a fresh attempt.
	 * Agent-bound attempts are intentionally excluded: those must wake the same logical agent.
	 */
	recoverInterruptedUnboundAttempts(shouldRecover: (attempt: AttemptRuntimeState) => boolean = () => true): string[] {
		this.refresh();
		const recovered: string[] = [];
		for (const attempt of Object.values(this.state.attempts)) {
			if (
				(attempt.status !== "leased" && attempt.status !== "running") ||
				attempt.agentId ||
				!shouldRecover(attempt)
			) {
				continue;
			}
			this.commit({
				type: "attempt.lease_expired",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				idempotencyKey: `attempt-process-interrupted:${attempt.attemptId}:${attempt.lease?.leaseId ?? "none"}`,
				payload: toJsonObject({
					attemptId: attempt.attemptId,
					...(attempt.lease ? { leaseId: attempt.lease.leaseId, fencingToken: attempt.lease.fencingToken } : {}),
					reasonCode: "worker_process_interrupted",
				}),
			});
			recovered.push(attempt.attemptId);
		}
		return recovered;
	}

	expireLeases(at = this.now()): string[] {
		this.refresh();
		const expired: string[] = [];
		for (const attempt of Object.values(this.state.attempts)) {
			if ((attempt.status !== "leased" && attempt.status !== "running") || !attempt.lease) continue;
			if (Date.parse(attempt.lease.expiresAt) > at) continue;
			this.commit({
				type: attempt.agentId ? "attempt.suspended" : "attempt.lease_expired",
				aggregateId: attempt.attemptId,
				actor: "runtime",
				idempotencyKey: `attempt-lease-expired:${attempt.lease.leaseId}`,
				payload: toJsonObject({
					attemptId: attempt.attemptId,
					leaseId: attempt.lease.leaseId,
					fencingToken: attempt.lease.fencingToken,
				}),
			});
			expired.push(attempt.attemptId);
		}
		return expired;
	}

	requestAgentResume(agentId: string, attemptId: string): AgentBindingContract {
		this.refresh();
		const agent = this.state.agents[agentId];
		if (!agent) throw new DurableTaskRuntimeError(`Unknown agent '${agentId}'.`);
		assertAgentNotRetired(agent, "request resume");
		const attempt = this.requireAttempt(attemptId);
		if (attempt.status !== "suspended" || attempt.agentId !== agentId || agent.activeAttemptId !== attemptId) {
			throw new DurableTaskRuntimeError(`Agent '${agentId}' cannot resume suspended attempt '${attemptId}'.`);
		}
		this.assertRetryBackoffElapsed(attempt);
		this.requireActiveObjectiveForAttempt(attempt);
		if (agent.status === "resuming") return structuredClone(agent);
		if (agent.status !== "suspended") throw new DurableTaskRuntimeError(`Agent '${agentId}' is not suspended.`);
		this.commit({
			type: "agent.resume_requested",
			aggregateId: agentId,
			actor: "runtime",
			idempotencyKey: `agent-resume-requested:${agentId}:${this.state.lastOrdinal}`,
			payload: toJsonObject({ agentId, attemptId }),
		});
		return structuredClone(this.state.agents[agentId]!);
	}

	/** Read-only guard used before changing agent state; resumeAttempt repeats it authoritatively. */
	assertAttemptReadyForResume(attemptId: string): void {
		this.refresh();
		this.assertRetryBackoffElapsed(this.requireAttempt(attemptId));
	}

	resumeAttempt(attemptId: string, agentId: string, ttlMs: number, ownerId = agentId): AttemptLease {
		this.refresh();
		const attempt = this.requireAttempt(attemptId);
		const agent = this.state.agents[agentId];
		if (attempt.status !== "suspended" || attempt.agentId !== agentId) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' is not suspended for agent '${agentId}'.`);
		}
		if (!agent || agent.status !== "resuming")
			throw new DurableTaskRuntimeError(`Agent '${agentId}' is not resuming.`);
		this.assertRetryBackoffElapsed(attempt);
		this.requireActiveObjectiveForAttempt(attempt);
		const lease = this.issueLease(attempt, ownerId, ttlMs);
		this.commit({
			type: "attempt.resumed",
			aggregateId: attemptId,
			actor: "runtime",
			idempotencyKey: `attempt-resumed:${lease.leaseId}`,
			payload: toJsonObject({ agentId, lease }),
		});
		return structuredClone(lease);
	}

	pauseObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.paused", "paused");
	}

	resumeObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.resumed", "active");
	}

	cancelObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.cancelled", "cancelled");
	}

	completeObjective(objectiveId: string): void {
		this.transitionObjective(objectiveId, "objective.completed", "completed", {
			completionPolicy: "task_evidence",
		});
	}

	completeObjectiveFromOwner(objectiveId: string, acceptanceOverride: boolean): void {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		if (objective.objective.status === "completed") return;
		if (objective.objective.status === "cancelled") {
			throw new DurableTaskRuntimeError(`Objective '${objectiveId}' is terminal.`);
		}
		this.transitionObjective(objectiveId, "objective.completed", "completed", {
			completionPolicy: acceptanceOverride ? "owner_override" : "owner_evidence",
		});
	}

	requestApproval(approval: ApprovalRequestContract): ApprovalRuntimeState {
		this.refresh();
		const normalized = approvalFromPayload(toJsonObject({ approval }));
		const existing = this.state.approvals[normalized.approvalId];
		if (existing) {
			if (!isDeepStrictEqual(existing.request, normalized)) {
				throw new DurableTaskRuntimeError(`Approval id '${normalized.approvalId}' has conflicting content.`);
			}
			return structuredClone(existing);
		}
		assertApprovalRequestTransition(
			this.state,
			normalized.attemptId ?? normalized.taskId ?? normalized.objectiveId,
			normalized,
		);
		assertRecordHasCapacity(this.state.approvals, MAX_ORCHESTRATION_APPROVALS, "approval");
		assertRecordHasCapacity(this.state.notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
		this.commit({
			type: "approval.requested",
			aggregateId: normalized.attemptId ?? normalized.taskId ?? normalized.objectiveId,
			actor: "policy",
			idempotencyKey: `approval-requested:${normalized.approvalId}`,
			payload: toJsonObject({ approval: normalized }),
		});
		return structuredClone(this.state.approvals[normalized.approvalId]!);
	}

	resolveApproval(approvalId: string, outcome: ApprovalOutcome, reasonCode: string): ApprovalRuntimeState {
		this.refresh();
		const approval = this.state.approvals[approvalId];
		if (!approval) throw new DurableTaskRuntimeError(`Unknown approval '${approvalId}'.`);
		if (approval.status !== "pending") {
			if (approval.status === outcome) return structuredClone(approval);
			throw new DurableTaskRuntimeError(`Approval '${approvalId}' was already ${approval.status}.`);
		}
		if (outcome !== "approved" && outcome !== "rejected") {
			throw new DurableTaskRuntimeError(`Unknown approval outcome '${String(outcome)}'.`);
		}
		if (!reasonCode.trim()) throw new DurableTaskRuntimeError("Approval resolution reason is required.");
		const resolution: ApprovalResolutionContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			approvalId,
			outcome,
			reasonCode: reasonCode.trim(),
			resolvedAt: this.nowIso(),
		};
		assertApprovalResolutionTransition(
			this.state,
			approval.request.attemptId ?? approval.request.taskId ?? approval.request.objectiveId,
			resolution,
		);
		this.commit({
			type: "approval.resolved",
			aggregateId: approval.request.attemptId ?? approval.request.taskId ?? approval.request.objectiveId,
			actor: "human",
			idempotencyKey: `approval-resolved:${approvalId}`,
			payload: toJsonObject({ resolution }),
		});
		return structuredClone(this.state.approvals[approvalId]!);
	}

	enqueueNotification(args: {
		notificationId?: string;
		objectiveId: string;
		attemptId?: string;
		message: string;
	}): NotificationRuntimeState {
		this.refresh();
		assertNotificationTarget(this.state, args.objectiveId, args.attemptId);
		const notificationId = args.notificationId ?? `notification-${this.createId()}`;
		const existing = this.state.notifications[notificationId];
		if (existing) {
			if (
				existing.objectiveId !== args.objectiveId ||
				existing.attemptId !== args.attemptId ||
				existing.message !== args.message
			) {
				throw new DurableTaskRuntimeError(`Notification id '${notificationId}' has conflicting content.`);
			}
			return structuredClone(existing);
		}
		assertRecordHasCapacity(this.state.notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
		this.commit({
			type: "notification.enqueued",
			aggregateId: args.objectiveId,
			actor: "runtime",
			idempotencyKey: `notification-enqueued:${notificationId}`,
			payload: toJsonObject({ ...args, notificationId }),
		});
		return structuredClone(this.state.notifications[notificationId]!);
	}

	markNotificationDelivered(notificationId: string): NotificationRuntimeState {
		this.refresh();
		const notification = this.state.notifications[notificationId];
		if (!notification) throw new DurableTaskRuntimeError(`Unknown notification '${notificationId}'.`);
		if (notification.status === "delivered") return structuredClone(notification);
		this.commit({
			type: "notification.delivered",
			aggregateId: notification.objectiveId,
			actor: "runtime",
			idempotencyKey: `notification-delivered:${notificationId}`,
			payload: toJsonObject({ notificationId }),
		});
		return structuredClone(this.state.notifications[notificationId]!);
	}

	private buildTask(input: CreateTaskInput): { task: TaskContract; objectiveState: ObjectiveRuntimeState } {
		assertRiskBudget(input.riskBudget, "task.riskBudget");
		const objectiveState = this.state.objectives[input.objectiveId];
		if (!objectiveState) throw new DurableTaskRuntimeError(`Unknown objective '${input.objectiveId}'.`);
		if (objectiveState.objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${input.objectiveId}' is not active.`);
		}
		const dependsOn = validateTaskDependencyIds(this.state.tasks, input.objectiveId, input.dependsOn);
		const acceptanceCriterionIds = [...new Set(input.acceptanceCriterionIds ?? [])];
		const now = this.nowIso();
		const task = taskFromValue(
			{
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				taskId: input.taskId ?? `task-${this.createId()}`,
				objectiveId: input.objectiveId,
				title: input.title.trim(),
				description: input.description.trim(),
				role: input.role,
				status: dependsOn.length === 0 ? "ready" : "pending",
				dependsOn,
				requiredCapabilities: [...new Set(input.requiredCapabilities ?? [])],
				acceptanceCriterionIds,
				...(input.verificationOfTaskId ? { verificationOfTaskId: input.verificationOfTaskId } : {}),
				riskBudget: { ...(input.riskBudget ?? {}) },
				createdAt: now,
				updatedAt: now,
			},
			"task",
		);
		if (this.state.tasks[task.taskId]) throw new DurableTaskRuntimeError(`Task '${task.taskId}' already exists.`);
		validateTaskContractForState(this.state, task, `Task '${task.taskId}'`);
		return { task, objectiveState };
	}

	private normalizeDispatchForTask(
		task: TaskRuntimeState,
		dispatch: OrchestrationDispatchRequest,
	): OrchestrationDispatchRequest {
		const normalizedDispatch = dispatchFromValue(dispatch, "dispatch");
		if (normalizedDispatch.taskId !== task.task.taskId) {
			throw new DurableTaskRuntimeError("Dispatch taskId does not match the queued task.");
		}
		if (
			normalizedDispatch.executionContract &&
			(normalizedDispatch.executionContract.worker.profile.profileId !== normalizedDispatch.profileId ||
				normalizedDispatch.executionContract.worker.profile.role !== task.task.role)
		) {
			throw new DurableTaskRuntimeError("Execution contract does not match the dispatch profile and task role.");
		}
		return normalizedDispatch;
	}

	private assertTaskAttemptBudget(task: TaskRuntimeState, objective: ObjectiveContract): void {
		assertTaskAttemptBudgetForState(task, objective);
	}

	private transitionObjective(
		objectiveId: string,
		type: "objective.paused" | "objective.resumed" | "objective.cancelled" | "objective.completed",
		target: ObjectiveStatus,
		payload: JsonObject = {},
	): void {
		this.refresh();
		const objective = this.requireObjective(objectiveId);
		if (objective.objective.status === target) return;
		assertObjectiveStatusTransition(
			this.state,
			objectiveId,
			target,
			type === "objective.completed"
				? (payload.completionPolicy as ObjectiveCompletionPolicy | undefined)
				: undefined,
		);
		this.commit({
			type,
			aggregateId: objectiveId,
			actor: "human",
			idempotencyKey: `${type}:${objectiveId}:${this.state.lastOrdinal}`,
			payload,
		});
	}

	private requireObjective(objectiveId: string): ObjectiveRuntimeState {
		const objective = this.state.objectives[objectiveId];
		if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
		return objective;
	}

	private requireDispatchableTask(taskId: string): TaskRuntimeState {
		const task = this.state.tasks[taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${taskId}'.`);
		const objective = this.requireObjective(task.task.objectiveId);
		if (objective.objective.status !== "active") {
			throw new DurableTaskRuntimeError(`Objective '${objective.objective.objectiveId}' is not active.`);
		}
		if (!["pending", "ready", "blocked", "failed"].includes(task.task.status)) {
			throw new DurableTaskRuntimeError(`Task '${taskId}' is not dispatchable from '${task.task.status}'.`);
		}
		const active = activeTaskAttempt(this.state, task);
		if (active) {
			throw new DurableTaskRuntimeError(`Task '${taskId}' already owns active attempt '${active.attemptId}'.`);
		}
		return task;
	}

	private requireAttempt(attemptId: string): AttemptRuntimeState {
		const attempt = this.state.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		return attempt;
	}

	private issueLease(attempt: AttemptRuntimeState, ownerId: string, ttlMs: number): AttemptLease {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new DurableTaskRuntimeError("Lease TTL must be positive.");
		const issuedAtMs = this.now();
		const expiresAtMs = issuedAtMs + Math.min(ttlMs, MAX_DATE_EPOCH_MS - issuedAtMs);
		return {
			leaseId: `lease-${this.createId()}`,
			attemptId: attempt.attemptId,
			ownerId,
			fencingToken: (attempt.lease?.fencingToken ?? 0) + 1,
			issuedAt: new Date(issuedAtMs).toISOString(),
			expiresAt: new Date(expiresAtMs).toISOString(),
		};
	}

	private pendingApprovalForTask(taskId: string): ApprovalRuntimeState | undefined {
		const task = this.state.tasks[taskId];
		if (!task) return undefined;
		return Object.values(this.state.approvals).find(
			(approval) =>
				approval.status === "pending" &&
				approval.request.attemptId === undefined &&
				approval.request.objectiveId === task.task.objectiveId &&
				(approval.request.taskId === undefined || approval.request.taskId === taskId),
		);
	}

	private requireActiveObjectiveForAttempt(attempt: AttemptRuntimeState): void {
		requireActiveObjectiveForAttemptInProjection(this.state, attempt);
	}

	private assertRetryBackoffElapsed(attempt: AttemptRuntimeState): void {
		assertRetryBackoffElapsedAt(attempt, this.now());
	}

	private requireLiveLease(attemptId: string, leaseId: string, fencingToken: number): AttemptRuntimeState {
		const attempt = this.requireAttempt(attemptId);
		if (!attempt.lease || attempt.lease.leaseId !== leaseId || attempt.lease.fencingToken !== fencingToken) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease or fencing token is stale.`);
		}
		if (Date.parse(attempt.lease.expiresAt) <= this.now()) {
			throw new DurableTaskRuntimeError(`Attempt '${attemptId}' lease expired.`);
		}
		return attempt;
	}

	private refresh(): void {
		let events: OrchestrationEvent[];
		try {
			events = this.store.readAfter(this.state.lastOrdinal);
		} catch (error) {
			if (!(error instanceof OrchestrationSnapshotRequiredError)) throw error;
			const snapshot = this.store.readProjectionSnapshot();
			if (!snapshot || snapshot.throughOrdinal < error.throughOrdinal) {
				throw new DurableTaskRuntimeError("Required orchestration projection snapshot is unavailable.");
			}
			this.state = projectionFromSnapshot(snapshot.projection, snapshot.throughOrdinal);
			events = this.store.readAfter(this.state.lastOrdinal);
		}
		for (const event of events) {
			this.state = reduceOrchestrationEvent(this.state, event);
		}
		this.compactCurrentProjection();
	}

	private commit(input: AppendOrchestrationEventInput): void {
		this.compactCurrentProjection();
		let admittedProjection: TaskRuntimeProjection | undefined;
		const event = this.store.append(input, {
			expectedLastOrdinal: this.state.lastOrdinal,
			validateBeforeCommit: (candidate) => {
				if (candidate.ordinal > this.state.lastOrdinal) {
					admittedProjection = reduceOrchestrationEvent(this.state, candidate);
				}
			},
		});
		if (admittedProjection) {
			this.state = admittedProjection;
			return;
		}
		// Exact idempotent replay can return an older event after another writer committed a
		// contiguous suffix. Adopt through readAfter so no intervening ordinal is skipped. Test stores
		// that do not execute append admission still fall back to reducing their returned next event.
		if (event.ordinal > this.state.lastOrdinal) this.refresh();
		if (event.ordinal > this.state.lastOrdinal) this.state = reduceOrchestrationEvent(this.state, event);
	}

	private compactCurrentProjection(): void {
		if (this.state.lastOrdinal > 0) {
			this.store.compactIfNeeded(this.state.lastOrdinal, () => toJsonObject(this.state));
		}
	}

	private nowIso(): string {
		return new Date(this.now()).toISOString();
	}
}
