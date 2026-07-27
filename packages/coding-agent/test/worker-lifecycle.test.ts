import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-lifecycle-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function resultFor(
	handle: StartedDelegationAttempt,
	overrides: Partial<
		Pick<WorkerResultContract, "status" | "reasonCode" | "summary" | "artifacts" | "evidence" | "nextAction">
	> = {},
): WorkerResultContract {
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
		summary: "done",
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { wallClockMs: 10, toolCalls: 1 },
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function startWithGrant(lifecycle: WorkerLifecycle, laneId: string, leaseTtlMs: number): StartedDelegationAttempt {
	const attempt = lifecycle.getActiveAttempt(laneId);
	if (!attempt) throw new Error(`Expected active attempt for ${laneId}`);
	const task = lifecycle.getTask(attempt.taskId);
	if (!task) throw new Error(`Expected durable task for ${laneId}`);
	lifecycle.bindGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			role: task.task.role,
		}),
	);
	return lifecycle.start(laneId, leaseTtlMs);
}

function executionContract(profile: OrchestrationProfile) {
	const authority = createTestWorkerExecutionAuthority(profile);
	if (!profile.requireIndependentVerification || !profile.verificationProfileId) {
		return createWorkerExecutionContract({
			worker: { profile, modelBinding: profile.modelPolicy.candidates[0]!, authority },
		});
	}
	const { verificationProfileId: _verificationProfileId, ...verifierBase } = profile;
	const verifier: OrchestrationProfile = {
		...verifierBase,
		profileId: profile.verificationProfileId,
		description: "Pinned verifier",
		role: "verifier",
		requireIndependentVerification: false,
	};
	return createWorkerExecutionContract({
		worker: { profile, modelBinding: profile.modelPolicy.candidates[0]!, authority },
		verifier: {
			profile: verifier,
			modelBinding: verifier.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(verifier),
		},
	});
}

function finishAwaitingVerification(
	lifecycle: WorkerLifecycle,
	overrides: Partial<Pick<WorkerResultContract, "reasonCode" | "summary" | "artifacts" | "evidence">> = {},
): { profile: ReturnType<typeof createTestWorkerOrchestrationProfile>; laneId: string } {
	const profile = createTestWorkerOrchestrationProfile({
		profileId: "implementation",
		model: { provider: "test", id: "model" },
		requireIndependentVerification: true,
		verificationProfileId: "verifier",
	});
	const prepared = lifecycle.prepare({
		instructions: "implement",
		executionContract: executionContract(profile),
		requiredCapabilities: [],
	});
	const handle = startWithGrant(lifecycle, prepared.record.laneId, profile.leaseTtlMs);
	lifecycle.finish(
		resultFor(handle, {
			status: "partial",
			reasonCode: "independent_verification_required",
			nextAction: "independent_verification_required",
			...overrides,
		}),
		{ notify: false },
	);
	return { profile, laneId: prepared.record.laneId };
}

