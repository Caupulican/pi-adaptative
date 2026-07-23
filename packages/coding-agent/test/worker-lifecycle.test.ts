import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../src/core/orchestration/contracts.ts";
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
		const result: WorkerResultContract = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			resultId: "result-1",
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
		};
		expect(lifecycle.finish(result)).toMatchObject({ status: "succeeded", reasonCode: "worker_completed" });

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
});
