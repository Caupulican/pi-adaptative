import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

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
	const prepared = lifecycle.prepare({ instructions: "implement", profile, requiredCapabilities: [] });
	const handle = lifecycle.start(prepared.record.laneId, profile.leaseTtlMs);
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
	it("persists terminal notifications until the parent acknowledges delivery", () => {
		const agentDir = root();
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "worker",
			model: { provider: "test", id: "model", maxTokens: 8_192 },
		});
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-1" });
		const prepared = lifecycle.prepare({
			instructions: "inspect",
			profile,
			requiredCapabilities: ["filesystem.read"],
		});
		const handle = lifecycle.start(prepared.record.laneId, profile.leaseTtlMs);
		lifecycle.bindGrant(handle.attemptId, "grant-1");
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
		const prepared = lifecycle.prepare({ instructions: "inspect", profile, requiredCapabilities: [] });

		expect(lifecycle.cancel(prepared.record.laneId, "session_disposed")).toMatchObject({
			status: "canceled",
			reasonCode: "session_disposed",
		});
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

		expect(lifecycle.getPendingVerificationRecoveries()).toEqual([
			{
				action: "dispatch",
				subjectTaskId: implementation.laneId,
				implementationProfileId: "implementation",
				summary: "implementation persisted",
				artifactUris: ["file:///repo/output.ts"],
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
			profile: verifierProfile,
			requiredCapabilities: [],
			verificationOfTaskId: implementation.laneId,
		});
		const verifierHandle = lifecycle.start(verifier.record.laneId, verifierProfile.leaseTtlMs);
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
			profile: verifierProfile,
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