describe("WorkerLifecycle", () => {
	it("registers, checkpoints, suspends, and resumes the same bound agent attempt", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-bound-agent" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "explorer",
			model: { provider: "test", id: "model" },
			role: "explorer",
		});
		const resumeContext: AgentResumeContext = {
			provider: "pi",
			sessionId: "worker-session-1",
			cwd: "/repo/worktrees/explorer",
			resourceProfileNames: ["worker-explorer"],
			contextPointers: [],
		};
		const agent = lifecycle.ensureAgent({ agentId: "agent-explorer-1", role: "explorer", resumeContext });
		expect(lifecycle.ensureAgent({ agentId: agent.agentId, role: "explorer", resumeContext })).toEqual(agent);
		expect(() =>
			lifecycle.ensureAgent({
				agentId: agent.agentId,
				role: "implementer",
				resumeContext,
			}),
		).toThrow("conflicting identity");
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			executionContract: executionContract(profile),
			requiredCapabilities: [],
		});
		const task = lifecycle.getTask(prepared.attempt.taskId);
		if (!task) throw new Error("Expected durable task");
		lifecycle.bindGrant(
			prepared.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: task.task.taskId,
				attemptId: prepared.attempt.attemptId,
				role: "explorer",
			}),
		);
		const first = lifecycle.startAgent(prepared.record.laneId, agent.agentId, profile.leaseTtlMs);
		const checkpoint = lifecycle.checkpoint(prepared.record.laneId, { summary: "Repository inspected" });
		expect(lifecycle.getTaskRuntimeSnapshot()).toMatchObject({
			attempts: { [first.attemptId]: { agentId: agent.agentId, checkpointIds: [checkpoint.checkpointId] } },
			agents: { [agent.agentId]: { resumeContext: { latestCheckpointId: checkpoint.checkpointId } } },
		});
		expect(
			lifecycle.ensureAgent({ agentId: agent.agentId, role: "explorer", resumeContext }).resumeContext
				.latestCheckpointId,
		).toBe(checkpoint.checkpointId);

		expect(lifecycle.suspendBoundInProcessAttemptsForRestart(agent.agentId)).toEqual([first.attemptId]);
		expect(lifecycle.suspendBoundInProcessAttemptsForRestart(agent.agentId)).toEqual([]);
		const resumed = lifecycle.resumeAgent(prepared.record.laneId, agent.agentId, profile.leaseTtlMs);
		expect(resumed).toMatchObject({ attemptId: first.attemptId, fencingToken: first.fencingToken + 1 });
		expect(lifecycle.getActiveAttempt(prepared.record.laneId)).toMatchObject({
			attemptId: first.attemptId,
			agentId: agent.agentId,
			status: "running",
			lease: { fencingToken: resumed.fencingToken },
		});
	});

	it("refuses recovery that would steal a still-live agent owner", () => {
		const lifecycle = new WorkerLifecycle({
			agentDir: root(),
			sessionId: "session-live-agent-owner",
			isProcessAlive: () => true,
		});
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "explorer",
			model: { provider: "test", id: "model" },
			role: "explorer",
		});
		const agent = lifecycle.ensureAgent({
			agentId: "agent-live-owner",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "worker-live-owner",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			executionContract: executionContract(profile),
			requiredCapabilities: [],
		});
		const task = lifecycle.getTask(prepared.record.laneId);
		if (!task) throw new Error("Expected task");
		lifecycle.bindGrant(
			prepared.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: prepared.attempt.taskId,
				attemptId: prepared.attempt.attemptId,
				role: "explorer",
			}),
		);
		lifecycle.startAgent(
			prepared.record.laneId,
			agent.agentId,
			profile.leaseTtlMs,
			"pi-worker:123:11111111-1111-4111-8111-111111111111",
		);

		expect(lifecycle.suspendBoundInProcessAttemptsForRestart()).toEqual([]);
		expect(lifecycle.getActiveAttempt(prepared.record.laneId)).toMatchObject({ status: "running" });
	});

	it("requires an exact owner and current fence before an explicit restart suspension", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-exact-suspension" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "explorer",
			model: { provider: "test", id: "model" },
			role: "explorer",
		});
		const agent = lifecycle.ensureAgent({
			agentId: "agent-exact-suspension",
			role: "explorer",
			resumeContext: {
				provider: "pi",
				sessionId: "worker-exact-suspension",
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			executionContract: executionContract(profile),
			requiredCapabilities: [],
		});
		const task = lifecycle.getTask(prepared.record.laneId);
		if (!task) throw new Error("Expected task");
		lifecycle.bindGrant(
			prepared.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: prepared.attempt.taskId,
				attemptId: prepared.attempt.attemptId,
				role: "explorer",
			}),
		);
		const handle = lifecycle.startAgent(
			prepared.record.laneId,
			agent.agentId,
			profile.leaseTtlMs,
			"pi-worker:55:11111111-1111-4111-8111-111111111111",
		);

		expect(() =>
			lifecycle.suspendBoundAttempt({
				laneId: prepared.record.laneId,
				ownerId: "pi-worker:55:other",
				leaseId: handle.leaseId,
				fencingToken: handle.fencingToken,
				reasonCode: "owner_exit",
			}),
		).toThrow("not owned");
		expect(() =>
			lifecycle.suspendBoundAttempt({
				laneId: prepared.record.laneId,
				ownerId: "pi-worker:55:11111111-1111-4111-8111-111111111111",
				leaseId: handle.leaseId,
				fencingToken: handle.fencingToken + 1,
				reasonCode: "owner_exit",
			}),
		).toThrow("lease or fencing token is stale");
		expect(lifecycle.getActiveAttempt(prepared.record.laneId)).toMatchObject({ status: "running" });
	});

	it("creates a distinct durable task and attempt for a logical agent follow-up", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-agent-followup" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "explorer",
			model: { provider: "test", id: "model" },
			role: "explorer",
		});
		const resumeContext: AgentResumeContext = {
			provider: "pi",
			sessionId: "worker-session-followup",
			cwd: "/repo",
			resourceProfileNames: ["worker-explorer"],
			contextPointers: [],
		};
		const agent = lifecycle.ensureAgent({ agentId: "agent-explorer-followup", role: "explorer", resumeContext });
		const first = lifecycle.prepare({
			instructions: "Inspect the repository.",
			executionContract: executionContract(profile),
			requiredCapabilities: ["filesystem.read"],
		});
		const firstTask = lifecycle.getTask(first.record.laneId);
		if (!firstTask) throw new Error("Expected first task");
		lifecycle.bindGrant(
			first.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: firstTask.task.objectiveId,
				taskId: first.attempt.taskId,
				attemptId: first.attempt.attemptId,
				role: "explorer",
			}),
		);
		const firstHandle = lifecycle.startAgent(first.record.laneId, agent.agentId, profile.leaseTtlMs);
		lifecycle.finish(resultFor(firstHandle));

		const followUp = lifecycle.prepareAgentTurn({
			agentId: agent.agentId,
			instructions: "Now inspect the focused tests.",
		});

		expect(followUp.record.laneId).toBe(`${agent.agentId}:turn:2`);
		expect(followUp.attempt).toMatchObject({
			taskId: `${agent.agentId}:turn:2`,
			status: "queued",
			dispatch: {
				logicalLaneId: agent.agentId,
				dispatchSequence: 2,
				profileId: "explorer",
				instructions: "Now inspect the focused tests.",
			},
		});
	});

	it("uses the same durable lifecycle and terminal outbox for managed-process workers", () => {
		const agentDir = root();
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-managed" });
		const prepared = lifecycle.prepareManaged({
			laneId: "tmux:job:worker",
			dispatchSequence: 1,
			instructions: "inspect externally",
			profileId: "tmux:pi",
			provider: "pi",
			authorizationId: "grant-managed",
			role: "implementer",
			riskBudget: { maxAttempts: 1, maxWallClockMs: 60_000 },
			leaseTtlMs: 60_000,
			compileGrant: createTestExecutionGrant,
		});
		expect(prepared.record).toMatchObject({ laneId: "tmux:job:worker", type: "tmux-worker", status: "running" });
		lifecycle.finish(resultFor(prepared.handle));

		const resumed = new WorkerLifecycle({ agentDir, sessionId: "session-managed" });
		expect(resumed.getManagedRecord("tmux:job:worker")).toMatchObject({ status: "succeeded" });
		const [notification] = resumed.getPendingTerminalNotifications();
		expect(notification).toMatchObject({ record: { laneId: "tmux:job:worker", type: "tmux-worker" } });
		if (!notification) throw new Error("Expected managed terminal notification");
		resumed.markNotificationsDelivered([notification.notificationId]);
		expect(new WorkerLifecycle({ agentDir, sessionId: "session-managed" }).getPendingTerminalNotifications()).toEqual(
			[],
		);
	});

	it("keeps managed follow-up turns distinct while projecting one logical lane", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-managed-followup" });
		const first = lifecycle.prepareManaged({
			laneId: "tmux:followup:worker",
			dispatchSequence: 1,
			instructions: "first turn",
			profileId: "tmux:pi",
			provider: "pi",
			authorizationId: "grant-1",
			role: "implementer",
			riskBudget: { maxAttempts: 1 },
			leaseTtlMs: 60_000,
			compileGrant: createTestExecutionGrant,
		});
		lifecycle.finish(resultFor(first.handle));
		const second = lifecycle.prepareManaged({
			laneId: "tmux:followup:worker",
			dispatchSequence: 2,
			instructions: "second turn",
			profileId: "tmux:pi",
			provider: "pi",
			authorizationId: "grant-2",
			role: "implementer",
			riskBudget: { maxAttempts: 1 },
			leaseTtlMs: 60_000,
			compileGrant: createTestExecutionGrant,
		});

		expect(second.record).toMatchObject({ laneId: "tmux:followup:worker", status: "running" });
		expect(lifecycle.getManagedRecords()).toHaveLength(1);
		expect(Object.keys(lifecycle.getTaskRuntimeSnapshot().tasks)).toEqual([
			"tmux:followup:worker:turn:1",
			"tmux:followup:worker:turn:2",
		]);
	});

	it("does not replay a managed process as an in-process completion after restart", () => {
		const agentDir = root();
		new WorkerLifecycle({ agentDir, sessionId: "session-managed-recovery" }).prepareManaged({
			laneId: "tmux:recovery:worker",
			dispatchSequence: 1,
			instructions: "remain externally supervised",
			profileId: "tmux:pi",
			provider: "pi",
			authorizationId: "grant-managed",
			role: "implementer",
			riskBudget: { maxAttempts: 1 },
			leaseTtlMs: 60_000,
			compileGrant: createTestExecutionGrant,
		});
		const resumed = new WorkerLifecycle({ agentDir, sessionId: "session-managed-recovery" });

		expect(resumed.recoverQueued()).toEqual([]);
		expect(resumed.getManagedRecord("tmux:recovery:worker")).toMatchObject({ status: "running" });
	});

	it("persists terminal notifications until the parent acknowledges delivery", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "worker",
			model: { provider: "test", id: "model", maxTokens: 8_192 },
		});
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-1" });
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			executionContract: executionContract(profile),
			requiredCapabilities: ["filesystem.read"],
		});
		const handle = startWithGrant(lifecycle, prepared.record.laneId, profile.leaseTtlMs);
		expect(lifecycle.finish(resultFor(handle))).toMatchObject({
			status: "succeeded",
			reasonCode: "worker_completed",
		});

		const resumed = new WorkerLifecycle({ agentDir, sessionId: "session-1" });
		const [notification] = resumed.getPendingTerminalNotifications();
		expect(notification).toMatchObject({ record: { laneId: prepared.record.laneId, status: "succeeded" } });
		if (!notification) throw new Error("Expected pending notification");
		resumed.markNotificationsDelivered([notification.notificationId]);

		const reopened = new WorkerLifecycle({ agentDir, sessionId: "session-1" });
		expect(reopened.getPendingTerminalNotifications()).toEqual([]);
	});

	it("preserves cancellation reasons in the canonical projection", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "worker",
			model: { provider: "test", id: "model" },
		});
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-2" });
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			executionContract: executionContract(profile),
			requiredCapabilities: [],
		});

		expect(lifecycle.cancel(prepared.record.laneId, "session_disposed")).toMatchObject({
			status: "canceled",
			reasonCode: "session_disposed",
		});
	});

	it("synchronizes goal pause, resume, and cancellation into durable worker state", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "worker",
			model: { provider: "test", id: "model" },
		});
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-goal-state" });
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "req-1", text: "Finish", now: "T1" });
		const prepared = lifecycle.prepare({
			instructions: "work",
			executionContract: executionContract(profile),
			requiredCapabilities: [],
			goal,
		});

		goal = applyGoalEvent(goal, { type: "block_goal", reason: "owner pause", now: "T2" });
		expect(lifecycle.synchronizeGoalState(goal)).toEqual([]);
		expect(lifecycle.getTaskRuntimeSnapshot().objectives["goal:g1"]?.objective.status).toBe("paused");

		goal = applyGoalEvent(goal, { type: "resume_goal", now: "T3" });
		lifecycle.synchronizeGoalState(goal);
		expect(lifecycle.getTaskRuntimeSnapshot().objectives["goal:g1"]?.objective.status).toBe("active");

		goal = applyGoalEvent(goal, { type: "cancel_goal", now: "T4" });
		expect(lifecycle.synchronizeGoalState(goal)).toMatchObject([
			{ laneId: prepared.record.laneId, status: "canceled", reasonCode: "objective_cancelled" },
		]);

		const reopened = new WorkerLifecycle({ agentDir, sessionId: "session-goal-state" });
		expect(reopened.getRecord(prepared.record.laneId)).toMatchObject({
			status: "canceled",
			reasonCode: "objective_cancelled",
		});
	});

	it("allocates resumed lane ids from current durable tasks", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "worker",
			model: { provider: "test", id: "model" },
		});
		const before = new WorkerLifecycle({ agentDir, sessionId: "session-resumed-id" });
		const resumed = new WorkerLifecycle({ agentDir, sessionId: "session-resumed-id" });
		expect(
			before.prepare({
				instructions: "first",
				executionContract: executionContract(profile),
				requiredCapabilities: [],
			}).record.laneId,
		).toBe("worker-1");

		expect(
			resumed.prepare({
				instructions: "second",
				executionContract: executionContract(profile),
				requiredCapabilities: [],
			}).record.laneId,
		).toBe("worker-2");
	});

	it("recovers a missing verifier dispatch after implementation completion", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-verification-dispatch" });
		const implementation = finishAwaitingVerification(lifecycle, {
			summary: "implementation persisted",
			artifacts: [
				{
					artifactId: "artifact-1",
					kind: "file",
					uri: "file:///repo/output.ts",
					createdAt: new Date().toISOString(),
				},
			],
		});

		expect(lifecycle.getPendingVerificationRecoveries()).toMatchObject([
			{
				action: "dispatch",
				subjectTaskId: implementation.laneId,
				implementationProfileId: "implementation",
				summary: "implementation persisted",
				artifactUris: ["file:///repo/output.ts"],
				verifierExecutionContract: {
					worker: { profile: { profileId: "verifier", role: "verifier" } },
				},
			},
		]);
	});

	it("recovers reconciliation after a verifier result was persisted", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-verification-reconcile" });
		const implementation = finishAwaitingVerification(lifecycle);
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "verifier",
			model: { provider: "test", id: "model" },
			role: "verifier",
		});
		const verifier = lifecycle.prepare({
			instructions: "verify",
			executionContract: executionContract(verifierProfile),
			requiredCapabilities: [],
			verificationOfTaskId: implementation.laneId,
		});
		const verifierHandle = startWithGrant(lifecycle, verifier.record.laneId, verifierProfile.leaseTtlMs);
		lifecycle.finish(
			resultFor(verifierHandle, {
				reasonCode: "verification_rejected",
				evidence: [
					{
						evidenceId: "independent-review",
						kind: "review",
						summary: "focused checks failed",
						artifactIds: [],
						trusted: true,
						createdAt: new Date().toISOString(),
						metadata: {
							subjectTaskId: implementation.laneId,
							verdict: "rejected",
							reasonCodes: ["focused_checks_failed"],
						},
					},
				],
			}),
		);

		const [recovery] = lifecycle.getPendingVerificationRecoveries();
		expect(recovery).toMatchObject({
			action: "reconcile",
			subjectTaskId: implementation.laneId,
			verifierTaskId: verifier.record.laneId,
			verdict: "rejected",
			reasonCode: "independent_verification_rejected:focused_checks_failed",
		});
		if (!recovery || recovery.action !== "reconcile") throw new Error("Expected reconciliation recovery");
		expect(lifecycle.reconcileVerification(recovery)).toMatchObject({
			status: "failed",
			reasonCode: "independent_verification_rejected:focused_checks_failed",
		});
	});

	it("reconciles a terminal verifier without a result as inconclusive", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-verification-inconclusive" });
		const implementation = finishAwaitingVerification(lifecycle);
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "verifier",
			model: { provider: "test", id: "model" },
			role: "verifier",
		});
		const verifier = lifecycle.prepare({
			instructions: "verify",
			executionContract: executionContract(verifierProfile),
			requiredCapabilities: [],
			verificationOfTaskId: implementation.laneId,
		});
		lifecycle.cancel(verifier.record.laneId, "session_disposed");

		const [recovery] = lifecycle.getPendingVerificationRecoveries();
		expect(recovery).toMatchObject({
			action: "reconcile",
			verdict: "inconclusive",
			reasonCode: "independent_verification_inconclusive:session_disposed",
		});
		if (!recovery || recovery.action !== "reconcile") throw new Error("Expected inconclusive recovery");
		expect(lifecycle.reconcileVerification(recovery)).toMatchObject({
			status: "failed",
			reasonCode: "independent_verification_inconclusive:session_disposed",
		});
	});
});
