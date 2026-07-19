import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";

/**
 * `resolveManagedLaneId` is the goal-to-tmux dispatch adapter's correlation read: given the CALLER's
 * own `laneId` (the id it passed to `recordManagedLane`'s `phase: "dispatch"`, e.g. a reconstructed
 * `tmux:jobId:agentId`), resolve the internal `LaneTracker` id that `Requirement.boundLaneId` and
 * `inFlightGoalLaneIds` actually match. Deterministic keyed lookup against `_managedLaneDispatches`
 * (NOT a racy `getLaneRecords()` diff).
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

describe("resolveManagedLaneId (correlation read for the goal-to-tmux dispatch adapter)", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("resolves the internal LaneTracker id for a tracked dispatch", () => {
		const agentDir = "/tmp/pi-test-resolve-managed-lane-tracked";
		const controller = new BackgroundLaneController(buildDeps(agentDir, []));

		controller.recordManagedLane({ laneId: "tmux:job1:agent1", phase: "dispatch", goalId: "goal-1" });
		const internalId = controller.getLaneRecords()[0]?.laneId;

		expect(controller.resolveManagedLaneId("tmux:job1:agent1")).toBe(internalId);
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

describe("REPRO SEED: a dispatched managed lane vanishes from a fresh BackgroundLaneController after /reload", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("a running tmux-worker lane is GONE from getLaneRecords() on a fresh controller seeded over the same session entries", () => {
		const agentDir = "/tmp/pi-test-c3-reload-vanish";
		// One shared, mutable entries array simulates the SAME SessionManager persistence surviving a
		// `/reload` (a fresh SessionManager instance would read back the identical persisted entries).
		const sharedEntries: SessionEntry[] = [];

		const before = new BackgroundLaneController(buildDeps(agentDir, sharedEntries, { goalId: "goal-c3" }));
		before.recordManagedLane({ laneId: "tmux:job-c3:agent1", phase: "dispatch", goalId: "goal-c3" });

		const runningRecord = before.getLaneRecords()[0];
		expect(runningRecord).toBeDefined();
		expect(runningRecord?.status).toBe("running");

		// `recordManagedLane`'s dispatch branch mints the lane + registers in-flight work but calls NO
		// `appendLaneRecordSnapshot` (only the terminal branch does) — so nothing durable exists for a
		// fresh controller to reconstruct the RUNNING lane from.
		expect(sharedEntries).toEqual([]);

		// Simulate `/reload`: a brand-new BackgroundLaneController over the SAME persisted session
		// entries (a fresh in-memory LaneTracker, exactly like a new process/session would have).
		const after = new BackgroundLaneController(buildDeps(agentDir, sharedEntries, { goalId: "goal-c3" }));

		// The vanish: the still-running lane is simply absent from the fresh controller's records.
		expect(after.getLaneRecords()).toEqual([]);
		expect(after.resolveManagedLaneId("tmux:job-c3:agent1")).toBeUndefined();

		// Duplicate-dispatch risk this repro sets up (fixed elsewhere, not here): a goal whose
		// `Requirement.boundLaneId` still points at `runningRecord.laneId` would no longer find it among
		// `after.getLaneRecords()`, so the "waiting" branch (keyed on an in-flight lane record for that
		// id) would no longer apply — the loop would see no in-flight work and could re-dispatch the
		// same requirement.
		const stillClaimedBound = runningRecord?.laneId as string;
		const looksInFlightAfterReload = after
			.getLaneRecords()
			.some(
				(record) =>
					record.laneId === stillClaimedBound && (record.status === "queued" || record.status === "running"),
			);
		expect(looksInFlightAfterReload).toBe(false);
	});
});
