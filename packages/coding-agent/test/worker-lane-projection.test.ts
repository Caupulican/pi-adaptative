import { describe, expect, it } from "vitest";
import { projectWorkerLaneRecord } from "../src/core/delegation/worker-lane-projection.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type {
	AttemptRuntimeState,
	TaskRuntimeProjection,
	TaskRuntimeState,
} from "../src/core/orchestration/task-runtime.ts";

function taskState(taskId: string, attemptIds: readonly string[]): TaskRuntimeState {
	return {
		task: {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			taskId,
			objectiveId: "objective-1",
			title: `Title ${taskId}`,
			description: `Description ${taskId}`,
			role: "implementer",
			status: "ready",
			dependsOn: [],
			requiredCapabilities: [],
			acceptanceCriterionIds: [],
			riskBudget: {},
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:00.000Z",
		},
		attemptIds,
	};
}

function snapshot(
	tasks: readonly TaskRuntimeState[],
	attempts: Readonly<Record<string, AttemptRuntimeState>>,
): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: Object.fromEntries(tasks.map((task) => [task.task.taskId, task])),
		attempts,
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

function budgetExhaustedAttempt(overrides: Partial<AttemptRuntimeState> = {}): AttemptRuntimeState {
	return {
		attemptId: "attempt-1",
		taskId: "subject",
		dispatch: { taskId: "subject", instructions: "do it", profileId: "profile-1" },
		// The over-budget completion path (worker-runner.ts) finalizes the claim as "partial" while
		// carrying a "cost_budget_exceeded" reasonCode — the attempt-level status mirrors the claim.
		status: "partial",
		checkpointIds: [],
		result: {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			resultId: "result-1",
			objectiveId: "objective-1",
			taskId: "subject",
			attemptId: "attempt-1",
			leaseId: "lease-1",
			fencingToken: 1,
			status: "partial",
			reasonCode: "cost_budget_exceeded",
			summary: "over budget",
			artifacts: [],
			evidence: [],
			errors: [],
			usage: { wallClockMs: 1000, toolCalls: 1, costUsd: 999 },
			createdAt: "2026-08-07T00:05:00.000Z",
		},
		createdAt: "2026-08-07T00:00:00.000Z",
		updatedAt: "2026-08-07T00:05:00.000Z",
		...overrides,
	} as unknown as AttemptRuntimeState;
}

describe("projectWorkerLaneRecord terminal status", () => {
	it("projects budget_exhausted (not partial) when a partial result carries a budget reasonCode", () => {
		const attempt = budgetExhaustedAttempt();
		const snap = snapshot([taskState("subject", ["attempt-1"])], { "attempt-1": attempt });

		const record = projectWorkerLaneRecord(snap, "subject");

		expect(record?.status).toBe("budget_exhausted");
		expect(record?.reasonCode).toBe("cost_budget_exceeded");
	});

	it("still projects partial for a non-budget partial result (no regression on the ordinary case)", () => {
		const attempt = budgetExhaustedAttempt({
			result: {
				...budgetExhaustedAttempt().result,
				status: "partial",
				reasonCode: "worker_incomplete",
			},
		} as Partial<AttemptRuntimeState>);
		const snap = snapshot([taskState("subject", ["attempt-1"])], { "attempt-1": attempt });

		const record = projectWorkerLaneRecord(snap, "subject");

		expect(record?.status).toBe("partial");
		expect(record?.reasonCode).toBe("worker_incomplete");
	});

	it("projects timeout when a blocked result carries a timeout reasonCode", () => {
		const attempt = budgetExhaustedAttempt({
			status: "blocked",
			result: {
				...budgetExhaustedAttempt().result,
				status: "blocked",
				reasonCode: "attempt_wall_clock_timeout",
			},
		} as Partial<AttemptRuntimeState>);
		const snap = snapshot([taskState("subject", ["attempt-1"])], { "attempt-1": attempt });

		const record = projectWorkerLaneRecord(snap, "subject");

		expect(record?.status).toBe("timeout");
	});
});
