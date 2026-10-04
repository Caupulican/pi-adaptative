import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
} from "../src/core/delegation/session-worker-claim.ts";
import { projectWorkerAttemptLaneRecord } from "../src/core/delegation/worker-lane-projection.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../src/core/orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { tempDir } from "./temp-dir.ts";

/**
 * A task's independent verification reconciles the generation that asked for it. An earlier
 * generation of the same task keeps its own outcome: a failed attempt never reads as the accepted
 * success of a later attempt, in its lane record or in its terminal notification, and both survive a
 * restart with their own identity.
 */

const SESSION = "session-generation-verification";

function lifecycleAt(agentDir: string): WorkerLifecycle {
	return new WorkerLifecycle({ agentDir, sessionId: SESSION });
}

function runAttempt(
	runtime: DurableTaskRuntime,
	objectiveId: string,
	taskId: string,
	result: Pick<WorkerResultContract, "status" | "reasonCode"> &
		Partial<Pick<WorkerResultContract, "evidence" | "nextAction">>,
): string {
	const attempt = runtime.queueAttempt(
		taskId,
		{ taskId, profileId: "worker-default", instructions: `Run ${taskId}`, resourcePointerIds: [] },
		`grant-${taskId}-${runtime.getSnapshot().tasks[taskId]?.attemptIds.length ?? 0}`,
	);
	const lease = runtime.leaseAttempt(attempt.attemptId, `owner-${attempt.attemptId}`, 60_000);
	runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
	runtime.finishAttempt({
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${attempt.attemptId}`,
		objectiveId,
		taskId,
		attemptId: attempt.attemptId,
		leaseId: lease.leaseId,
		fencingToken: lease.fencingToken,
		summary: `${taskId} finished`,
		artifacts: [],
		evidence: result.evidence ?? [],
		errors: [],
		usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
		createdAt: new Date().toISOString(),
		status: result.status,
		reasonCode: result.reasonCode,
		...(result.nextAction ? { nextAction: result.nextAction } : {}),
	});
	return attempt.attemptId;
}

/** Attempt A fails; attempt B of the same task asks for verification; the verifier accepts B. */
function failedThenVerified(agentDir: string) {
	const lifecycle = lifecycleAt(agentDir);
	const runtime = lifecycle.ledger.runtime;
	const objective = runtime.createObjective({ objectiveId: "objective", title: "Objective", description: "Work" });
	const task = runtime.createTask({
		taskId: "task",
		objectiveId: objective.objectiveId,
		title: "Task",
		description: "Implement",
		role: "implementer",
	});
	const failed = runAttempt(runtime, objective.objectiveId, task.taskId, {
		status: "failed",
		reasonCode: "worker_failed",
	});
	const verified = runAttempt(runtime, objective.objectiveId, task.taskId, {
		status: "partial",
		reasonCode: "worker_partial",
		nextAction: "independent_verification_required",
	});
	const verifierTask = runtime.createTask({
		taskId: "verifier",
		objectiveId: objective.objectiveId,
		title: "Verifier",
		description: "Verify",
		role: "verifier",
		verificationOfTaskId: task.taskId,
	});
	const verifierAttempt = runAttempt(runtime, objective.objectiveId, verifierTask.taskId, {
		status: "completed",
		reasonCode: "verifier_completed",
		evidence: [
			{
				evidenceId: "review",
				kind: "review",
				summary: "Accepted",
				artifactIds: [],
				trusted: true,
				metadata: { subjectTaskId: task.taskId, verdict: "accepted" },
				createdAt: new Date().toISOString(),
			},
		],
	});
	runtime.finishVerification({
		taskId: task.taskId,
		verifierTaskId: verifierTask.taskId,
		verifierAttemptId: verifierAttempt,
		verdict: "accepted",
		reasonCode: "verification_accepted",
	});
	return { lifecycle, failed, verified };
}

describe("a task's verification belongs to the generation it reconciled", () => {
	it("an earlier failed generation keeps its own outcome; the verified generation reads as verified", () => {
		const { lifecycle, failed, verified } = failedThenVerified(tempDir("pi-generation-verification-"));
		const snapshot = lifecycle.getTaskRuntimeSnapshot();

		expect(projectWorkerAttemptLaneRecord(snapshot, failed)).toMatchObject({
			attemptId: failed,
			status: "failed",
			reasonCode: "worker_failed",
			completedAt: snapshot.attempts[failed]?.updatedAt,
		});
		expect(projectWorkerAttemptLaneRecord(snapshot, verified)).toMatchObject({
			attemptId: verified,
			status: "succeeded",
			reasonCode: "verification_accepted",
		});
	});

	it("each generation's terminal notification carries its own outcome, also after a restart", () => {
		const agentDir = tempDir("pi-generation-verification-");
		const { lifecycle, failed, verified } = failedThenVerified(agentDir);
		const outcomes = (owner: WorkerLifecycle) =>
			[failed, verified].map((attemptId) => {
				const notification = owner.getAttemptTerminalNotification(attemptId);
				return [notification?.notificationId, notification?.record.attemptId, notification?.record.status];
			});
		const expected = [
			[`worker-terminal:${failed}`, failed, "failed"],
			[`worker-terminal:${verified}`, verified, "succeeded"],
		];
		expect(outcomes(lifecycle)).toEqual(expected);

		// A fresh store and lifecycle over the same durable directory: the process restarted.
		const reopened = lifecycleAt(agentDir);
		expect(
			reopened
				.getPendingTerminalNotifications()
				// The verifier task's own terminal is pending too; this checks the subject's two generations.
				.filter((pending) => pending.record.laneId === "task")
				.map((pending) => [pending.notificationId, pending.record.attemptId, pending.record.status]),
		).toEqual(expected);
		expect(outcomes(reopened)).toEqual(expected);
	});

	it("generation claims survive a session reopen with their exact identity", () => {
		const sessionDir = tempDir("pi-generation-claims-");
		const session = SessionManager.create(sessionDir, join(sessionDir, "agent"), join(sessionDir, "sessions"));
		session.appendMessage(fauxAssistantMessage("ready"));
		appendWorkerClaimSnapshot(session, {
			requestId: "lane",
			terminalAttemptId: "attempt-1",
			status: "failed",
			summary: "first",
			changedFiles: [],
		});
		appendWorkerClaimSnapshot(session, {
			requestId: "lane",
			terminalAttemptId: "attempt-2",
			status: "completed",
			summary: "second",
			changedFiles: [],
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("The session was not persisted.");

		const reopened = SessionManager.open(sessionFile, join(sessionDir, "agent"));
		const entries = reopened.getEntries();
		expect(getWorkerClaimSnapshotForAttempt(entries, "lane", "attempt-1")?.claim.summary).toBe("first");
		expect(getWorkerClaimSnapshotForAttempt(entries, "lane", "attempt-2")?.claim.summary).toBe("second");
	});
});
