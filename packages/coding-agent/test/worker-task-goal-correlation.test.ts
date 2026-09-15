/**
 * A new task on an existing specialist binds the PRIOR task's goal correlation.
 *
 * `DelegationOrchestrationLedger.prepareAgentTurn` inherits the immutable execution contract from the
 * last bound turn, which is correct — identity, model and grant are the specialist. It also inherits
 * the prior task's WORK correlation, which is not (delegation-ledger.ts:236-264):
 *
 *   goalId                  <- priorTask.objectiveId
 *   requirementIds          <- prior.dispatch.requirementIds
 *   acceptanceCriterionIds  <- priorTask.acceptanceCriterionIds
 *   resourcePointerIds      <- prior.dispatch.resourcePointerIds
 *
 * So a genuinely new task dispatched onto a reused specialist is filed under the goal it is not
 * doing, and completing it reports against acceptance criteria it was never given. That is the exact
 * failure mode mandatory reuse would multiply: every reused specialist would drag its first goal
 * along forever.
 *
 * `PrepareAgentTurnInput` has no way to say "this is new work, correlate it to THIS goal". These
 * tests pass one durable discriminator on the existing input — `taskContext`, the same shape
 * `PrepareDelegationInput` already carries for a fresh dispatch, plus the `goal` the fresh path also
 * accepts. Current code ignores both extra fields, which is what makes the inherited correlation
 * observable rather than a compile error. The field is deliberately chosen so a fix can thread it
 * through persisted mailbox task metadata (`WorkerAgentMessage.task`) rather than a process-local map.
 *
 * The explicit continuation case is the control: `follow_up` on the same objective SHOULD inherit,
 * and that behaviour must survive the fix.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import {
	DelegationOrchestrationLedger,
	type PrepareAgentTurnInput,
	type StartedDelegationAttempt,
} from "../src/core/orchestration/delegation-ledger.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const LEASE_TTL_MS = 60_000;
const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-task-goal-correlation-"));
	roots.push(directory);
	return directory;
}

function profileFixture(): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId: "implementer",
		model: { provider: "anthropic", id: "test-model" },
	});
}

// Resource pointer ids are `skill:<64 hex>` / `prompt:<64 hex>` by contract (worker-execution-contract).
const PRIOR_RESOURCE_ID = `skill:${"a".repeat(64)}`;
const NEXT_RESOURCE_ID = `prompt:${"b".repeat(64)}`;

function contractFor(profile: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
			// Two genuinely distinct admitted resources, so "the new task selected a different one" is
			// an observable fact rather than two empty arrays comparing equal.
			resourcePointers: [
				{ id: PRIOR_RESOURCE_ID, kind: "skill" as const, uri: "file:///repo/alpha.md", readOnly: true },
				{ id: NEXT_RESOURCE_ID, kind: "prompt" as const, uri: "file:///repo/beta.md", readOnly: true },
			],
		},
	});
}

function resumeContext(agentId: string): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `worker-${agentId}`,
		cwd: "/repo",
		resourceProfileNames: [],
		contextPointers: [],
	};
}

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

function completedResult(handle: StartedDelegationAttempt, criterionIds: readonly string[] = []): WorkerResultContract {
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
		// A completed result must prove every acceptance criterion its task carries; that guard is
		// exactly what makes an inherited criterion harmful on an unrelated follow-on task.
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

/**
 * The durable new-task correlation a reused specialist needs. `taskContext` and `goal` already exist
 * on `PrepareDelegationInput`; current `prepareAgentTurn` accepts neither, so the cast documents a
 * proposed input rather than a fabricated implementation.
 */
type ProposedAgentTurnInput = PrepareAgentTurnInput & {
	goal?: GoalState;
	taskContext?: {
		requirementIds?: readonly string[];
		acceptanceCriterionIds?: readonly string[];
		resourcePointerIds?: readonly string[];
		dependsOnTaskIds?: readonly string[];
	};
};

interface Harness {
	ledger: DelegationOrchestrationLedger;
	agentId: string;
	priorGoalId: string;
	priorRequirementId: string;
	prerequisiteTaskId: string;
}

/** Grant, lease and complete one prepared attempt, proving any acceptance criteria it carries. */
function settleAttempt(
	ledger: DelegationOrchestrationLedger,
	attempt: { attemptId: string; taskId: string },
	ownerId: string,
): void {
	const task = ledger.runtime.getSnapshot().tasks[attempt.taskId];
	if (!task) throw new Error(`No durable task for ${attempt.taskId}`);
	ledger.runtime.bindAttemptGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
		}),
	);
	const handle = ledger.start(attempt.attemptId, LEASE_TTL_MS, ownerId);
	ledger.runtime.finishAttempt(completedResult(handle, task.task.acceptanceCriterionIds));
}

