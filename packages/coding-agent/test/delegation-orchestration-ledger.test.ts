import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import type { GoalObjectiveProjection } from "../src/core/orchestration/work-state-projection.ts";
import { adaptWorkerResult } from "../src/core/orchestration/worker-result-adapter.ts";

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

function goal(acceptanceCriteria: GoalObjectiveProjection["acceptanceCriteria"]): GoalObjectiveProjection {
	return {
		objectiveId: "goal:g1",
		title: "Goal g1",
		description: "Ship safely",
		constraints: [],
		acceptanceCriteria,
		riskBudget: {},
	};
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
			profile: profile(),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		first.runtime.bindAttemptGrant(queued.attemptId, "grant-session-1");
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
			},
		});
		expect(recovered[0]?.attemptId).not.toBe(handle.attemptId);
		expect(() =>
			first.runtime.finishAttempt(
				adaptWorkerResult({
					handle,
					result: {
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
			profile: profile(),
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
			profile: limitedProfile,
			requiredCapabilities: ["filesystem.read"],
		});
		first.runtime.bindAttemptGrant(queued.attemptId, "grant-limited");
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
			profile: profile(),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		ledger.runtime.bindAttemptGrant(queued.attemptId, "grant-session-3");
		const handle = ledger.start(queued.attemptId, 60_000);
		const result = adaptWorkerResult({
			handle,
			result: {
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
			profile: profile(),
			requiredCapabilities: ["filesystem.read"],
			goal: firstGoal,
		});
		const firstOrdinal = ledger.runtime.getSnapshot().lastOrdinal;
		ledger.runtime.ensureObjective(firstGoal);
		expect(ledger.runtime.getSnapshot().lastOrdinal).toBe(firstOrdinal);

		const expandedGoal = goal([
			{ id: "req-1", description: "Pass focused tests", required: true },
			{ id: "req-2", description: "Record evidence", required: true },
		]);
		ledger.prepare({
			laneId: "worker-2",
			instructions: "Verify metadata",
			profile: profile(),
			requiredCapabilities: ["filesystem.read"],
			goal: expandedGoal,
		});

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-goal" });
		expect(reopened.runtime.getSnapshot().objectives["goal:g1"]?.objective.acceptanceCriteria).toEqual(
			expandedGoal.acceptanceCriteria,
		);
		expect(reopened.runtime.getSnapshot().tasks["worker-1"]?.task.acceptanceCriterionIds).toEqual([]);
	});

	it("refuses to remove an acceptance criterion already referenced by a task", () => {
		const ledger = new DelegationOrchestrationLedger({ agentDir: root(), sessionId: "session-criteria" });
		ledger.runtime.createObjective(goal([{ id: "req-1", description: "Required proof", required: true }]));
		ledger.runtime.createTask({
			taskId: "proof-task",
			objectiveId: "goal:g1",
			title: "Prove criterion",
			description: "Run the trusted evaluator",
			role: "verifier",
			acceptanceCriterionIds: ["req-1"],
		});
		expect(() => ledger.runtime.ensureObjective(goal([]))).toThrow(
			"Cannot remove acceptance criteria referenced by tasks: req-1",
		);
	});
});
