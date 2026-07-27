import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { finalizeWorkerClaim } from "../src/core/delegation/worker-terminal-finalizer.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-terminal-finalizer-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function preparedLifecycle() {
	const agentDir = root();
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "terminal-finalizer" });
	const profile = createTestWorkerOrchestrationProfile({
		profileId: "terminal-finalizer-worker",
		model: { provider: "test", id: "worker" },
	});
	const prepared = lifecycle.prepare({
		instructions: "Inspect the scoped work.",
		executionContract: createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile),
			},
		}),
		requiredCapabilities: [],
	});
	const task = lifecycle.getTask(prepared.record.laneId);
	if (!task) throw new Error("Expected durable task.");
	lifecycle.bindGrant(
		prepared.attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId: prepared.attempt.attemptId,
			role: task.task.role,
		}),
	);
	return {
		agentDir,
		lifecycle,
		handle: lifecycle.start(prepared.record.laneId, profile.leaseTtlMs),
	};
}

describe("finalizeWorkerClaim", () => {
	it("owns one fenced durable terminal result and event-driven notification for accepted work", () => {
		const { lifecycle, handle } = preparedLifecycle();
		const finalized = finalizeWorkerClaim(lifecycle, {
			handle,
			claim: {
				requestId: handle.taskId,
				status: "completed",
				summary: "The scoped work completed.",
				changedFiles: [],
				createdAt: "2026-07-27T00:00:00.000Z",
			},
			accepted: true,
			cwd: root(),
			wallClockMs: 12,
			toolCalls: 1,
		});

		expect(finalized.result).toMatchObject({
			attemptId: handle.attemptId,
			leaseId: handle.leaseId,
			fencingToken: handle.fencingToken,
			status: "completed",
		});
		expect(finalized.record).toMatchObject({ laneId: handle.taskId, status: "succeeded" });
		expect(finalized.notification).toMatchObject({
			notificationId: `worker-terminal:${handle.attemptId}`,
			status: "pending",
		});
	});

	it("uses the same terminal contract for a disposal cancellation", () => {
		const { agentDir, lifecycle, handle } = preparedLifecycle();
		const claim: WorkerClaim = {
			requestId: handle.taskId,
			status: "cancelled",
			summary: "Canceled at the owning session disposal boundary.",
			changedFiles: [],
			createdAt: "2026-07-27T00:00:00.000Z",
		};

		const finalized = finalizeWorkerClaim(lifecycle, {
			handle,
			claim,
			accepted: false,
			cwd: agentDir,
			reasonCode: "session_disposed",
			wallClockMs: 12,
			toolCalls: 0,
		});

		expect(finalized.result).toMatchObject({
			attemptId: handle.attemptId,
			leaseId: handle.leaseId,
			fencingToken: handle.fencingToken,
			status: "cancelled",
			reasonCode: "session_disposed",
		});
		expect(finalized.record).toMatchObject({ laneId: handle.taskId, status: "canceled" });
		expect(finalized.notification).toMatchObject({
			notificationId: `worker-terminal:${handle.attemptId}`,
			status: "pending",
		});
		expect(
			new WorkerLifecycle({ agentDir, sessionId: "terminal-finalizer" }).getPendingTerminalNotifications(),
		).toHaveLength(1);
	});

	it("preserves a failed execution reason through the same fenced result path", () => {
		const { lifecycle, handle } = preparedLifecycle();
		const finalized = finalizeWorkerClaim(lifecycle, {
			handle,
			claim: {
				requestId: handle.taskId,
				status: "failed",
				summary: "The provider completion failed.",
				changedFiles: [],
				createdAt: "2026-07-27T00:00:00.000Z",
			},
			accepted: false,
			cwd: root(),
			reasonCode: "worker_delegation_error",
			wallClockMs: 12,
			toolCalls: 0,
		});

		expect(finalized.result).toMatchObject({ status: "failed", reasonCode: "worker_delegation_error" });
		expect(finalized.record).toMatchObject({ status: "failed", reasonCode: "worker_delegation_error" });
	});

	it("keeps independent verification terminal publication deferred to reconciliation", () => {
		const { lifecycle, handle } = preparedLifecycle();
		const finalized = finalizeWorkerClaim(lifecycle, {
			handle,
			claim: {
				requestId: handle.taskId,
				status: "completed",
				summary: "Implementation evidence is ready for verification.",
				changedFiles: [],
				createdAt: "2026-07-27T00:00:00.000Z",
			},
			accepted: false,
			cwd: root(),
			verificationRequired: true,
			wallClockMs: 12,
			toolCalls: 0,
			notify: false,
		});

		expect(finalized.record).toMatchObject({ status: "running" });
		expect(finalized.notification).toBeUndefined();
		expect(lifecycle.getPendingTerminalNotifications()).toEqual([]);
	});

	it("rejects an oversized direct-path claim before lifecycle finalization", () => {
		const { lifecycle, handle } = preparedLifecycle();
		expect(() =>
			finalizeWorkerClaim(lifecycle, {
				handle,
				claim: {
					requestId: handle.taskId,
					status: "completed",
					summary: "hostile direct path",
					changedFiles: Array.from({ length: 129 }, () => "safe.ts"),
				},
				accepted: true,
				cwd: root(),
				wallClockMs: 1,
				toolCalls: 0,
			}),
		).toThrow("claim.changedFiles exceeds 128 entries");
		expect(lifecycle.getRecord(handle.taskId)).toMatchObject({ status: "running" });
	});
});
