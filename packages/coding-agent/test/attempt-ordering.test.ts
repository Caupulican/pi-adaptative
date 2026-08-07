import { describe, expect, it } from "vitest";
import { latestAgentAttemptByDurableOrder } from "../src/core/orchestration/attempt-ordering.ts";
import type { AgentBindingContract } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";

function attempt(attemptId: string, taskId: string, status: AttemptRuntimeState["status"]): AttemptRuntimeState {
	return {
		attemptId,
		taskId,
		agentId: "agent-1",
		dispatch: {
			provider: "pi",
			taskId,
			instructions: "inspect",
			profileId: "explorer",
			logicalLaneId: "agent-1",
			resourcePointerIds: [],
		},
		status,
		checkpointIds: [],
		createdAt: "2026-08-07T00:00:00.000Z",
		updatedAt: "2026-08-07T00:00:00.000Z",
	};
}

describe("durable agent attempt ordering", () => {
	it("keeps a retry appended to an older task newer than an attempt on a later task", () => {
		const firstOldTaskAttempt = attempt("attempt-old-first", "task-old", "completed");
		const laterTaskAttempt = attempt("attempt-later-task", "task-later", "completed");
		const retriedOldTaskAttempt = attempt("attempt-old-retry", "task-old", "queued");
		const agent = {
			agentId: "agent-1",
		} as AgentBindingContract;
		const snapshot = {
			agents: { [agent.agentId]: agent },
			tasks: {
				"task-old": { attemptIds: [firstOldTaskAttempt.attemptId, retriedOldTaskAttempt.attemptId] },
				"task-later": { attemptIds: [laterTaskAttempt.attemptId] },
			},
			attempts: {
				[firstOldTaskAttempt.attemptId]: firstOldTaskAttempt,
				[laterTaskAttempt.attemptId]: laterTaskAttempt,
				[retriedOldTaskAttempt.attemptId]: retriedOldTaskAttempt,
			},
		} as unknown as TaskRuntimeProjection;

		expect(latestAgentAttemptByDurableOrder(snapshot, agent.agentId)?.attemptId).toBe(
			retriedOldTaskAttempt.attemptId,
		);
	});

	it("prefers the binding's authoritative active attempt over a later terminal insertion", () => {
		const resumedAttempt = attempt("attempt-resumed", "task-old", "suspended");
		const laterTerminalAttempt = attempt("attempt-later-terminal", "task-later", "completed");
		const agent = {
			agentId: "agent-1",
			activeAttemptId: resumedAttempt.attemptId,
		} as AgentBindingContract;
		const snapshot = {
			agents: { [agent.agentId]: agent },
			attempts: {
				[resumedAttempt.attemptId]: resumedAttempt,
				[laterTerminalAttempt.attemptId]: laterTerminalAttempt,
			},
		} as unknown as TaskRuntimeProjection;

		expect(latestAgentAttemptByDurableOrder(snapshot, agent.agentId)?.attemptId).toBe(resumedAttempt.attemptId);
	});
});
