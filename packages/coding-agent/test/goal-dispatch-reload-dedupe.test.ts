import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createGoalToolDefinition,
	type GoalToolDependencies,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

/**
 * Reload recovery plus the conservative dedupe guard. Part 1 proves a running managed lane keeps its
 * identity across a fresh controller. Part 2 retains the tool-level refusal for legacy/malformed
 * sessions where a binding exists but neither durable liveness nor a terminal result can be proven.
 */

function buildLaneControllerDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
	const sessionManager =
		(overrides.getSessionManager?.() as SessionManager | undefined) ?? InMemorySessionManager.inMemory();
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => "/tmp/pi-test-goal-dispatch-reload-dedupe",
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerResultSnapshot: () => "worker-result-entry",
		...overrides,
	} as unknown as BackgroundLaneControllerDeps;
}

describe("managed lane reload recovery (real BackgroundLaneController)", () => {
	it("restores a running managed lane under the same canonical id", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const blc = new BackgroundLaneController(buildLaneControllerDeps({ getSessionManager: () => sessionManager }));

		blc.recordManagedLane({ laneId: "tmux:job1:agent1", phase: "dispatch", goalId: "g1" });
		expect(blc.getLaneRecords()).toHaveLength(1);
		expect(blc.getLaneRecords()[0]?.status).toBe("running");
		const dispatchedLaneId = blc.getLaneRecords()[0]?.laneId as string;

		blc.abortInFlightLanes();
		// Simulate /reload: a fresh controller over the same branch-scoped session entries.
		const reseeded = new BackgroundLaneController(
			buildLaneControllerDeps({ getSessionManager: () => sessionManager }),
		);
		expect(reseeded.getLaneRecords()).toHaveLength(1);
		expect(reseeded.getLaneRecords()).toContainEqual(
			expect.objectContaining({ laneId: dispatchedLaneId, status: "running", goalId: "g1" }),
		);
		expect(reseeded.resolveManagedLaneId(dispatchedLaneId)).toBe(dispatchedLaneId);
	});
});

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

describe("goal.ts dispatch_worker indeterminate-binding guard (applies to both targets before routing)", () => {
	it("bound + still LIVE (queued/running) lane -> refuses 'requirement_already_bound', preserves boundLaneId, never calls the dispatch dep", async () => {
		let laneRecords: LaneRecord[] = [];
		const dispatchedRequirementIds: string[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				dispatchedRequirementIds.push(requirementId);
				return { laneId: `lane-${dispatchedRequirementIds.length}` };
			},
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => [],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const first = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go" });
		expect(first.details.dispatchedLaneId).toBe("lane-1");
		expect(dispatchedRequirementIds).toEqual(["r1"]);

		// The dispatched lane is still queued/running.
		laneRecords = [{ laneId: "lane-1", type: "worker", status: "running" }];
		const stateBeforeRefusal = getState();

		const second = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go again" });

		expect(second.details.dispatchSkipReason).toBe("requirement_already_bound");
		expect(second.details.dispatchedLaneId).toBeUndefined();
		expect(second.details.applied).toBe(true);
		expect(dispatchedRequirementIds).toEqual(["r1"]); // the dispatch dep was NEVER called a second time
		expect(getState()).toBe(stateBeforeRefusal); // literally unchanged -- applyGoalAction never ran
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-1");
		expect(firstText(second.content)).toContain("requirement_already_bound");
	});

	it("legacy bound state with no lane record or terminal result refuses 'bound_lane_indeterminate'", async () => {
		let laneRecords: LaneRecord[] = [];
		let workerResults: WorkerResult[] = [];
		const dispatchedRequirementIds: string[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				dispatchedRequirementIds.push(requirementId);
				return { laneId: `lane-${dispatchedRequirementIds.length}` };
			},
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => workerResults,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		laneRecords = [{ laneId: "lane-1", type: "tmux-worker", status: "running" }];
		const first = await run({
			action: "dispatch_worker",
			requirementId: "r1",
			instructions: "go",
			dispatchTarget: "tmux",
		});
		expect(first.details.dispatchedLaneId).toBe("lane-1");

		// Simulate a legacy/malformed snapshot with neither durable liveness nor a terminal result.
		laneRecords = [];
		workerResults = [];
		const stateBeforeRefusal = getState();

		const second = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go again" });

		expect(second.details.dispatchSkipReason).toBe("bound_lane_indeterminate");
		expect(second.details.dispatchedLaneId).toBeUndefined();
		expect(dispatchedRequirementIds).toEqual(["r1"]); // never re-dispatched
		expect(getState()).toBe(stateBeforeRefusal);
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-1");
	});

	it("bound + a live TERMINAL lane record -> ALLOWS re-dispatch (a legitimate retry)", async () => {
		let laneRecords: LaneRecord[] = [];
		const dispatchedRequirementIds: string[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				dispatchedRequirementIds.push(requirementId);
				return { laneId: `lane-${dispatchedRequirementIds.length}` };
			},
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => [],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const first = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go" });
		expect(first.details.dispatchedLaneId).toBe("lane-1");

		// The prior worker finished -- its lane record is still around, now terminal.
		laneRecords = [{ laneId: "lane-1", type: "worker", status: "succeeded" }];

		const second = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "retry" });

		expect(second.details.dispatchSkipReason).toBeUndefined();
		expect(second.details.dispatchedLaneId).toBe("lane-2");
		expect(dispatchedRequirementIds).toEqual(["r1", "r1"]);
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-2");
	});

	it("bound + a terminal WorkerResult snapshot (no lane record at all) -> ALLOWS re-dispatch", async () => {
		let workerResults: WorkerResult[] = [];
		const dispatchedRequirementIds: string[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				dispatchedRequirementIds.push(requirementId);
				return { laneId: `lane-${dispatchedRequirementIds.length}` };
			},
			getLaneRecords: () => [],
			getWorkerResultSnapshots: () => workerResults,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const first = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go" });
		expect(first.details.dispatchedLaneId).toBe("lane-1");

		// No live lane record survives, but a durable worker-result snapshot proves completion.
		workerResults = [
			{ requestId: "lane-1", status: "completed", summary: "done", changedFiles: [], parentReviewRequired: false },
		];

		const second = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "retry" });

		expect(second.details.dispatchSkipReason).toBeUndefined();
		expect(second.details.dispatchedLaneId).toBe("lane-2");
		expect(dispatchedRequirementIds).toEqual(["r1", "r1"]);
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-2");
	});

	it("a FIRST dispatch (no prior boundLaneId) is never guard-refused, for either target", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: () => ({ laneId: "lane-1" }),
			getLaneRecords: () => [],
			getWorkerResultSnapshots: () => [],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go" });

		expect(result.details.dispatchSkipReason).toBeUndefined();
		expect(result.details.dispatchedLaneId).toBe("lane-1");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-1");
	});
});