/** Register one specialist and complete a first task bound to its own goal. */
function specialistWithCompletedFirstTask(sessionId: string): Harness {
	const ledger = new DelegationOrchestrationLedger({ agentDir: root(), sessionId });
	const profile = profileFixture();
	const priorGoalId = "goal-alpha";
	const priorRequirementId = "req-alpha";
	const agentId = "worker-1";
	const contract = contractFor(profile);
	// A real earlier task on the same objective, so `dependsOnTaskIds` can reference something valid.
	// It must reach a terminal state, or the dependent task below can never lease.
	const prerequisite = ledger.prepare({
		laneId: "prerequisite",
		instructions: "prerequisite task",
		executionContract: contract,
		requiredCapabilities: [],
		goal: goalFixture(priorGoalId, priorRequirementId),
	});
	settleAttempt(ledger, prerequisite, "prerequisite-owner");
	const attempt = ledger.prepare({
		laneId: agentId,
		instructions: "first task",
		executionContract: contract,
		requiredCapabilities: [],
		goal: goalFixture(priorGoalId, priorRequirementId),
		taskContext: {
			requirementIds: [priorRequirementId],
			acceptanceCriterionIds: [priorRequirementId],
			resourcePointerIds: [PRIOR_RESOURCE_ID],
			dependsOnTaskIds: [prerequisite.taskId],
		},
	});
	ledger.runtime.registerAgent({ agentId, role: profile.role, resumeContext: resumeContext(agentId) });
	const task = ledger.runtime.getSnapshot().tasks[attempt.taskId];
	if (!task) throw new Error("first task was not created");
	ledger.runtime.bindAttemptGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
		}),
	);
	// Bound to the agent, so `prepareAgentTurn` has a prior agent attempt to inherit its contract from.
	const handle = ledger.start(attempt.attemptId, LEASE_TTL_MS, agentId, agentId);
	ledger.runtime.finishAttempt(completedResult(handle, [priorRequirementId]));
	return { ledger, agentId, priorGoalId, priorRequirementId, prerequisiteTaskId: prerequisite.taskId };
}

