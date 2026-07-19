import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createGoalToolDefinition,
	type GoalToolDependencies,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

/** Wires an in-memory goal tool over a plain in-memory state slot (no SessionManager needed). */
function createProducer(overrides: Partial<GoalToolDependencies> = {}) {
	let state: ReturnType<GoalToolDependencies["getGoalState"]>;
	let counter = 0;
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (s) => {
			state = s;
		},
		now: () => `T${counter++}`,
		...overrides,
	});
	return {
		run: async (input: GoalToolInput) => {
			const result = await tool.execute("call", input, undefined, undefined, ctx);
			return { content: result.content, details: result.details as GoalToolDetails };
		},
		getState: () => state,
	};
}

function firstText(content: Array<{ type: string; text?: string }>): string {
	const first = content[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") {
		throw new Error("expected text content");
	}
	return first.text;
}

/**
 * `dispatch_worker`'s tool-layer side effect is now LIVE (previously it was a stub). These tests
 * exercise the adapter's honest reporting: a real dispatch (laneId), a real decline from an
 * underlying delegation starter that IS wired (skipReason), and the dependency being altogether
 * absent -- three distinct, never-conflated outcomes. `goal-worker-evidence.test.ts` already
 * covers the pure "worker" evidence-kind verification against injected
 * getLaneRecords/getWorkerResultSnapshots; the last test here closes the loop end-to-end through
 * the SAME tool instance to prove the live dep wiring composes with that existing verification.
 */
describe("goal action 'dispatch_worker' (live adapter)", () => {
	it("captures a real laneId, binds it as boundLaneId, and reports the in-process route", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => ({ laneId: `lane-for-${requirementId}` }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		expect(result.details.dispatchedLaneId).toBe("lane-for-r1");
		expect(result.details.dispatchSkipReason).toBeUndefined();
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-for-r1");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.status).toBe("open");
		expect(firstText(result.content)).toContain("Dispatched in-process worker lane 'lane-for-r1'");
		expect(firstText(result.content)).toContain("tmux dispatch is not available from this tool yet");
	});

	it("reports a real decline from a wired starter distinctly from an unwired dependency", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: () => ({ skipReason: "worker_delegation_already_running" }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		expect(result.details.dispatchedLaneId).toBeUndefined();
		expect(result.details.dispatchSkipReason).toBe("worker_delegation_already_running");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
		expect(firstText(result.content)).toContain("worker_delegation_already_running");
	});

	it("reports 'dependency_unwired' distinctly when startWorkerDelegation is absent altogether", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.dispatchSkipReason).toBe("dependency_unwired");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
	});

	it("end-to-end: a dispatched lane's worker result later verifies 'worker' evidence true through the SAME tool", async () => {
		let laneRecords: LaneRecord[] = [];
		let workerResults: WorkerResult[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				const laneId = `lane-for-${requirementId}`;
				laneRecords = [{ laneId, type: "worker", status: "succeeded" }];
				return { laneId };
			},
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => workerResults,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const dispatched = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });
		const laneId = dispatched.details.dispatchedLaneId;
		expect(laneId).toBe("lane-for-r1");

		// The worker "completes" -- a result snapshot lands keyed by that same laneId.
		workerResults = [
			{
				requestId: laneId as string,
				status: "completed",
				summary: "done",
				changedFiles: [],
				parentReviewRequired: false,
			},
		];

		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "worker finished the task",
			uri: laneId,
		});
		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(true);

		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });
		const completed = await run({ action: "complete" });
		expect(completed.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});
});
