import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import { projectGoalObjective } from "../src/core/orchestration/work-state-projection.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import { createWorkerResultContract } from "../src/core/orchestration/worker-result-adapter.ts";
import { createTestExecutionGrant, createTestWorkerExecutionAuthority } from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-delegation-ledger-"));
	roots.push(directory);
	return directory;
}

function profile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "implementer-fast",
		description: "Pinned implementer",
		role: "implementer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "test", modelId: "fast", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "filesystem.write", "worktree.read", "worktree.mutate"],
		toolNames: ["read", "write", "edit"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxAttempts: 3, maxWallClockMs: 30_000, maxToolCalls: 6 },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: true,
		verificationProfileId: "verifier-fast",
		createdAt: now,
		updatedAt: now,
	};
}

function executionContract(worker: OrchestrationProfile) {
	const { verificationProfileId: _verificationProfileId, ...verifierBase } = worker;
	const verifier: OrchestrationProfile = {
		...verifierBase,
		profileId: "verifier-fast",
		description: "Pinned verifier",
		role: "verifier",
		capabilityCeiling: ["filesystem.read", "worktree.read"],
		toolNames: ["read"],
		requireIndependentVerification: false,
	};
	return createWorkerExecutionContract({
		worker: {
			profile: worker,
			modelBinding: worker.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(worker),
		},
		verifier: {
			profile: verifier,
			modelBinding: verifier.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(verifier),
		},
	});
}

function goal(acceptanceCriteria: readonly { id: string; description: string; required: boolean }[]): GoalState {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship safely", now: "2026-07-23T00:00:00.000Z" });
	for (const [index, criterion] of acceptanceCriteria.entries()) {
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: criterion.id,
			text: criterion.description,
			now: `2026-07-23T00:00:0${index + 1}.000Z`,
		});
	}
	return state;
}

