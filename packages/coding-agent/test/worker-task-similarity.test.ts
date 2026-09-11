import { describe, expect, it } from "vitest";
import {
	DUPLICATE_WORKER_TASK_THRESHOLD,
	findSimilarActiveWorkerLanes,
	workerInstructionSimilarity,
} from "../src/core/delegation/worker-task-similarity.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";

function attempt(taskId: string, instructions: string, status: AttemptRuntimeState["status"]): AttemptRuntimeState {
	return {
		attemptId: `${taskId}-attempt`,
		taskId,
		dispatch: { taskId, instructions, profileId: "profile-1", resourcePointerIds: [] },
		status,
		checkpointIds: [],
		createdAt: "2026-09-10T00:00:00.000Z",
		updatedAt: "2026-09-10T00:00:00.000Z",
	};
}

function snapshot(attempts: readonly AttemptRuntimeState[]): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: Object.fromEntries(
			attempts.map((entry) => [
				entry.taskId,
				{
					task: {
						schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
						taskId: entry.taskId,
						objectiveId: "objective-1",
						title: entry.taskId,
						description: entry.dispatch.instructions,
						role: "implementer",
						status: "ready",
						dependsOn: [],
						requiredCapabilities: [],
						acceptanceCriterionIds: [],
						riskBudget: {},
						createdAt: entry.createdAt,
						updatedAt: entry.updatedAt,
					},
					attemptIds: [entry.attemptId],
				},
			]),
		),
		attempts: Object.fromEntries(attempts.map((entry) => [entry.attemptId, entry])),
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

const review = "Read-only review of v0.99.16 retire/lane overlay vs Team session retained. Do not edit.";

describe("worker task similarity", () => {
	it("scores identical text 1, rewordings of the same review high, and different tasks low", () => {
		expect(workerInstructionSimilarity(review, review)).toBe(1);
		expect(
			workerInstructionSimilarity(
				review,
				"Read-only review: v0.99.16 retire/lane overlay vs Team session retained; do not edit",
			),
		).toBeGreaterThan(DUPLICATE_WORKER_TASK_THRESHOLD);
		expect(
			workerInstructionSimilarity(
				review,
				"Read-only review of v0.99.16 webfetch Turndown budget vs the reference implementation.",
			),
		).toBeLessThan(0.5);
	});

	it("names active in-process lanes only, most similar first", () => {
		const snap = snapshot([
			attempt("worker-1", review, "running"),
			attempt("worker-2", "Read-only review of v0.99.16 webfetch Turndown budget vs reference.", "queued"),
			attempt("worker-3", review, "completed"),
		]);
		expect(findSimilarActiveWorkerLanes(snap, review)).toEqual([{ laneId: "worker-1", similarity: 1 }]);
		expect(findSimilarActiveWorkerLanes(snap, "Summarize the changelog for v0.99.16")).toEqual([]);
	});
});