describe("new task goal correlation on a reused specialist", () => {
	it("binds the new task's own goal instead of inheriting the prior task's objective", () => {
		const h = specialistWithCompletedFirstTask("correlation-objective");
		const nextGoalId = "goal-beta";

		const turn: ProposedAgentTurnInput = {
			agentId: h.agentId,
			instructions: "unrelated second task",
			goal: goalFixture(nextGoalId, "req-beta"),
		};
		const { attempt } = h.ledger.prepareAgentTurn(turn);

		const snapshot = h.ledger.runtime.getSnapshot();
		const task = snapshot.tasks[attempt.taskId];
		expect(task).toBeDefined();
		expect(task?.task.objectiveId).toBe(`goal:${nextGoalId}`);
		expect(task?.task.objectiveId).not.toBe(`goal:${h.priorGoalId}`);
	});

	it("binds the new task's own requirements, acceptance criteria, resources and dependencies", () => {
		const h = specialistWithCompletedFirstTask("correlation-context");
		// A second real task on the new objective, so the new dependency is a valid durable reference.
		const nextPrerequisite = h.ledger.prepare({
			laneId: "next-prerequisite",
			instructions: "next prerequisite",
			executionContract: contractFor(profileFixture()),
			requiredCapabilities: [],
			goal: goalFixture("goal-beta", "req-beta"),
		});

		const turn: ProposedAgentTurnInput = {
			agentId: h.agentId,
			instructions: "unrelated second task",
			goal: goalFixture("goal-beta", "req-beta"),
			taskContext: {
				requirementIds: ["req-beta"],
				acceptanceCriterionIds: ["req-beta"],
				resourcePointerIds: [NEXT_RESOURCE_ID],
				dependsOnTaskIds: [nextPrerequisite.taskId],
			},
		};
		const { attempt } = h.ledger.prepareAgentTurn(turn);

		const task = h.ledger.runtime.getSnapshot().tasks[attempt.taskId];
		expect(attempt.dispatch.requirementIds).toEqual(["req-beta"]);
		expect(task?.task.acceptanceCriterionIds).toEqual(["req-beta"]);
		expect(attempt.dispatch.resourcePointerIds).toEqual([NEXT_RESOURCE_ID]);
		expect(task?.task.dependsOn).toEqual([nextPrerequisite.taskId]);
		// The prior work's correlation must not survive into work that never targeted it.
		expect(task?.task.acceptanceCriterionIds).not.toContain(h.priorRequirementId);
		expect(attempt.dispatch.resourcePointerIds).not.toContain(PRIOR_RESOURCE_ID);
		expect(task?.task.dependsOn).not.toContain(h.prerequisiteTaskId);
	});

	it("does not retain the prior task's correlation when the new task omits those fields", () => {
		const h = specialistWithCompletedFirstTask("correlation-omitted");

		// An explicit new task that names only its goal: the omitted fields must be empty, not
		// silently refilled from the task this specialist happened to run first.
		const turn: ProposedAgentTurnInput = {
			agentId: h.agentId,
			instructions: "new work with no extra context",
			goal: goalFixture("goal-beta", "req-beta"),
			taskContext: {},
		};
		const { attempt } = h.ledger.prepareAgentTurn(turn);

		const task = h.ledger.runtime.getSnapshot().tasks[attempt.taskId];
		expect(attempt.dispatch.requirementIds).toEqual([]);
		expect(task?.task.acceptanceCriterionIds).toEqual([]);
		expect(attempt.dispatch.resourcePointerIds).toEqual([]);
		expect(task?.task.dependsOn).toEqual([]);
	});

	it("binds an explicit new task that has no active goal to session scope, not the prior goal", () => {
		const h = specialistWithCompletedFirstTask("correlation-no-goal");

		// New work exists outside any goal. It must not be filed under the specialist's first goal.
		const turn: ProposedAgentTurnInput = {
			agentId: h.agentId,
			instructions: "ungoaled new work",
			taskContext: {},
		};
		const { attempt } = h.ledger.prepareAgentTurn(turn);

		const task = h.ledger.runtime.getSnapshot().tasks[attempt.taskId];
		expect(task?.task.objectiveId).toBe("session:correlation-no-goal");
		expect(task?.task.objectiveId).not.toBe(`goal:${h.priorGoalId}`);
		expect(task?.task.acceptanceCriterionIds).toEqual([]);
	});

	it("negative control: an explicit continuation keeps the prior task's correlation", () => {
		const h = specialistWithCompletedFirstTask("correlation-continuation");

		const { attempt } = h.ledger.prepareAgentTurn({
			agentId: h.agentId,
			instructions: "continue the same work",
		});

		const snapshot = h.ledger.runtime.getSnapshot();
		const task = snapshot.tasks[attempt.taskId];
		expect(task?.task.objectiveId).toBe(`goal:${h.priorGoalId}`);
		expect(attempt.dispatch.requirementIds).toEqual([h.priorRequirementId]);
		expect(task?.task.acceptanceCriterionIds).toEqual([h.priorRequirementId]);
		expect(attempt.dispatch.resourcePointerIds).toEqual([PRIOR_RESOURCE_ID]);
	});

	it("negative control: a replayed control message returns the same task without creating another", () => {
		const h = specialistWithCompletedFirstTask("correlation-replay");
		const controlMessageId = "control-message-1";

		const first = h.ledger.prepareAgentTurn({
			agentId: h.agentId,
			instructions: "idempotent task",
			controlMessageId,
		});
		const replay = h.ledger.prepareAgentTurn({
			agentId: h.agentId,
			instructions: "idempotent task",
			controlMessageId,
		});

		expect(first.created).toBe(true);
		expect(replay.created).toBe(false);
		expect(replay.attempt.attemptId).toBe(first.attempt.attemptId);
		expect(replay.attempt.taskId).toBe(first.attempt.taskId);
		// prerequisite + the specialist's first task + this one mailbox turn.
		expect(Object.keys(h.ledger.runtime.getSnapshot().tasks)).toHaveLength(3);
	});

	it("rejects a replayed receipt whose task correlation conflicts with the original", () => {
		const h = specialistWithCompletedFirstTask("correlation-conflict");
		const controlMessageId = "control-message-1";
		h.ledger.prepareAgentTurn({ agentId: h.agentId, instructions: "idempotent task", controlMessageId });
		const tasksBefore = Object.keys(h.ledger.runtime.getSnapshot().tasks).length;

		// Same instructions, different correlation: the receipt's identity must cover the task context
		// too, or a replay can quietly re-file the same work under a different goal.
		const conflicting: ProposedAgentTurnInput = {
			agentId: h.agentId,
			instructions: "idempotent task",
			controlMessageId,
			goal: goalFixture("goal-beta", "req-beta"),
			taskContext: { requirementIds: ["req-beta"], acceptanceCriterionIds: ["req-beta"] },
		};
		expect(() => h.ledger.prepareAgentTurn(conflicting)).toThrow(/conflicting/);

		expect(Object.keys(h.ledger.runtime.getSnapshot().tasks)).toHaveLength(tasksBefore);
	});
});