function bindTestGrant(ledger: DelegationOrchestrationLedger, attemptId: string, grantId: string): void {
	const snapshot = ledger.runtime.getSnapshot();
	const attempt = snapshot.attempts[attemptId];
	const task = attempt ? snapshot.tasks[attempt.taskId] : undefined;
	if (!attempt || !task) throw new Error(`Missing test attempt ${attemptId}`);
	ledger.runtime.bindAttemptGrant(
		attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId,
			role: task.task.role,
			grantId,
		}),
	);
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DelegationOrchestrationLedger", () => {
	it("persists dispatch before execution and requeues interrupted isolated work with a fresh fenced attempt", () => {
		const agentDir = root();
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-1" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "Implement the bounded change",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		bindTestGrant(first, queued.attemptId, "grant-session-1");
		const handle = first.start(queued.attemptId, 60_000);

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-1" });
		const recovered = reopened.recoverQueuedDispatches();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			taskId: "worker-1",
			status: "queued",
			dispatch: {
				profileId: "implementer-fast",
				instructions: "Implement the bounded change",
				executionContract: {
					worker: {
						profile: { profileId: "implementer-fast" },
						modelBinding: { provider: "test", modelId: "fast", thinkingLevel: "off" },
					},
					verifier: { profile: { profileId: "verifier-fast", role: "verifier" } },
				},
			},
		});
		expect(recovered[0]?.attemptId).not.toBe(handle.attemptId);
		expect(() =>
			first.runtime.finishAttempt(
				createWorkerResultContract({
					handle,
					claim: {
						requestId: "worker-1",
						status: "completed",
						summary: "stale completion",
						changedFiles: [],
					},
					accepted: true,
					costUsd: 0,
					cwd: agentDir,
					wallClockMs: 1,
					toolCalls: 0,
				}),
			),
		).toThrow("cannot finish from 'expired'");
	});

	it("replays an already queued dispatch without duplicating its attempt", () => {
		const agentDir = root();
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-2" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "Inspect",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read"],
		});
		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-2" });
		const recovered = reopened.recoverQueuedDispatches();
		expect(recovered.map((attempt) => attempt.attemptId)).toEqual([queued.attemptId]);
	});

	it("fails an interrupted task instead of requeueing past its profile attempt budget", () => {
		const agentDir = root();
		const limitedProfile = profile();
		limitedProfile.budget = { ...limitedProfile.budget, maxAttempts: 1 };
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-limited" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "One attempt only",
			executionContract: executionContract(limitedProfile),
			requiredCapabilities: ["filesystem.read"],
		});
		bindTestGrant(first, queued.attemptId, "grant-limited");
		first.start(queued.attemptId, 60_000);

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-limited" });
		expect(reopened.recoverQueuedDispatches()).toEqual([]);
		expect(reopened.runtime.getSnapshot().tasks["worker-1"]?.task.status).toBe("failed");
	});

	it("keeps an independently verified profile result non-terminal until verification", () => {
		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-3" });
		const queued = ledger.prepare({
			laneId: "worker-1",
			instructions: "Change one file",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		bindTestGrant(ledger, queued.attemptId, "grant-session-3");
		const handle = ledger.start(queued.attemptId, 60_000);
		const result = createWorkerResultContract({
			handle,
			claim: {
				requestId: "worker-1",
				status: "completed",
				summary: "implemented",
				changedFiles: ["result.ts"],
			},
			accepted: true,
			costUsd: 0.01,
			cwd: agentDir,
			wallClockMs: 20,
			toolCalls: 2,
			verificationRequired: true,
		});
		ledger.runtime.finishAttempt(result);

		expect(result).toMatchObject({ status: "partial", nextAction: "independent_verification_required" });
		expect(ledger.runtime.getSnapshot().tasks["worker-1"]?.task.status).toBe("blocked");
	});

	it("synchronizes goal acceptance criteria before dispatch and preserves them across reopen", () => {
		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-goal" });
		const firstGoal = goal([{ id: "req-1", description: "Pass focused tests", required: true }]);
		ledger.prepare({
			laneId: "worker-1",
			instructions: "Implement",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read"],
			goal: firstGoal,
		});
		const firstOrdinal = ledger.runtime.getSnapshot().lastOrdinal;
		ledger.runtime.ensureObjective(projectGoalObjective(firstGoal));
		expect(ledger.runtime.getSnapshot().lastOrdinal).toBe(firstOrdinal);

		const expandedGoal = goal([
			{ id: "req-1", description: "Pass focused tests", required: true },
			{ id: "req-2", description: "Record evidence", required: true },
		]);
		ledger.prepare({
			laneId: "worker-2",
			instructions: "Verify metadata",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read"],
			goal: expandedGoal,
		});

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-goal" });
		expect(reopened.runtime.getSnapshot().objectives["goal:g1"]?.objective.acceptanceCriteria).toEqual(
			projectGoalObjective(expandedGoal).acceptanceCriteria,
		);
		expect(reopened.runtime.getSnapshot().tasks["worker-1"]?.task.acceptanceCriterionIds).toEqual([]);
	});

	it("persists runtime-owned task context on the task and durable dispatch", () => {
		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-task-context" });
		const state = goal([
			{ id: "req-1", description: "Implement the change", required: true },
			{ id: "req-2", description: "Run focused checks", required: true },
		]);
		const prerequisite = ledger.prepare({
			laneId: "worker-prerequisite",
			instructions: "Inspect the repository",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read"],
			goal: state,
		});
		bindTestGrant(ledger, prerequisite.attemptId, "grant-prerequisite");
		const prerequisiteHandle = ledger.start(prerequisite.attemptId, 60_000);
		ledger.runtime.finishAttempt(
			createWorkerResultContract({
				handle: prerequisiteHandle,
				claim: {
					requestId: "worker-prerequisite",
					status: "completed",
					summary: "inspected",
					changedFiles: [],
				},
				accepted: true,
				costUsd: 0,
				cwd: agentDir,
				wallClockMs: 1,
				toolCalls: 0,
			}),
		);

		ledger.prepare({
			laneId: "worker-implementation",
			instructions: "Implement the requirement",
			executionContract: executionContract(profile()),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
			goal: state,
			taskContext: {
				requirementIds: ["req-1"],
				dependsOnTaskIds: ["worker-prerequisite"],
				acceptanceCriterionIds: ["req-1", "req-2"],
				resourcePointerIds: ["repository:pi", "artifact:plan"],
			},
		});

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-task-context" });
		const task = reopened.runtime.getSnapshot().tasks["worker-implementation"];
		const attempt = task?.attemptIds.map((attemptId) => reopened.runtime.getSnapshot().attempts[attemptId])[0];
		expect(task?.task).toMatchObject({
			dependsOn: ["worker-prerequisite"],
			acceptanceCriterionIds: ["req-1", "req-2"],
		});
		expect(attempt?.dispatch).toMatchObject({
			requirementIds: ["req-1"],
			resourcePointerIds: ["repository:pi", "artifact:plan"],
		});
	});

	it("refuses to remove an acceptance criterion already referenced by a task", () => {
		const ledger = new DelegationOrchestrationLedger({ agentDir: root(), sessionId: "session-criteria" });
		ledger.runtime.createObjective(
			projectGoalObjective(goal([{ id: "req-1", description: "Required proof", required: true }])),
		);
		ledger.runtime.createTask({
			taskId: "proof-task",
			objectiveId: "goal:g1",
			title: "Prove criterion",
			description: "Run the trusted evaluator",
			role: "verifier",
			acceptanceCriterionIds: ["req-1"],
		});
		expect(() => ledger.runtime.ensureObjective(projectGoalObjective(goal([])))).toThrow(
			"Cannot remove acceptance criteria referenced by tasks: req-1",
		);
	});
});
