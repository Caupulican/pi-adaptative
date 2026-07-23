import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiResumeLaunchSpec } from "../src/core/orchestration/agent-resume.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, DurableTaskRuntimeError } from "../src/core/orchestration/task-runtime.ts";

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
		summary: "worker finished",
		artifacts: [],
		evidence: [],
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
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
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
		const attempt = harness.runtime.queueAttempt(task.taskId, dispatch(task.taskId));
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
			env: { PI_SESSION_ROLE: "worker" },
		});

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
