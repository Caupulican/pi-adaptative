/**
 * A minimal control-plane seam: one registered specialist whose first task already settled, over a
 * real `WorkerLifecycle`, a real `WorkerAgentControlCoordinator` and the real durable
 * `WorkerAgentMailbox` file.
 *
 * Nothing here patches mailbox or ledger state. Messages are enqueued through the coordinator's own
 * public entrances and turns settle through the ledger, so what a case observes is the durable
 * effect production would leave behind.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerAgentMailbox } from "../../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerDelegationRequest } from "../../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import type { GoalState } from "../../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../../src/core/orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState } from "../../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../orchestration-profile-fixture.ts";

const LEASE_TTL_MS = 60_000;
export const SEAM_AGENT_ID = "worker-1";
export const SEAM_FIRST_GOAL_ID = "goal-seam-first";
export const SEAM_FIRST_REQUIREMENT_ID = "req-seam-first";

export interface WorkerControlSeam {
	agentDir: string;
	lifecycle: WorkerLifecycle;
	coordinator: WorkerAgentControlCoordinator;
	mailbox: WorkerAgentMailbox;
	/** Durable objective ids, sorted; a goal materialization shows up here. */
	objectiveIds(): string[];
	/** Durable per-turn task ids for this specialist, excluding its own lane task. */
	turnTaskIds(): string[];
}

export function goalFixture(goalId: string, requirementId: string): GoalState {
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

function resumeContext(): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `worker-${SEAM_AGENT_ID}`,
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

/**
 * The coordinator's real dependencies for the control path a case drives here: mailbox acceptance,
 * reconciliation and `prepareAgentTurn`. One documented cast keeps the controller's unrelated
 * execution surface out of the fixture; nothing on the control path is stubbed.
 */
function buildCoordinator(agentDir: string, sessionId: string, lifecycle: WorkerLifecycle) {
	return new WorkerAgentControlCoordinator({
		agentDir,
		parentSessionId: sessionId,
		processOwnerId: "batch9-control-seam-owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		recoveredRequest: (attempt: AttemptRuntimeState): WorkerDelegationRequest => ({
			instructions: attempt.dispatch.instructions,
			...(attempt.dispatch.profileId === undefined ? {} : { profileId: attempt.dispatch.profileId }),
		}),
		run: async () => ({ started: false, skipReason: "control_seam_does_not_execute" }),
		scheduler: { enqueue: () => true, track: () => {}, drain: () => {}, dropQueued: () => {} },
		statusChanged: () => {},
		abortLane: () => {},
		cancelLane: () => undefined,
	} as unknown as ConstructorParameters<typeof WorkerAgentControlCoordinator>[0]);
}

/** One idle specialist whose first task completed under its own goal. Caller owns removal. */
export function createWorkerControlSeam(sessionId: string): WorkerControlSeam {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-control-seam-"));
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
	const profile = profileFixture();
	const prepared = lifecycle.prepare(
		{
			instructions: "seam first task",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile),
					resourcePointers: [],
				},
			}),
			requiredCapabilities: [],
			goal: goalFixture(SEAM_FIRST_GOAL_ID, SEAM_FIRST_REQUIREMENT_ID),
			taskContext: {
				requirementIds: [SEAM_FIRST_REQUIREMENT_ID],
				acceptanceCriterionIds: [SEAM_FIRST_REQUIREMENT_ID],
				resourcePointerIds: [],
				dependsOnTaskIds: [],
			},
		},
		SEAM_AGENT_ID,
	);
	lifecycle.ensureAgent({ agentId: SEAM_AGENT_ID, role: profile.role, resumeContext: resumeContext() });
	const firstTaskId = prepared.attempt.taskId;
	const attemptId = lifecycle.getTaskRuntimeSnapshot().tasks[firstTaskId]?.attemptIds.at(-1);
	const task = lifecycle.getTask(firstTaskId);
	if (!attemptId || !task) throw new Error("the seam's own first turn has no durable attempt");
	lifecycle.bindGrant(
		attemptId,
		createTestExecutionGrant({ objectiveId: task.task.objectiveId, taskId: firstTaskId, attemptId }),
	);
	const handle = lifecycle.startAgent(firstTaskId, SEAM_AGENT_ID, LEASE_TTL_MS);
	lifecycle.finish(completedResult(handle, task.task.acceptanceCriterionIds), { notify: false });

	return {
		agentDir,
		lifecycle,
		coordinator: buildCoordinator(agentDir, sessionId, lifecycle),
		mailbox: new WorkerAgentMailbox({ agentDir, parentSessionId: sessionId, agentId: SEAM_AGENT_ID }),
		objectiveIds: () => Object.keys(lifecycle.getTaskRuntimeSnapshot().objectives).sort(),
		turnTaskIds: () =>
			Object.values(lifecycle.getTaskRuntimeSnapshot().attempts)
				.filter((attempt) => attempt.dispatch.logicalLaneId === SEAM_AGENT_ID && attempt.taskId !== SEAM_AGENT_ID)
				.map((attempt) => attempt.taskId)
				.sort(),
	};
}

export function removeWorkerControlSeam(seam: WorkerControlSeam): void {
	rmSync(seam.agentDir, { recursive: true, force: true });
}
