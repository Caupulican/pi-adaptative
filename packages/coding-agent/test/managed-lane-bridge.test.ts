import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { mapManagedLaneTerminalStatus } from "../src/core/delegation/managed-lane-controller.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
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
		sessionManager: SessionManager;
		saveWorkerClaimSnapshot: (claim: WorkerClaim, request?: unknown) => string;
		notifyWorkerTerminalHandoff: BackgroundLaneControllerDeps["notifyWorkerTerminalHandoff"];
		addSpawnedUsage: BackgroundLaneControllerDeps["addSpawnedUsage"];
	}>,
): BackgroundLaneControllerDeps {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sessionManager =
		overrides?.sessionManager ??
		({
			getEntries: () => [],
			appendCustomEntry: (customType: string, data: unknown) => {
				appendedEntries.push({ customType, data });
				return `entry-${appendedEntries.length}`;
			},
		} as unknown as SessionManager);
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
		addSpawnedUsage: overrides?.addSpawnedUsage ?? (() => undefined),
	} as never;
}

describe("managed lane host bridge (recordManagedLane)", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
		vi.restoreAllMocks();
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
			status: "partial",
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

	it("keeps a managed lane resumably active when claim persistence fails, then finalizes exactly once on retry", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal-throws";
		let saveAttempts = 0;
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				saveWorkerClaimSnapshot: () => {
					saveAttempts += 1;
					if (saveAttempts === 1) throw new Error("persistence boom");
					return "worker-claim-entry";
				},
			}),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-4",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		expect(
			controller.recordManagedLane({ laneId: "tmux-job-4", phase: "terminal", status: "failed" }),
		).toBeUndefined();
		expect(controller.getLaneRecords()[0]).toMatchObject({ laneId: "tmux-job-4", status: "running" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		const completed = controller.recordManagedLane({ laneId: "tmux-job-4", phase: "terminal", status: "failed" });
		expect(completed).toMatchObject({ laneId: "tmux-job-4", status: "failed" });
		expect(saveAttempts).toBe(2);
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

	it("accounts managed terminal usage through the same idempotent spawned-usage contract as native workers", () => {
		const addSpawnedUsage = vi.fn(() => "managed-usage-report");
		const saveWorkerClaimSnapshot = vi.fn(() => "managed-claim-entry");
		const controller = new BackgroundLaneController(
			buildDeps("/tmp/pi-test-managed-lane-spawned-usage", { addSpawnedUsage, saveWorkerClaimSnapshot }),
		);
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
		};

		controller.recordManagedLane({
			laneId: "tmux-job-accounted",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		controller.recordManagedLane({
			laneId: "tmux-job-accounted",
			phase: "terminal",
			status: "succeeded",
			usage,
		});
		controller.recordManagedLane({
			laneId: "tmux-job-accounted",
			phase: "terminal",
			status: "succeeded",
			usage,
		});

		expect(addSpawnedUsage).toHaveBeenCalledTimes(1);
		expect(addSpawnedUsage).toHaveBeenCalledWith(usage, {
			label: "managed-worker",
			reportId: expect.stringMatching(/^managed-worker:/),
		});
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ usageReportId: expect.stringMatching(/^managed-worker:/) }),
		);
	});

	it("accounts usage before terminal finalization so a reporting failure remains retryable with one stable report id", () => {
		const agentDir = "/tmp/pi-test-managed-lane-usage-retry";
		const reportIds: string[] = [];
		let reportAttempts = 0;
		const saveWorkerClaimSnapshot = vi.fn(() => "managed-claim-entry");
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, {
				addSpawnedUsage: vi.fn((_usage, options) => {
					reportAttempts += 1;
					reportIds.push(options.reportId);
					if (reportAttempts === 1) throw new Error("spawned usage storage unavailable");
					return "managed-usage-report";
				}),
				saveWorkerClaimSnapshot,
			}),
		);
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		};

		controller.recordManagedLane({
			laneId: "tmux-job-usage-retry",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(
			controller.recordManagedLane({
				laneId: "tmux-job-usage-retry",
				phase: "terminal",
				status: "succeeded",
				usage,
			}),
		).toBeUndefined();
		expect(saveWorkerClaimSnapshot).not.toHaveBeenCalled();
		expect(controller.getLaneRecords()[0]).toMatchObject({ laneId: "tmux-job-usage-retry", status: "running" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		const completed = controller.recordManagedLane({
			laneId: "tmux-job-usage-retry",
			phase: "terminal",
			status: "succeeded",
			usage,
		});
		expect(completed).toMatchObject({ laneId: "tmux-job-usage-retry", status: "succeeded", costUsd: 0.03 });
		expect(reportIds).toHaveLength(2);
		expect([...new Set(reportIds)]).toHaveLength(1);
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledWith(expect.objectContaining({ usageReportId: reportIds[0] }));
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("does not duplicate a persisted usage-tagged claim when lifecycle finalization fails before retry", () => {
		const agentDir = "/tmp/pi-test-managed-lane-finalizer-retry";
		const addSpawnedUsage = vi.fn(() => "managed-usage-report");
		const sessionManager = InMemorySessionManager.inMemory();
		const saveWorkerClaimSnapshot = vi.fn((claim: WorkerClaim) =>
			sessionManager.appendCustomEntry("worker_claim", { version: 1, claim }),
		);
		vi.spyOn(WorkerLifecycle.prototype, "finish").mockImplementationOnce(() => {
			throw new Error("lifecycle storage unavailable");
		});
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, { addSpawnedUsage, saveWorkerClaimSnapshot, sessionManager }),
		);
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		};

		controller.recordManagedLane({
			laneId: "tmux-job-finalizer-retry",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(
			controller.recordManagedLane({
				laneId: "tmux-job-finalizer-retry",
				phase: "terminal",
				status: "succeeded",
				usage,
			}),
		).toBeUndefined();
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledTimes(1);
		expect(controller.getLaneRecords()[0]).toMatchObject({ laneId: "tmux-job-finalizer-retry", status: "running" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		const completed = controller.recordManagedLane({
			laneId: "tmux-job-finalizer-retry",
			phase: "terminal",
			status: "succeeded",
			usage,
		});
		expect(completed).toMatchObject({ laneId: "tmux-job-finalizer-retry", status: "succeeded" });
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledTimes(1);
		expect(addSpawnedUsage).toHaveBeenCalledTimes(2);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("does not duplicate a persisted no-usage claim when lifecycle finalization fails before retry", () => {
		const agentDir = "/tmp/pi-test-managed-lane-no-usage-finalizer-retry";
		const sessionManager = InMemorySessionManager.inMemory();
		const saveWorkerClaimSnapshot = vi.fn((claim: WorkerClaim) =>
			sessionManager.appendCustomEntry("worker_claim", { version: 1, claim }),
		);
		vi.spyOn(WorkerLifecycle.prototype, "finish").mockImplementationOnce(() => {
			throw new Error("lifecycle storage unavailable");
		});
		const controller = new BackgroundLaneController(buildDeps(agentDir, { saveWorkerClaimSnapshot, sessionManager }));

		controller.recordManagedLane({
			laneId: "tmux-job-no-usage-finalizer-retry",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(
			controller.recordManagedLane({
				laneId: "tmux-job-no-usage-finalizer-retry",
				phase: "terminal",
				status: "succeeded",
			}),
		).toBeUndefined();
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledTimes(1);
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		const completed = controller.recordManagedLane({
			laneId: "tmux-job-no-usage-finalizer-retry",
			phase: "terminal",
			status: "succeeded",
		});
		expect(completed).toMatchObject({ laneId: "tmux-job-no-usage-finalizer-retry", status: "succeeded" });
		expect(saveWorkerClaimSnapshot).toHaveBeenCalledTimes(1);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("persists distinct terminal claim identities for later dispatches on the same managed lane", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const savedClaims: WorkerClaim[] = [];
		const controller = new BackgroundLaneController(
			buildDeps("/tmp/pi-test-managed-lane-later-dispatch", {
				sessionManager,
				saveWorkerClaimSnapshot: (claim) => {
					savedClaims.push(claim);
					return sessionManager.appendCustomEntry("worker_claim", { version: 1, claim });
				},
			}),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-later-dispatch",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch({ sequence: 1 }),
		});
		controller.recordManagedLane({ laneId: "tmux-job-later-dispatch", phase: "terminal", status: "succeeded" });
		controller.recordManagedLane({
			laneId: "tmux-job-later-dispatch",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch({ sequence: 2 }),
		});
		controller.recordManagedLane({ laneId: "tmux-job-later-dispatch", phase: "terminal", status: "succeeded" });

		expect(savedClaims).toHaveLength(2);
		expect(savedClaims[0]?.terminalAttemptId).toBeTruthy();
		expect(savedClaims[1]?.terminalAttemptId).toBeTruthy();
		expect(savedClaims[0]?.terminalAttemptId).not.toBe(savedClaims[1]?.terminalAttemptId);
	});

	it("returns the durable terminal record and releases registration when projection persistence fails after finalization", () => {
		const agentDir = "/tmp/pi-test-managed-lane-terminal-projection-failure";
		let laneRecordWrites = 0;
		const sessionManager = {
			getEntries: () => [],
			appendCustomEntry: (customType: string) => {
				if (customType === "lane_record" && ++laneRecordWrites === 2) {
					throw new Error("lane projection storage unavailable");
				}
				return "worker-claim-entry";
			},
		} as unknown as SessionManager;
		const controller = new BackgroundLaneController(buildDeps(agentDir, { sessionManager }));

		controller.recordManagedLane({
			laneId: "tmux-job-terminal-projection-failure",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		const terminal = controller.recordManagedLane({
			laneId: "tmux-job-terminal-projection-failure",
			phase: "terminal",
			status: "succeeded",
		});

		expect(terminal).toMatchObject({ laneId: "tmux-job-terminal-projection-failure", status: "succeeded" });
		expect(controller.getLaneRecords()[0]).toMatchObject({
			laneId: "tmux-job-terminal-projection-failure",
			status: "succeeded",
		});
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("rejects malformed managed usage before it can poison durable state or accounting", () => {
		const agentDir = "/tmp/pi-test-managed-lane-invalid-usage";
		const addSpawnedUsage = vi.fn(() => "unexpected");
		const controller = new BackgroundLaneController(buildDeps(agentDir, { addSpawnedUsage }));

		controller.recordManagedLane({
			laneId: "tmux-job-invalid-usage",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(
			controller.recordManagedLane({
				laneId: "tmux-job-invalid-usage",
				phase: "terminal",
				status: "succeeded",
				usage: {
					input: Number.NaN,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		).toBeUndefined();
		expect(addSpawnedUsage).not.toHaveBeenCalled();
		expect(controller.getLaneRecords()[0]).toMatchObject({ laneId: "tmux-job-invalid-usage", status: "running" });
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);
	});

	it("rejects oversized changed-file terminal reports before review, accounting, or claim persistence", () => {
		const agentDir = "/tmp/pi-test-managed-lane-oversized-changed-files";
		const addSpawnedUsage = vi.fn(() => "unexpected");
		const saveWorkerClaimSnapshot = vi.fn(() => "unexpected");
		const controller = new BackgroundLaneController(
			buildDeps(agentDir, { addSpawnedUsage, saveWorkerClaimSnapshot }),
		);

		controller.recordManagedLane({
			laneId: "tmux-job-oversized-changed-files",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		expect(
			controller.recordManagedLane({
				laneId: "tmux-job-oversized-changed-files",
				phase: "terminal",
				status: "succeeded",
				changedFiles: Array.from({ length: 129 }, (_, index) => `src/${index}.ts`),
			}),
		).toBeUndefined();
		expect(addSpawnedUsage).not.toHaveBeenCalled();
		expect(saveWorkerClaimSnapshot).not.toHaveBeenCalled();
		expect(controller.getLaneRecords()[0]).toMatchObject({
			laneId: "tmux-job-oversized-changed-files",
			status: "running",
		});
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);
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
		// partial and budget_exhausted both deliberately map to "partial" (commit 78a2158dd,
		// "unblock partial DAGs"): folding either into "completed"/"failed" was itself the
		// partial-reported-as-done masking bug that shipped in v0.90.3-v0.90.7.
		expect(mapManagedLaneTerminalStatus("partial")).toBe("partial");
		expect(mapManagedLaneTerminalStatus("budget_exhausted")).toBe("partial");
		expect(mapManagedLaneTerminalStatus("blocked")).toBe("blocked");
		expect(mapManagedLaneTerminalStatus("canceled")).toBe("cancelled");
		expect(mapManagedLaneTerminalStatus("failed")).toBe("failed");
		expect(mapManagedLaneTerminalStatus("timeout")).toBe("failed");
	});
});
