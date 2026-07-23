import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiResumeLaunchSpec } from "../src/core/orchestration/agent-resume.ts";
import {
	type ApprovalRequestContract,
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, DurableTaskRuntimeError } from "../src/core/orchestration/task-runtime.ts";
import { buildResumablePiAgentWakePrompt } from "../src/core/process-matrix/resume-launcher.ts";

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

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("DurableTaskRuntime", () => {
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
						metadata: { subjectTaskId: implementation.taskId },
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
		expect(() => harness.runtime.bindAttemptGrant(attempt.attemptId, "grant-before-owner")).toThrow(
			"awaiting approval",
		);

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
		reopened.bindAttemptGrant(attempt.attemptId, "grant-after-owner");
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
		harness.clock.ms += 2_000;
		harness.runtime.expireLeases();

		const interrupted = harness.runtime.getSnapshot();
		expect(interrupted.attempts[attempt.attemptId]?.status).toBe("suspended");
		expect(interrupted.agents[agent.agentId]).toMatchObject({
			status: "suspended",
			resumeContext: { sessionId: "pi-session-123", latestCheckpointId: checkpoint.checkpointId },
		});

		const resuming = harness.runtime.requestAgentResume(agent.agentId);
		const launch = buildPiResumeLaunchSpec(resuming, { parentPid: 1234, parentSessionId: "parent-session" });
		expect(launch).toEqual({
			executable: "pi",
			args: [
				"--session-dir",
				"/agent/sessions",
				"--session",
				"pi-session-123",
				"--parent-pid",
				"1234",
				"--parent-session",
				"parent-session",
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
				agentId: agent.agentId,
				taskSummary: "Inspect repository",
				resumeContext: {
					...resuming.resumeContext,
					contextPointers: [{ id: "artifact-1", kind: "artifact", uri: "artifact://inspection", readOnly: true }],
				},
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
