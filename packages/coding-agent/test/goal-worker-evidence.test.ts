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

function laneRecord(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return { laneId: "lane-1", type: "worker", status: "succeeded", ...overrides };
}

function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
	return { requestId: "lane-1", status: "completed", summary: "done", changedFiles: [], ...overrides };
}

/**
 * The "worker" evidence kind COMPOSES with the EXISTING verified/complete gate rather than
 * building a new one -- these tests exercise the same `isVerifiedOrUserEvidence`
 * / `complete` machinery already covered by goal-evidence-verification.test.ts, just for the new
 * kind. Verification never trusts the worker's own claim: it cross-checks the SESSION's lane
 * records and persisted result snapshots, and an unreviewed mutation can never verify true.
 */
describe("goal evidence kind 'worker' verification", () => {
	it("verifies true for a laneId mapping to a reviewed, completed worker result", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord()],
			getWorkerResultSnapshots: () => [workerResult({ parentReviewRequired: false })],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "worker finished the task",
			uri: "lane-1",
		});

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(true);
	});

	it("verifies true when parentReviewRequired is true but the mutation has been reviewed", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord()],
			getWorkerResultSnapshots: () => [
				workerResult({ parentReviewRequired: true, parentReviewedAt: "2026-01-01T00:00:00.000Z" }),
			],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "worker", summary: "reviewed", uri: "lane-1" });

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(true);
	});

	it("verifies false for an UNREVIEWED worker mutation (parentReviewRequired && no parentReviewedAt)", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord()],
			getWorkerResultSnapshots: () => [workerResult({ parentReviewRequired: true })],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "worker finished but out-of-scope changes need review",
			uri: "lane-1",
		});

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("an unreviewed worker completion cannot ungate 'complete' through the existing gate", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord()],
			getWorkerResultSnapshots: () => [workerResult({ parentReviewRequired: true })],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "unreviewed worker result",
			uri: "lane-1",
		});
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(false);
		expect(getState()?.status).toBe("active");
	});

	it("a reviewed, passing worker completion DOES satisfy the existing 'complete' gate", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord()],
			getWorkerResultSnapshots: () => [workerResult({ parentReviewRequired: false })],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "worker finished cleanly",
			uri: "lane-1",
		});
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});

	it("verifies false when the laneId has no matching lane record", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [],
			getWorkerResultSnapshots: () => [workerResult()],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "worker", summary: "no such lane", uri: "lane-1" });

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("verifies false when the lane exists but has no persisted worker result yet", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord({ status: "running" })],
			getWorkerResultSnapshots: () => [],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "worker", summary: "still running", uri: "lane-1" });

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("verifies false when the worker result is not a passing completion (e.g. failed)", async () => {
		const { run, getState } = createProducer({
			getLaneRecords: () => [laneRecord({ status: "failed" })],
			getWorkerResultSnapshots: () => [workerResult({ status: "failed", parentReviewRequired: false })],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "worker", summary: "worker failed", uri: "lane-1" });

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("verifies false (not undefined) when getLaneRecords/getWorkerResultSnapshots are not wired at all", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "unverifiable without lane/result access",
			uri: "lane-1",
		});

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});
});

/**
 * The tool-layer side effect for dispatch_worker is a STUB here -- `startWorkerDelegation` is
 * optional and, when unwired, dispatch_worker still records the binding structurally with no
 * laneId. Live wiring (the real dispatch) is exercised separately.
 */
describe("goal action 'dispatch_worker' (tool layer)", () => {
	it("records boundLaneId from the wired startWorkerDelegation stub without satisfying the requirement", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => ({ laneId: `lane-for-${requirementId}` }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		const state = getState();
		expect(state?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-for-r1");
		expect(state?.requirements.find((r) => r.id === "r1")?.status).toBe("open");
	});

	it("records the binding with no laneId when startWorkerDelegation is unwired (stub/no-op)", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		const state = getState();
		expect(state?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
		expect(state?.requirements.find((r) => r.id === "r1")?.status).toBe("open");
	});

	it("fails on an unknown requirement", async () => {
		const { run } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		const result = await run({ action: "dispatch_worker", requirementId: "nope", instructions: "go" });

		expect(result.details.applied).toBe(false);
	});
});
