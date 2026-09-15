/**
 * The public reuse seam cannot say "this is new work".
 *
 * `delegate start` with an `agentId` reaches `WorkerAgentControlCoordinator.startWorkerAgentTask`,
 * which enqueues a durable mailbox message carrying `WorkerAgentTaskMetadata` (`kind: "agent_turn"`,
 * plus `dependsOnTaskIds`) and then reconciles it into `WorkerLifecycle.prepareAgentTurn`. That
 * metadata has no slot for the new task's own goal correlation, and `prepareAgentTurn` inherits the
 * prior task's objective, requirements, acceptance criteria and resources.
 *
 * So through the real public seam - not just the ledger - a genuinely new task dispatched onto a
 * reused specialist is filed under the goal that specialist happened to run first. Mandatory reuse
 * would apply that to every reused specialist.
 *
 * The fix must ride the PERSISTED mailbox task metadata, not a process-local map: a follow-up may be
 * enqueued in one process and reconciled after a restart. These tests therefore reopen the mailbox in
 * a second coordinator over the same `agentDir` and assert the correlation survives.
 *
 * The proposed input is `newTask` on `WorkerAgentTaskStartOptions`, mirrored into the persisted
 * `WorkerAgentTaskMetadata`. Current code ignores it, which is what makes the inherited correlation
 * observable rather than a compile error. Nothing here fakes a method or relies on an import failing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerAgentTaskStartOptions } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState } from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const LEASE_TTL_MS = 60_000;
const PARENT_SESSION = "parent-session";
const AGENT_ID = "worker-1";
const PRIOR_GOAL_ID = "goal-alpha";
const PRIOR_REQUIREMENT_ID = "req-alpha";
const NEXT_GOAL_ID = "goal-beta";
const NEXT_REQUIREMENT_ID = "req-beta";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * The durable new-task correlation the public seam needs. Proposed on the existing start options so
 * a fix persists it in `WorkerAgentTaskMetadata` rather than a process-local side map.
 */
type ProposedTaskStartOptions = WorkerAgentTaskStartOptions & {
	newTask?: {
		goal?: GoalState;
		requirementIds?: readonly string[];
		acceptanceCriterionIds?: readonly string[];
	};
};

function goalFixture(goalId: string, requirementId: string): GoalState {
	const now = new Date().toISOString();
	return {
		goalId,
		userGoal: `Goal ${goalId}`,
		status: "active",
		requirements: [
			{
				id: requirementId,
				text: `Requirement for ${goalId}`,
				status: "open",
				evidenceIds: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		evidence: [],
		events: [],
		createdAt: now,
		updatedAt: now,
		lastProgressAt: now,
		stallTurns: 0,
	};
}

function profileFixture(): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId: "implementer",
		model: { provider: "anthropic", id: "test-model" },
	});
}

function contractFor(profile: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
		},
	});
}

function resumeContext(): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `worker-${AGENT_ID}`,
		cwd: "/repo",
		resourceProfileNames: [],
		contextPointers: [],
	};
}

function completedResult(handle: StartedDelegationAttempt, criterionIds: readonly string[]): WorkerResultContract {
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
		evidence: criterionIds.map((criterionId) => ({
			evidenceId: `evidence-${handle.attemptId}-${criterionId}`,
			criterionId,
			kind: "observation" as const,
			summary: `Observed ${criterionId}`,
			artifactIds: [],
			trusted: true,
			createdAt: new Date().toISOString(),
		})),
		errors: [],
		usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
		createdAt: new Date().toISOString(),
	};
}

interface Seam {
	agentDir: string;
	sessionId: string;
	lifecycle: WorkerLifecycle;
	coordinator: WorkerAgentControlCoordinator;
	scheduler: SchedulerObserver;
	/**
	 * A genuine restart: a NEW `WorkerLifecycle` replayed from the same on-disk ledger session, and a
	 * new coordinator over it. Nothing is carried across in memory.
	 */
	restart(): { lifecycle: WorkerLifecycle; coordinator: WorkerAgentControlCoordinator; scheduler: SchedulerObserver };
}

interface SchedulerObserver {
	enqueued: string[];
}

function buildCoordinator(
	agentDir: string,
	lifecycle: WorkerLifecycle,
	observer: SchedulerObserver,
): WorkerAgentControlCoordinator {
	// `startWorkerAgentTask` -> mailbox -> reconcile -> prepareAgentTurn uses exactly these deps; one
	// documented cast avoids stubbing the controller's unrelated surface.
	return new WorkerAgentControlCoordinator({
		agentDir,
		parentSessionId: PARENT_SESSION,
		processOwnerId: "test-owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		// A real recovered request derived from the durable attempt: recovery must not be a throw, or a
		// correlation assertion could silently pass on a lane that was never scheduled.
		recoveredRequest: (attempt: AttemptRuntimeState): WorkerDelegationRequest =>
			({
				instructions: attempt.dispatch.instructions,
				profileId: attempt.dispatch.profileId,
			}) as WorkerDelegationRequest,
		run: async () => ({ started: false, skipReason: "test_harness_does_not_execute" }),
		scheduler: {
			enqueue: (record: { laneId: string }) => {
				observer.enqueued.push(record.laneId);
				return true;
			},
			track: () => {},
			drain: () => {},
			dropQueued: () => {},
		},
		statusChanged: () => {},
		abortLane: () => {},
		cancelLane: () => undefined,
	} as unknown as ConstructorParameters<typeof WorkerAgentControlCoordinator>[0]);
}

