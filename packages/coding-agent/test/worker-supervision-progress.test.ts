import { expect, it } from "vitest";
import type { LiveWorkerAttempt } from "../src/core/supervision/types.ts";
import { WorkerSemanticSupervisor } from "../src/core/supervision/worker-semantic-supervisor.ts";
import { isValidationChurn } from "../src/core/supervision/worker-supervision-coordinator.ts";

it("requires repeated whole-project commands for deterministic churn", () => {
	const churn = (...commands: string[]) =>
		isValidationChurn({
			recentToolCalls: commands.map((command) => ({ name: "bash", args: { command } })),
			changedFileCount: 15,
			changedFileCountAtWindowStart: 15,
		});
	const scoped = "npx biome check packages/coding-agent/src/core/session-work-state.ts";
	expect(churn(scoped, "npx tsc --noEmit -p packages/coding-agent/tsconfig.build.json", scoped)).toBe(false);
	expect(churn(scoped, scoped, scoped)).toBe(false);
	expect(isValidationChurn({ recentToolNames: ["bash", "bash", "python"] })).toBe(false);
	expect(churn("npm run check", "npm run check", "npm run check")).toBe(true);
});

it("treats a new stall after recovery as a fresh steering episode", async () => {
	const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0 });
	const attempt: LiveWorkerAttempt = {
		attemptId: "attempt",
		taskId: "task",
		objectiveId: "objective",
		role: "implementer",
		mission: "Repair the command handling",
		elapsedMs: 4000,
		toolCalls: 5,
	};
	supervisor.noteSteering(attempt.attemptId, attempt.toolCalls);
	expect((await supervisor.observe({ ...attempt, toolCalls: 6, isStalled: true }))?.action).toBe("continue");
	expect(supervisor.getPriorSteeringCount(attempt.attemptId)).toBe(1);
	expect((await supervisor.observe({ ...attempt, toolCalls: 9 }))?.reason_codes).toContain(
		"worker_progressing_normally",
	);
	expect((await supervisor.observe({ ...attempt, toolCalls: 10, isStalled: true }))?.action).toBe("steer_once");
});
