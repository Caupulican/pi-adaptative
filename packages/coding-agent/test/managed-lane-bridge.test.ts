import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/core/autonomy/contracts.ts";
import {
	BackgroundLaneController,
	type BackgroundLaneControllerDeps,
	mapManagedLaneTerminalStatus,
} from "../src/core/background-lane-controller.ts";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";

/**
 * `recordManagedLane` is the host side of `pi.reportManagedLane`: the honest cross-process seam
 * that makes an out-of-process managed lane (e.g. a tmux worker) a first-class lane in THIS process's
 * LaneTracker. The extension only ever reports a claim; this controller stays the SSOT.
 */
function buildDeps(
	agentDir: string,
	overrides?: Partial<{
		goalId: string | undefined;
		saveWorkerResultSnapshot: (result: WorkerResult, request?: unknown) => string;
	}>,
): BackgroundLaneControllerDeps {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sessionManager = {
		getEntries: () => [],
		appendCustomEntry: (customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
			return `entry-${appendedEntries.length}`;
		},
	} as unknown as SessionManager;
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => (overrides?.goalId ? ({ goalId: overrides.goalId } as never) : undefined),
		// Host re-review: recordManagedLane's terminal branch re-checks changedFiles
		// against this envelope. Undefined here (no scope configured) matches this file's existing
		// intent -- these tests assert dispatch/terminal/quiesce bookkeeping, not the review verdict.
		getCapabilityEnvelope: () => undefined,
		saveWorkerResultSnapshot: overrides?.saveWorkerResultSnapshot ?? (() => "worker-result-entry"),
	} as never;
}

describe("managed lane host bridge (recordManagedLane)", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("mints a goalId-tagged tmux-worker lane on dispatch and holds exactly one quiesce unit", () => {
		const agentDir = "/tmp/pi-test-managed-lane-dispatch";
		const controller = new BackgroundLaneController(buildDeps(agentDir, { goalId: "goal-1" }));

		controller.recordManagedLane({ laneId: "tmux-job-1", phase: "dispatch", goalId: "goal-1" });

		const records = controller.getLaneRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ type: "tmux-worker", status: "running", goalId: "goal-1" });
		// The internal LaneTracker id is distinct from the caller's own laneId.
		expect(records[0]?.laneId).not.toBe("tmux-job-1");

		const units = getInFlightWorkUnits(agentDir);
		expect(units).toHaveLength(1);
		expect(units[0]?.kind).toBe("lane");
		expect(units[0]?.label).toMatch(/^tmux:/);
	});

	it("completes the lane on terminal, deregisters the quiesce unit, and persists a bounded claim snapshot", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal";
		const savedResults: Array<{ result: WorkerResult; request?: unknown }> = [];
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				goalId: "goal-2",
				saveWorkerResultSnapshot: (result, request) => {
					savedResults.push({ result, request });
					return "worker-result-entry";
				},
			}),
		);

		controller.recordManagedLane({ laneId: "tmux-job-2", phase: "dispatch", goalId: "goal-2" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		controller.recordManagedLane({
			laneId: "tmux-job-2",
			phase: "terminal",
			status: "succeeded",
			reasonCode: "worker_completed",
			changedFiles: ["src/a.ts"],
		});

		const records = controller.getLaneRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "succeeded", reasonCode: "worker_completed" });

		// Quiesce unit is gone -- no stuck registration across dispatch -> terminal.
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);

		expect(savedResults).toHaveLength(1);
		expect(savedResults[0]?.result).toMatchObject({
			requestId: records[0]?.laneId,
			status: "completed",
			changedFiles: ["src/a.ts"],
		});
	});

	it("ignores a duplicate dispatch for an already-tracked laneId (no double quiesce registration)", () => {
		const agentDir = "/tmp/pi-test-managed-lane-duplicate-dispatch";
		const controller = new BackgroundLaneController(buildDeps(agentDir));

		controller.recordManagedLane({ laneId: "tmux-job-3", phase: "dispatch" });
		controller.recordManagedLane({ laneId: "tmux-job-3", phase: "dispatch" });

		expect(controller.getLaneRecords()).toHaveLength(1);
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);
	});

	it("treats a terminal report for an unknown laneId as a safe no-op", () => {
		const agentDir = "/tmp/pi-test-managed-lane-unknown-terminal";
		let saveCalled = false;
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				saveWorkerResultSnapshot: () => {
					saveCalled = true;
					return "unexpected";
				},
			}),
		);

		expect(() =>
			controller.recordManagedLane({ laneId: "never-dispatched", phase: "terminal", status: "failed" }),
		).not.toThrow();

		expect(controller.getLaneRecords()).toEqual([]);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		expect(saveCalled).toBe(false);
	});

	it("deregisters the quiesce unit even if persisting the claim snapshot throws", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal-throws";
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				saveWorkerResultSnapshot: () => {
					throw new Error("persistence boom");
				},
			}),
		);

		controller.recordManagedLane({ laneId: "tmux-job-4", phase: "dispatch" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		expect(() => controller.recordManagedLane({ laneId: "tmux-job-4", phase: "terminal", status: "failed" })).toThrow(
			"persistence boom",
		);

		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("counts a dispatched tmux-worker lane in the /autonomy active-lane total", () => {
		const agentDir = "/tmp/pi-test-managed-lane-active-count";
		const controller = new BackgroundLaneController(buildDeps(agentDir));

		expect(controller.getActiveLaneCount()).toBe(0);
		controller.recordManagedLane({ laneId: "tmux-job-5", phase: "dispatch" });
		expect(controller.getActiveLaneCount()).toBe(1);
	});
});

describe("mapManagedLaneTerminalStatus", () => {
	it("maps LaneTracker terminal statuses onto the WorkerResult status vocabulary", () => {
		expect(mapManagedLaneTerminalStatus("succeeded")).toBe("completed");
		expect(mapManagedLaneTerminalStatus("canceled")).toBe("cancelled");
		expect(mapManagedLaneTerminalStatus("failed")).toBe("failed");
		expect(mapManagedLaneTerminalStatus("timeout")).toBe("failed");
		expect(mapManagedLaneTerminalStatus("budget_exhausted")).toBe("failed");
	});
});
