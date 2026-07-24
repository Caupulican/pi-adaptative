import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { mapManagedLaneTerminalStatus } from "../src/core/delegation/managed-lane-controller.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";

/**
 * `recordManagedLane` is the host side of `pi.reportManagedLane`: the honest cross-process seam
 * that makes an out-of-process managed lane (e.g. a tmux worker) a first-class lane in THIS process's
 * LaneTracker. The extension only ever reports a claim; this controller stays the SSOT.
 */
function buildDeps(
	agentDir: string,
	overrides?: Partial<{
		goalId: string | undefined;
		saveWorkerClaimSnapshot: (claim: WorkerClaim, request?: unknown) => string;
		notifyWorkerTerminalHandoff: BackgroundLaneControllerDeps["notifyWorkerTerminalHandoff"];
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
		getSessionId: () => `test-session:${process.pid}:${agentDir}`,
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => (overrides?.goalId ? ({ goalId: overrides.goalId } as never) : undefined),
		// Host re-review: recordManagedLane's terminal branch re-checks changedFiles
		// against this envelope. Undefined here (no scope configured) matches this file's existing
		// intent -- these tests assert dispatch/terminal/quiesce bookkeeping, not the review verdict.
		getCapabilityEnvelope: () => undefined,
		saveWorkerClaimSnapshot: overrides?.saveWorkerClaimSnapshot ?? (() => "worker-claim-entry"),
		emit: () => {},
		notifyWorkerTerminalHandoff: overrides?.notifyWorkerTerminalHandoff ?? (async () => {}),
	} as never;
}