/** Register a specialist whose first task is complete and bound to its own goal. */
function seamWithIdleSpecialist(sessionId: string): Seam {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-agent-task-correlation-"));
	roots.push(agentDir);
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
	const profile = profileFixture();
	const prepared = lifecycle.prepare(
		{
			instructions: "first task",
			executionContract: contractFor(profile),
			requiredCapabilities: [],
			goal: goalFixture(PRIOR_GOAL_ID, PRIOR_REQUIREMENT_ID),
			taskContext: {
				requirementIds: [PRIOR_REQUIREMENT_ID],
				acceptanceCriterionIds: [PRIOR_REQUIREMENT_ID],
				resourcePointerIds: [],
				dependsOnTaskIds: [],
			},
		},
		AGENT_ID,
	);
	lifecycle.ensureAgent({ agentId: AGENT_ID, role: profile.role, resumeContext: resumeContext() });
	const task = lifecycle.getTask(prepared.attempt.taskId);
	if (!task) throw new Error("first task was not created");
	lifecycle.bindGrant(
		prepared.attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: prepared.attempt.taskId,
			attemptId: prepared.attempt.attemptId,
		}),
	);
	const handle = lifecycle.startAgent(prepared.attempt.taskId, AGENT_ID, LEASE_TTL_MS);
	lifecycle.finish(completedResult(handle, [PRIOR_REQUIREMENT_ID]), { notify: false });

	const scheduler: SchedulerObserver = { enqueued: [] };
	return {
		agentDir,
		sessionId,
		lifecycle,
		scheduler,
		coordinator: buildCoordinator(agentDir, lifecycle, scheduler),
		restart: () => {
			const replayed = new WorkerLifecycle({ agentDir, sessionId });
			const replayedScheduler: SchedulerObserver = { enqueued: [] };
			return {
				lifecycle: replayed,
				coordinator: buildCoordinator(agentDir, replayed, replayedScheduler),
				scheduler: replayedScheduler,
			};
		},
	};
}

function newTaskOptions(overrides: Partial<ProposedTaskStartOptions> = {}): ProposedTaskStartOptions {
	return {
		newTask: {
			goal: goalFixture(NEXT_GOAL_ID, NEXT_REQUIREMENT_ID),
			requirementIds: [NEXT_REQUIREMENT_ID],
			acceptanceCriterionIds: [NEXT_REQUIREMENT_ID],
		},
		...overrides,
	};
}

function correlationOf(lifecycle: WorkerLifecycle): {
	taskId?: string;
	objectiveId?: string;
	requirementIds?: readonly string[];
	acceptanceCriterionIds?: readonly string[];
} {
	const attempt = lifecycle.getLatestAgentAttempt(AGENT_ID);
	if (!attempt) return {};
	const task = lifecycle.getTask(attempt.taskId);
	return {
		taskId: attempt.taskId,
		objectiveId: task?.task.objectiveId,
		requirementIds: attempt.dispatch.requirementIds,
		acceptanceCriterionIds: task?.task.acceptanceCriterionIds,
	};
}

function currentTaskCorrelation(seam: Seam) {
	return correlationOf(seam.lifecycle);
}

/** Durable task ids owned by this specialist, excluding its completed first task. */
function agentTurnTaskIds(lifecycle: WorkerLifecycle): string[] {
	return Object.values(lifecycle.getTaskRuntimeSnapshot().attempts)
		.filter((attempt) => attempt.dispatch.logicalLaneId === AGENT_ID && attempt.taskId !== AGENT_ID)
		.map((attempt) => attempt.taskId);
}

