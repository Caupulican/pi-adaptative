/**
 * Replay and refusal boundaries around the new-task correlation batch6 introduced.
 *
 * Root's review raised three candidates; each is reproduced here through the real owners before it
 * is called a defect:
 *
 * 1. `DelegationOrchestrationLedger.prepareAgentTurn` derives the inherited correlation from the
 *    specialist's LATEST attempt before it consults the receipt's own task. After an intervening
 *    genuinely new task, replaying the older continuation receipt compares the original task against
 *    a correlation it never had.
 * 2. `WorkerAgentControlCoordinator` treats an absent `newTask` as "matches anything", so a receipt
 *    admitted as new work can be replayed with continuation intent and skip the comparison.
 * 3. The coordinator synchronizes `newTask.goal` into durable orchestration state before it checks
 *    whether the start is admissible at all, so a refused start can still mutate objectives.
 *
 * A fourth case pins the complete public correlation: the ledger accepts resource pointers for new
 * work, and the public seam must carry them rather than silently dropping part of the context.
 *
 * Every case owns its scratch ledger directory and removes it even when an assertion fails. No prior
 * test file is imported, and nothing executes a model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerAgentTaskStartOptions } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
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
const AGENT_ID = "worker-1";
const FIRST_GOAL_ID = "goal-alpha";
const FIRST_REQUIREMENT_ID = "req-alpha";
const SECOND_GOAL_ID = "goal-beta";
const SECOND_REQUIREMENT_ID = "req-beta";
const RESOURCE_ID = `skill:${"c".repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

/** New-task correlation proposed on the public start options; today's type has no slot for it. */
type ProposedStartOptions = WorkerAgentTaskStartOptions & {
	newTask?: {
		goal?: GoalState;
		requirementIds?: readonly string[];
		acceptanceCriterionIds?: readonly string[];
		resourcePointerIds?: readonly string[];
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

/** One active goal carrying an exact set of open requirements. */
function goalWithRequirements(goalId: string, requirementIds: readonly string[]): GoalState {
	const base = goalFixture(goalId, requirementIds[0] ?? "req-none");
	const now = base.createdAt;
	return {
		...base,
		requirements: requirementIds.map((id) => ({
			id,
			text: `Requirement ${id}`,
			status: "open" as const,
			evidenceIds: [],
			createdAt: now,
			updatedAt: now,
		})),
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
			resourcePointers: [{ id: RESOURCE_ID, kind: "skill" as const, uri: "file:///repo/alpha.md", readOnly: true }],
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
	settle(taskId: string, criterionIds: readonly string[]): void;
}

function buildCoordinator(
	agentDir: string,
	lifecycle: WorkerLifecycle,
	sessionId: string,
): WorkerAgentControlCoordinator {
	// `startWorkerAgentTask` -> mailbox -> reconcile -> prepareAgentTurn uses exactly these deps; one
	// documented cast avoids stubbing the controller's unrelated surface. Production pairs the control
	// coordinator's parent session with the ledger session it writes, so session-scoped objective ids
	// match; a constant parent session would fabricate no-goal replay conflicts.
	return new WorkerAgentControlCoordinator({
		agentDir,
		parentSessionId: sessionId,
		processOwnerId: "replay-boundary-owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		recoveredRequest: (attempt: AttemptRuntimeState): WorkerDelegationRequest =>
			({
				instructions: attempt.dispatch.instructions,
				profileId: attempt.dispatch.profileId,
			}) as WorkerDelegationRequest,
		run: async () => ({ started: false, skipReason: "test_harness_does_not_execute" }),
		scheduler: { enqueue: () => true, track: () => {}, drain: () => {}, dropQueued: () => {} },
		statusChanged: () => {},
		abortLane: () => {},
		cancelLane: () => undefined,
	} as unknown as ConstructorParameters<typeof WorkerAgentControlCoordinator>[0]);
}

/** One specialist whose first task completed under its own goal. */
function seamWithIdleSpecialist(sessionId: string): Seam {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-specialist-replay-"));
	roots.push(agentDir);
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
	const profile = profileFixture();
	const prepared = lifecycle.prepare(
		{
			instructions: "first task",
			executionContract: contractFor(profile),
			requiredCapabilities: [],
			goal: goalFixture(FIRST_GOAL_ID, FIRST_REQUIREMENT_ID),
			taskContext: {
				requirementIds: [FIRST_REQUIREMENT_ID],
				acceptanceCriterionIds: [FIRST_REQUIREMENT_ID],
				resourcePointerIds: [RESOURCE_ID],
				dependsOnTaskIds: [],
			},
		},
		AGENT_ID,
	);
	lifecycle.ensureAgent({ agentId: AGENT_ID, role: profile.role, resumeContext: resumeContext() });
	const settle = (taskId: string, criterionIds: readonly string[]): void => {
		const attempt = lifecycle.getTaskRuntimeSnapshot().tasks[taskId]?.attemptIds.at(-1);
		if (!attempt) throw new Error(`No attempt for ${taskId}`);
		const task = lifecycle.getTask(taskId);
		if (!task) throw new Error(`No durable task for ${taskId}`);
		lifecycle.bindGrant(
			attempt,
			createTestExecutionGrant({ objectiveId: task.task.objectiveId, taskId, attemptId: attempt }),
		);
		const handle = lifecycle.startAgent(taskId, AGENT_ID, LEASE_TTL_MS);
		lifecycle.finish(completedResult(handle, criterionIds), { notify: false });
	};
	settle(prepared.attempt.taskId, [FIRST_REQUIREMENT_ID]);
	return { agentDir, sessionId, lifecycle, coordinator: buildCoordinator(agentDir, lifecycle, sessionId), settle };
}

/** The specialist's newest turn task, excluding its birth task. */
function latestTurnTaskId(seam: Seam): string | undefined {
	return seam.lifecycle.getLatestAgentAttempt(AGENT_ID)?.taskId;
}

function objectiveIds(seam: Seam): string[] {
	return Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().objectives).sort();
}

describe("specialist replay boundaries", () => {
	// The durable ledger is the owner of replay identity; `WorkerLifecycle.prepareAgentTurn` is a thin
	// projection wrapper over it whose own input type does not yet expose new-task correlation.
	it("replays an older continuation receipt against its own task after newer work changed the correlation", () => {
		const seam = seamWithIdleSpecialist("replay-continuation");
		const continuation = seam.lifecycle.ledger.prepareAgentTurn({
			agentId: AGENT_ID,
			instructions: "continue the first goal",
			controlMessageId: "control-continuation",
		});
		seam.settle(continuation.attempt.taskId, [FIRST_REQUIREMENT_ID]);
		// Genuinely new work moves this specialist's latest correlation to another goal.
		const newWork = seam.lifecycle.ledger.prepareAgentTurn({
			agentId: AGENT_ID,
			instructions: "do the unrelated second goal",
			controlMessageId: "control-new-work",
			goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID),
			taskContext: { requirementIds: [SECOND_REQUIREMENT_ID], acceptanceCriterionIds: [SECOND_REQUIREMENT_ID] },
		});
		seam.settle(newWork.attempt.taskId, [SECOND_REQUIREMENT_ID]);
		const tasksBefore = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		const replay = seam.lifecycle.ledger.prepareAgentTurn({
			agentId: AGENT_ID,
			instructions: "continue the first goal",
			controlMessageId: "control-continuation",
		});

		// A receipt's identity is the task it originally admitted, not whatever the specialist has
		// done since: the replay returns that exact task and writes nothing.
		expect(replay.created).toBe(false);
		expect(replay.attempt.taskId).toBe(continuation.attempt.taskId);
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(tasksBefore);
	});

	it("negative control: a genuinely different explicit correlation on one receipt is still rejected", () => {
		const seam = seamWithIdleSpecialist("replay-conflict");
		seam.lifecycle.ledger.prepareAgentTurn({
			agentId: AGENT_ID,
			instructions: "continue the first goal",
			controlMessageId: "control-continuation",
		});
		const tasksBefore = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		expect(() =>
			seam.lifecycle.ledger.prepareAgentTurn({
				agentId: AGENT_ID,
				instructions: "continue the first goal",
				controlMessageId: "control-continuation",
				goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID),
				taskContext: { requirementIds: [SECOND_REQUIREMENT_ID], acceptanceCriterionIds: [SECOND_REQUIREMENT_ID] },
			}),
		).toThrow(/conflicting/);
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(tasksBefore);
	});

	it("rejects a receipt first admitted as new work when it is replayed as a continuation", () => {
		const seam = seamWithIdleSpecialist("replay-intent");
		const options: ProposedStartOptions = {
			idempotencyKey: "intent-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		};
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "same instructions", options);
		expect(admitted.messageId).not.toBe("");
		const admittedTaskId = latestTurnTaskId(seam);

		const replayedAsContinuation = seam.coordinator.startWorkerAgentTask(AGENT_ID, "same instructions", {
			idempotencyKey: "intent-1",
		});

		// New work and continuation are different intents for the same text; one receipt cannot mean
		// both, and the replay must not be accepted as if it had asked for what was admitted.
		expect(replayedAsContinuation.started).toBe(false);
		expect(replayedAsContinuation.skipReason ?? "").toMatch(/conflict/i);
		expect(latestTurnTaskId(seam)).toBe(admittedTaskId);
	});

	it("negative control: a no-goal receipt replays onto its own task with no writes", () => {
		const seam = seamWithIdleSpecialist("replay-no-goal");
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "session-scoped new work", {
			idempotencyKey: "no-goal-1",
			newTask: {},
		} as ProposedStartOptions);
		expect(admitted.messageId).not.toBe("");
		const taskId = latestTurnTaskId(seam);
		const tasksBefore = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		const replay = seam.coordinator.startWorkerAgentTask(AGENT_ID, "session-scoped new work", {
			idempotencyKey: "no-goal-1",
			newTask: {},
		} as ProposedStartOptions);

		expect(replay.messageId).toBe(admitted.messageId);
		expect(latestTurnTaskId(seam)).toBe(taskId);
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(tasksBefore);
		expect(seam.lifecycle.getTask(taskId ?? "")?.task.objectiveId).toBe(`session:${seam.sessionId}`);
	});

	it("negative control: the same goal with moved timestamps and progress is the same receipt", () => {
		const seam = seamWithIdleSpecialist("replay-volatile-goal");
		const goal = goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID);
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "stable identity work", {
			idempotencyKey: "volatile-1",
			newTask: { goal, requirementIds: [SECOND_REQUIREMENT_ID] },
		} as ProposedStartOptions);
		expect(admitted.messageId).not.toBe("");
		const taskId = latestTurnTaskId(seam);
		const tasksBefore = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		const later = new Date(Date.now() + 60_000).toISOString();
		const moved = {
			...goal,
			updatedAt: later,
			lastProgressAt: later,
			stallTurns: goal.stallTurns + 3,
			requirements: goal.requirements.map((requirement) => ({ ...requirement, updatedAt: later })),
		};
		const replay = seam.coordinator.startWorkerAgentTask(AGENT_ID, "stable identity work", {
			idempotencyKey: "volatile-1",
			newTask: { goal: moved, requirementIds: [SECOND_REQUIREMENT_ID] },
		} as ProposedStartOptions);

		// Replay identity is the work's stable correlation, not the goal's moving progress fields.
		expect(replay.messageId).toBe(admitted.messageId);
		expect(replay.skipReason ?? "").not.toMatch(/conflict/i);
		expect(latestTurnTaskId(seam)).toBe(taskId);
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(tasksBefore);
	});

	it("carries a full-width requirement and criterion set through the reused public path", () => {
		const seam = seamWithIdleSpecialist("replay-wide-correlation");
		const wide = Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH }, (_, index) => `req-wide-${index}`);
		const goal = goalWithRequirements(SECOND_GOAL_ID, wide);

		const accepted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "wide correlation work", {
			idempotencyKey: "wide-1",
			newTask: { goal, requirementIds: wide, acceptanceCriterionIds: wide },
		} as ProposedStartOptions);

		expect(accepted.messageId).not.toBe("");
		const attempt = seam.lifecycle.getLatestAgentAttempt(AGENT_ID);
		// The durable dispatch contract admits 64 ids; a narrower mailbox bound must not truncate or
		// refuse a correlation the dispatch owner accepts.
		expect(attempt?.dispatch.requirementIds).toEqual(wide);
		expect(seam.lifecycle.getTask(attempt?.taskId ?? "")?.task.acceptanceCriterionIds).toEqual(wide);
	});

	it("negative control: a correlation wider than the durable dispatch bound is refused", () => {
		const seam = seamWithIdleSpecialist("replay-over-wide");
		const tooWide = Array.from(
			{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH + 1 },
			(_, index) => `req-over-${index}`,
		);
		const goal = goalWithRequirements(SECOND_GOAL_ID, tooWide);
		const tasksBefore = Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks).length;

		let refused = false;
		try {
			const outcome = seam.coordinator.startWorkerAgentTask(AGENT_ID, "over-wide correlation work", {
				idempotencyKey: "over-wide-1",
				newTask: { goal, requirementIds: tooWide, acceptanceCriterionIds: tooWide },
			} as ProposedStartOptions);
			refused = outcome.started === false;
		} catch {
			refused = true;
		}

		expect(refused).toBe(true);
		expect(Object.keys(seam.lifecycle.getTaskRuntimeSnapshot().tasks)).toHaveLength(tasksBefore);
	});

	it("does not mutate durable goal state when the start it came with is refused", () => {
		const seam = seamWithIdleSpecialist("replay-refused");
		seam.lifecycle.retireAgent(AGENT_ID);
		const before = objectiveIds(seam);

		const refused = seam.coordinator.startWorkerAgentTask(AGENT_ID, "work for a retired specialist", {
			idempotencyKey: "refused-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		} as ProposedStartOptions);

		// The request was never accepted, so nothing of its context may be persisted.
		expect(refused.started).toBe(false);
		expect(objectiveIds(seam)).toEqual(before);
		expect(objectiveIds(seam)).not.toContain(`goal:${SECOND_GOAL_ID}`);
	});

	it("carries the complete new-task context, including its selected resources, through the public seam", () => {
		const seam = seamWithIdleSpecialist("replay-resources");

		const accepted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "new work with selected resources", {
			idempotencyKey: "resources-1",
			newTask: {
				goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID),
				requirementIds: [SECOND_REQUIREMENT_ID],
				acceptanceCriterionIds: [SECOND_REQUIREMENT_ID],
				resourcePointerIds: [RESOURCE_ID],
			},
		} as ProposedStartOptions);

		expect(accepted.messageId).not.toBe("");
		const attempt = seam.lifecycle.getLatestAgentAttempt(AGENT_ID);
		// A partially carried context is a wrong context: resources belong to the same declaration as
		// requirements and acceptance criteria.
		expect(attempt?.dispatch.requirementIds).toEqual([SECOND_REQUIREMENT_ID]);
		expect(attempt?.dispatch.resourcePointerIds).toEqual([RESOURCE_ID]);
	});
});