describe("managed lane host bridge (recordManagedLane)", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("mints a goalId-tagged tmux-worker lane on dispatch and holds exactly one quiesce unit", () => {
		const agentDir = "/tmp/pi-test-managed-lane-dispatch";
		const controller = new BackgroundLaneController(buildDeps(agentDir, { goalId: "goal-1" }));

		const returned = controller.recordManagedLane({
			laneId: "tmux-job-1",
			phase: "dispatch",
			goalId: "goal-1",
			dispatch: createTestManagedLaneDispatch(),
		});

		const records = controller.getLaneRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ type: "tmux-worker", status: "running", goalId: "goal-1" });
		// One canonical id crosses dispatch, goal binding, persistence, reload, and terminal reporting.
		expect(records[0]?.laneId).toBe("tmux-job-1");
		// The minted record is returned to the in-process caller, not just left in getLaneRecords().
		expect(returned).toEqual(records[0]);

		const units = getInFlightWorkUnits(agentDir);
		expect(units).toHaveLength(1);
		expect(units[0]?.kind).toBe("lane");
		expect(units[0]?.label).toMatch(/^tmux:/);
	});

	it("completes the lane on terminal, deregisters the quiesce unit, and persists a bounded claim snapshot", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal";
		const savedClaims: Array<{ claim: WorkerClaim; request?: unknown }> = [];
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				goalId: "goal-2",
				saveWorkerClaimSnapshot: (claim, request) => {
					savedClaims.push({ claim, request });
					return "worker-claim-entry";
				},
			}),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-2",
			phase: "dispatch",
			goalId: "goal-2",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		const returned = controller.recordManagedLane({
			laneId: "tmux-job-2",
			phase: "terminal",
			status: "succeeded",
			reasonCode: "worker_completed",
			changedFiles: ["src/a.ts"],
		});

		const records = controller.getLaneRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			status: "failed",
			reasonCode: "parent_review_required:missing_path_scope",
		});
		// The completed record is returned to the in-process caller.
		expect(returned).toEqual(records[0]);

		// Quiesce unit is gone -- no stuck registration across dispatch -> terminal.
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);

		expect(savedClaims).toHaveLength(1);
		expect(savedClaims[0]?.claim).toMatchObject({
			requestId: records[0]?.laneId,
			status: "completed",
			changedFiles: ["src/a.ts"],
		});
	});

	it("wakes the owning parent when a managed worker reports terminal", async () => {
		const notifyWorkerTerminalHandoff = vi.fn(async () => {});
		const controller = new BackgroundLaneController(
			buildDeps("/tmp/pi-test-managed-lane-handoff", { notifyWorkerTerminalHandoff }),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-handoff",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		const terminal = controller.recordManagedLane({
			laneId: "tmux-job-handoff",
			phase: "terminal",
			status: "succeeded",
			reasonCode: "worker_completed",
		});
		await vi.waitFor(() => expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1));

		expect(notifyWorkerTerminalHandoff).toHaveBeenCalledWith([
			{ laneId: terminal?.laneId, status: "succeeded", reasonCode: "worker_completed" },
		]);
	});

	it("does not materialize the in-process worker runtime to notify a managed worker terminal", async () => {
		const notifyWorkerTerminalHandoff = vi.fn(async () => {});
		const controller = new BackgroundLaneController(
			buildDeps("/tmp/pi-test-managed-lane-uac-notify", { notifyWorkerTerminalHandoff }),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-uac",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		controller.recordManagedLane({ laneId: "tmux-job-uac", phase: "terminal", status: "succeeded" });
		await vi.waitFor(() => expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1));

		expect((controller as unknown as { _workers?: unknown })._workers).toBeUndefined();
	});

	it("ignores a duplicate dispatch for an already-tracked laneId (no double quiesce registration)", () => {
		const agentDir = "/tmp/pi-test-managed-lane-duplicate-dispatch";
		const controller = new BackgroundLaneController(buildDeps(agentDir));

		const first = controller.recordManagedLane({
			laneId: "tmux-job-3",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		const second = controller.recordManagedLane({
			laneId: "tmux-job-3",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});

		expect(controller.getLaneRecords()).toHaveLength(1);
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);
		// The minted record is returned once; the duplicate dispatch no-op returns undefined.
		expect(first).toBeDefined();
		expect(second).toBeUndefined();
	});

	it("treats a terminal report for an unknown laneId as a safe no-op", () => {
		const agentDir = "/tmp/pi-test-managed-lane-unknown-terminal";
		let saveCalled = false;
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				saveWorkerClaimSnapshot: () => {
					saveCalled = true;
					return "unexpected";
				},
			}),
		);

		let returned: unknown;
		expect(() => {
			returned = controller.recordManagedLane({ laneId: "never-dispatched", phase: "terminal", status: "failed" });
		}).not.toThrow();

		expect(returned).toBeUndefined();
		expect(controller.getLaneRecords()).toEqual([]);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		expect(saveCalled).toBe(false);
	});

	it("deregisters the quiesce unit even if persisting the claim snapshot throws", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal-throws";
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				saveWorkerClaimSnapshot: () => {
					throw new Error("persistence boom");
				},
			}),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-4",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
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
		controller.recordManagedLane({
			laneId: "tmux-job-5",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(controller.getActiveLaneCount()).toBe(1);
	});

	it("a terminal event carrying usage attributes usage.cost.total onto the lane's costUsd, advisory and un-repriced", () => {
		const agentDir = "/tmp/pi-test-managed-lane-usage-cost";
		const controller = new BackgroundLaneController(buildDeps(agentDir, { goalId: "goal-6" }));

		controller.recordManagedLane({
			laneId: "tmux-job-6",
			phase: "dispatch",
			goalId: "goal-6",
			dispatch: createTestManagedLaneDispatch(),
		});
		const returned = controller.recordManagedLane({
			laneId: "tmux-job-6",
			phase: "terminal",
			status: "succeeded",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		});

		expect(returned?.costUsd).toBe(0.03);
		expect(controller.getLaneRecords()[0]?.costUsd).toBe(0.03);
	});

	it("a terminal event with no usage leaves costUsd unset (advisory, never fabricated)", () => {
		const agentDir = "/tmp/pi-test-managed-lane-no-usage-cost";
		const controller = new BackgroundLaneController(buildDeps(agentDir));

		controller.recordManagedLane({
			laneId: "tmux-job-7",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		const returned = controller.recordManagedLane({ laneId: "tmux-job-7", phase: "terminal", status: "succeeded" });

		expect(returned?.costUsd).toBeUndefined();
	});

	it("a duplicate terminal report for an already-completed (deregistered) laneId is an idempotent undefined no-op", () => {
		const agentDir = "/tmp/pi-test-managed-lane-duplicate-terminal";
		const controller = new BackgroundLaneController(buildDeps(agentDir));

		controller.recordManagedLane({
			laneId: "tmux-job-8",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		const first = controller.recordManagedLane({ laneId: "tmux-job-8", phase: "terminal", status: "succeeded" });
		expect(first).toBeDefined();

		const second = controller.recordManagedLane({ laneId: "tmux-job-8", phase: "terminal", status: "succeeded" });
		expect(second).toBeUndefined();
		// Idempotent: the lane record itself is unchanged by the redundant terminal report.
		expect(controller.getLaneRecords()).toHaveLength(1);
	});

	it("full chain: tmux terminal usage flows through costUsd into buildGoalRuntimeSnapshot's continuationWorkerSpendUsd", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getSessionId: () => `test-session:${process.pid}:managed-lane-spend-sum`,
			getCwd: () => "/repo",
			getAgentDir: () => "/tmp/pi-test-managed-lane-spend-sum",
			getSessionManager: () => sessionManager,
			getGoalStateSnapshot: () => ({ goalId: "goal-9" }) as never,
			getCapabilityEnvelope: () => undefined,
			saveWorkerClaimSnapshot: () => "worker-claim-entry",
			emit: () => {},
			notifyWorkerTerminalHandoff: async () => {},
		} as never);

		controller.recordManagedLane({
			laneId: "tmux-job-9",
			phase: "dispatch",
			goalId: "goal-9",
			dispatch: createTestManagedLaneDispatch(),
		});
		const dispatchedLaneId = controller.getLaneRecords()[0]?.laneId as string;

		let goalState = createGoalState({ goalId: "goal-9", userGoal: "Ship the thing", now: "T0" });
		goalState = applyGoalEvent(goalState, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		goalState = applyGoalEvent(goalState, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "do the thing",
			laneId: dispatchedLaneId,
			now: "T1",
		});
		appendGoalStateSnapshot(sessionManager, goalState);

		controller.recordManagedLane({
			laneId: "tmux-job-9",
			phase: "terminal",
			status: "succeeded",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			},
		});

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: controller.getLaneRecords(),
		});

		expect(snapshot.goalState?.continuationWorkerSpendUsd).toBe(0.3);
	});
});

describe("mapManagedLaneTerminalStatus", () => {
	it("maps LaneTracker terminal statuses onto the WorkerClaim status vocabulary", () => {
		expect(mapManagedLaneTerminalStatus("succeeded")).toBe("completed");
		expect(mapManagedLaneTerminalStatus("canceled")).toBe("cancelled");
		expect(mapManagedLaneTerminalStatus("failed")).toBe("failed");
		expect(mapManagedLaneTerminalStatus("timeout")).toBe("failed");
		expect(mapManagedLaneTerminalStatus("budget_exhausted")).toBe("failed");
	});
});