describe("worker agent control new-task correlation", () => {
	it("binds an explicitly new task to its own goal through the public start seam", () => {
		const seam = seamWithIdleSpecialist("seam-objective");

		const started = seam.coordinator.startWorkerAgentTask(AGENT_ID, "unrelated new work", newTaskOptions());

		expect(started.messageId).not.toBe("");
		const correlation = currentTaskCorrelation(seam);
		expect(correlation.objectiveId).toBe(`goal:${NEXT_GOAL_ID}`);
		expect(correlation.objectiveId).not.toBe(`goal:${PRIOR_GOAL_ID}`);
		expect(correlation.requirementIds).toEqual([NEXT_REQUIREMENT_ID]);
	});

	it("reconstructs the new-task correlation from persisted mailbox metadata after an interrupted prepare", () => {
		const seam = seamWithIdleSpecialist("seam-persisted");
		// Fault injected at the existing durable boundary: the mailbox message is accepted, but the
		// durable task is never created. This is the crash window a restart has to recover from.
		const fault = vi.spyOn(seam.lifecycle, "prepareAgentTurn").mockImplementationOnce(() => {
			throw new Error("interrupted before durable task creation");
		});

		const started = seam.coordinator.startWorkerAgentTask(AGENT_ID, "unrelated new work", newTaskOptions());

		expect(started.messageId).not.toBe("");
		expect(started.started).toBe(false);
		// Nothing durable was created, so recovery has only the persisted mailbox metadata to work from.
		expect(agentTurnTaskIds(seam.lifecycle)).toEqual([]);
		fault.mockRestore();

		// A genuine restart: fresh lifecycle replayed from the same ledger session, fresh coordinator.
		// No caller supplies the task data again; only the persisted message can carry it.
		const restarted = seam.restart();
		restarted.coordinator.reconcileTaskBearingMailboxTurns();

		const correlation = correlationOf(restarted.lifecycle);
		expect(correlation.taskId).toBeDefined();
		expect(restarted.scheduler.enqueued).toContain(correlation.taskId);
		expect(correlation.objectiveId).toBe(`goal:${NEXT_GOAL_ID}`);
		expect(correlation.objectiveId).not.toBe(`goal:${PRIOR_GOAL_ID}`);
		expect(correlation.requirementIds).toEqual([NEXT_REQUIREMENT_ID]);
	});

	it("binds an explicit new task with no goal to session scope through the public seam", () => {
		const seam = seamWithIdleSpecialist("seam-no-goal");

		// New work that belongs to no goal must not be filed under the specialist's first goal. The
		// options go through the same structural variable as every other case here: an inline literal
		// would be an excess-property error against today's `WorkerAgentTaskStartOptions`.
		const options: ProposedTaskStartOptions = { newTask: {} };
		const started = seam.coordinator.startWorkerAgentTask(AGENT_ID, "ungoaled new work", options);

		expect(started.messageId).not.toBe("");
		const correlation = currentTaskCorrelation(seam);
		expect(correlation.objectiveId).toBe("session:seam-no-goal");
		expect(correlation.objectiveId).not.toBe(`goal:${PRIOR_GOAL_ID}`);
		expect(correlation.acceptanceCriterionIds).toEqual([]);
	});

	it("rejects a replayed receipt whose new-task correlation conflicts with the original", () => {
		const seam = seamWithIdleSpecialist("seam-conflict");
		const idempotencyKey = "replay-1";
		seam.coordinator.startWorkerAgentTask(AGENT_ID, "same work", newTaskOptions({ idempotencyKey }));
		const tasksBefore = agentTurnTaskIds(seam.lifecycle).length;

		// Same receipt, same instructions, different correlation. The coordinator's replay path must
		// not skip the validation the ledger applies to a conflicting task identity.
		const conflicting = seam.coordinator.startWorkerAgentTask(AGENT_ID, "same work", {
			idempotencyKey,
			newTask: { goal: goalFixture("goal-gamma", "req-gamma"), requirementIds: ["req-gamma"] },
		} as ProposedTaskStartOptions);

		expect(conflicting.started).toBe(false);
		expect(conflicting.skipReason ?? "").toMatch(/conflict/i);
		expect(agentTurnTaskIds(seam.lifecycle)).toHaveLength(tasksBefore);
	});

	it("negative control: a follow-up with no new-task correlation continues the prior objective", () => {
		const seam = seamWithIdleSpecialist("seam-continuation");

		const started = seam.coordinator.startWorkerAgentTask(AGENT_ID, "keep going on the same work");

		expect(started.messageId).not.toBe("");
		const correlation = currentTaskCorrelation(seam);
		expect(correlation.objectiveId).toBe(`goal:${PRIOR_GOAL_ID}`);
		expect(correlation.requirementIds).toEqual([PRIOR_REQUIREMENT_ID]);
	});

	it("negative control: an unknown agent is refused without touching durable state", () => {
		const seam = seamWithIdleSpecialist("seam-unknown");
		const before = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		const started = seam.coordinator.startWorkerAgentTask("worker-absent", "work", newTaskOptions());

		expect(started.started).toBe(false);
		expect(started.skipReason).toBe("unknown_agent");
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(before);
	});

	it("negative control: a replayed idempotency key does not mint a second task", () => {
		const seam = seamWithIdleSpecialist("seam-replay");
		const options = newTaskOptions({ idempotencyKey: "replay-1" });

		seam.coordinator.startWorkerAgentTask(AGENT_ID, "unrelated new work", options);
		const afterFirst = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;
		seam.coordinator.startWorkerAgentTask(AGENT_ID, "unrelated new work", options);

		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(afterFirst);
	});
});
