import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";

/**
 * `resolveManagedLaneId` is the goal-to-tmux dispatch adapter's correlation read. The caller's
 * stable id is the canonical lane id, so goal bindings, persistence, and terminal events all use
 * the same identity without an in-memory translation.
 */
function buildDeps(
	agentDir: string,
	sharedEntries: SessionEntry[],
	overrides?: Partial<{ goalId: string | undefined }>,
): BackgroundLaneControllerDeps {
	const sessionManager = {
		getEntries: () => [...sharedEntries],
		appendCustomEntry: (customType: string, data: unknown) => {
			const entry = {
				type: "custom",
				customType,
				data,
				id: `entry-${sharedEntries.length + 1}`,
			} as unknown as SessionEntry;
			sharedEntries.push(entry);
			return entry.id as string;
		},
	} as unknown as SessionManager;
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => (overrides?.goalId ? ({ goalId: overrides.goalId } as never) : undefined),
		getCapabilityEnvelope: () => undefined,
		saveWorkerResultSnapshot: () => "worker-result-entry",
	} as never;
}

describe("resolveManagedLaneId (stable identity read for the goal-to-tmux dispatch adapter)", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("preserves the caller's stable id for a tracked dispatch", () => {
		const agentDir = "/tmp/pi-test-resolve-managed-lane-tracked";
		const controller = new BackgroundLaneController(buildDeps(agentDir, []));

		controller.recordManagedLane({ laneId: "tmux:job1:agent1", phase: "dispatch", goalId: "goal-1" });
		expect(controller.getLaneRecords()[0]?.laneId).toBe("tmux:job1:agent1");
		expect(controller.resolveManagedLaneId("tmux:job1:agent1")).toBe("tmux:job1:agent1");
	});

	it("returns undefined for a callerLaneId that was never dispatched", () => {
		const agentDir = "/tmp/pi-test-resolve-managed-lane-untracked";
		const controller = new BackgroundLaneController(buildDeps(agentDir, []));

		expect(controller.resolveManagedLaneId("tmux:never:seen")).toBeUndefined();
	});

	it("returns undefined once the matching dispatch has gone terminal (correlation entry removed)", () => {
		const agentDir = "/tmp/pi-test-resolve-managed-lane-terminal";
		const controller = new BackgroundLaneController(buildDeps(agentDir, []));

		controller.recordManagedLane({ laneId: "tmux:job2:agent1", phase: "dispatch" });
		expect(controller.resolveManagedLaneId("tmux:job2:agent1")).toBeDefined();

		controller.recordManagedLane({ laneId: "tmux:job2:agent1", phase: "terminal", status: "succeeded" });
		expect(controller.resolveManagedLaneId("tmux:job2:agent1")).toBeUndefined();
	});

	it("keys strictly on the caller's laneId — a different caller id for the same dispatch resolves to nothing", () => {
		const agentDir = "/tmp/pi-test-resolve-managed-lane-distinct-keys";
		const controller = new BackgroundLaneController(buildDeps(agentDir, []));

		controller.recordManagedLane({ laneId: "tmux:job3:agent1", phase: "dispatch" });

		expect(controller.resolveManagedLaneId("tmux:job3:agent2")).toBeUndefined();
	});
});

describe("managed lane reload recovery", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("restores the same running tmux-worker identity from the session log", () => {
		const agentDir = "/tmp/pi-test-c3-reload-vanish";
		// One shared, mutable entries array simulates the SAME SessionManager persistence surviving a
		// `/reload` (a fresh SessionManager instance would read back the identical persisted entries).
		const sharedEntries: SessionEntry[] = [];

		const before = new BackgroundLaneController(buildDeps(agentDir, sharedEntries, { goalId: "goal-c3" }));
		before.recordManagedLane({ laneId: "tmux:job-c3:agent1", phase: "dispatch", goalId: "goal-c3" });

		const runningRecord = before.getLaneRecords()[0];
		expect(runningRecord).toBeDefined();
		expect(runningRecord?.status).toBe("running");

		expect(sharedEntries).toHaveLength(1);
		expect(sharedEntries[0]).toMatchObject({
			customType: "lane_record",
			data: { record: { laneId: "tmux:job-c3:agent1", status: "running", goalId: "goal-c3" } },
		});

		// `/reload` releases only process-local quiesce state; it does not invent a terminal result for
		// a worker that continues in tmux.
		before.abortInFlightLanes();
		const after = new BackgroundLaneController(buildDeps(agentDir, sharedEntries, { goalId: "goal-c3" }));

		expect(after.getLaneRecords()).toEqual([runningRecord]);
		expect(after.resolveManagedLaneId("tmux:job-c3:agent1")).toBe("tmux:job-c3:agent1");
	});

	it("accepts a terminal report after reload and leaves no active projection", () => {
		const agentDir = "/tmp/pi-test-managed-lane-reload-terminal";
		const sharedEntries: SessionEntry[] = [];
		const before = new BackgroundLaneController(buildDeps(agentDir, sharedEntries));
		before.recordManagedLane({ laneId: "tmux:job-terminal:agent1", phase: "dispatch" });
		before.abortInFlightLanes();

		const resumed = new BackgroundLaneController(buildDeps(agentDir, sharedEntries));
		expect(
			resumed.recordManagedLane({ laneId: "tmux:job-terminal:agent1", phase: "dispatch", status: "resumed" }),
		).toBeUndefined();
		expect(
			resumed.recordManagedLane({
				laneId: "tmux:job-terminal:agent1",
				phase: "terminal",
				status: "completed",
				reasonCode: "worker_completed",
			}),
		).toMatchObject({
			laneId: "tmux:job-terminal:agent1",
			status: "succeeded",
			reasonCode: "worker_completed",
		});

		const reopened = new BackgroundLaneController(buildDeps(agentDir, sharedEntries));
		expect(reopened.getLaneRecords()).toEqual([]);
		expect(reopened.resolveManagedLaneId("tmux:job-terminal:agent1")).toBeUndefined();
	});
});
