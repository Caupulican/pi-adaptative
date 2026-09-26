import { describe, expect, it, vi } from "vitest";
import { WorkerDelegationController } from "../src/core/delegation/worker-delegation-controller.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../src/core/orchestration/contracts.ts";
import { tempDir } from "./temp-dir.ts";

function controllerWithRunningCaller(): WorkerDelegationController {
	return Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
		deps: { isDisposed: () => false },
		lifecycle: {
			getAgent: (agentId: string) => ({ agentId, rootAgentId: "root" }),
			getLatestAgentAttempt: () => ({ attemptId: "attempt-caller", status: "running" }),
			getRunningCount: () => 1,
			getTaskRuntimeSnapshot: () => ({ attempts: { "attempt-caller": { status: "running" } } }),
		},
		scheduler: { drain: vi.fn() },
		yieldedCapacityAttemptIds: new Map<string, number>(),
		yieldedWriteReservations: new Map(),
		writeReservations: { yieldForWait: vi.fn(() => undefined) },
	}) as unknown as WorkerDelegationController;
}

describe("WorkerDelegationController integration invariants", () => {
	it("shares its conversation store with logical-agent control", () => {
		const agentDir = tempDir("pi-worker-controller-store-ownership-");
		const controller = new WorkerDelegationController(
			{
				getAgentDir: () => agentDir,
				getSessionId: () => "session-store-ownership",
				isDelegateToolActive: () => true,
				isDisposed: () => false,
				emit: vi.fn(),
			} as unknown as ConstructorParameters<typeof WorkerDelegationController>[0],
			{ statusChanged: vi.fn() } as unknown as ConstructorParameters<typeof WorkerDelegationController>[1],
			{
				getTaskRuntimeSnapshot: () => ({ agents: {} }),
			} as unknown as ConstructorParameters<typeof WorkerDelegationController>[2],
		);

		const conversations = Reflect.get(controller, "conversations");
		const agentControl = Reflect.get(controller, "agentControl") as object;

		expect(conversations).toBeDefined();
		expect(Reflect.get(agentControl, "conversations")).toBe(conversations);
	});

	it("keeps a running lane's write reservation through cancellation until its run releases it", () => {
		const agentDir = tempDir("pi-worker-cancel-reservation-");
		const controller = new WorkerDelegationController(
			{
				getAgentDir: () => agentDir,
				getSessionId: () => "session-cancel-reservation",
				isDelegateToolActive: () => true,
				isDisposed: () => false,
				emit: vi.fn(),
			} as unknown as ConstructorParameters<typeof WorkerDelegationController>[0],
			{ statusChanged: vi.fn() } as unknown as ConstructorParameters<typeof WorkerDelegationController>[1],
			{
				getTaskRuntimeSnapshot: () => ({ agents: {} }),
				cancel: () => undefined,
			} as unknown as ConstructorParameters<typeof WorkerDelegationController>[2],
		);
		const running = new Set(["running-lane"]);
		const release = vi.fn();
		Reflect.set(controller, "scheduler", {
			dropQueued: vi.fn(),
			drain: vi.fn(),
			isRunning: (laneId: string) => running.has(laneId),
		});
		Reflect.set(controller, "writeReservations", { release });
		const options = Reflect.get(Reflect.get(controller, "agentControl") as object, "options") as {
			cancelLane(laneId: string, reasonCode: string): unknown;
		};

		// The abort is asynchronous: an in-flight edit can still write, so the run's own end releases.
		options.cancelLane("running-lane", "owner_cancelled");
		expect(release).not.toHaveBeenCalled();
		// A queued lane has no run to release it.
		options.cancelLane("queued-lane", "owner_cancelled");
		expect(release).toHaveBeenCalledWith("queued-lane");
	});

	it("reports lost scheduler cancellation ownership without publishing a false terminal", () => {
		const release = vi.fn();
		const publishTerminalRecord = vi.fn();
		const cancelUnleased = vi.fn(() => ({
			cancelled: false,
			record: { laneId: "worker-race", type: "worker", status: "running" },
		}));
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			lifecycle: {
				getActiveAttempt: () => ({ attemptId: "attempt-race", dispatch: {} }),
				getAgent: () => undefined,
				getRecord: () => ({ laneId: "worker-race", type: "worker", status: "running" }),
				cancelUnleased,
			},
			writeReservations: { release },
			publishTerminalRecord,
			deps: { isDisposed: () => false, emit: vi.fn() },
			scheduler: { drain: vi.fn() },
		}) as unknown as WorkerDelegationController;
		const cancelScheduledWorker = Reflect.get(controller, "cancelScheduledWorker") as (
			laneId: string,
			reasonCode: string,
			attemptId: string,
		) => boolean;

		expect(cancelScheduledWorker.call(controller, "worker-race", "worker_start_unavailable", "attempt-race")).toBe(
			false,
		);
		expect(release).toHaveBeenCalledWith("worker-race");
		expect(cancelUnleased).toHaveBeenCalledWith("worker-race", "worker_start_unavailable", "attempt-race");
		expect(publishTerminalRecord).not.toHaveBeenCalled();
	});

	it("retains a caller capacity yield until every independent wait lease releases it", () => {
		const controller = controllerWithRunningCaller();
		const yieldCapacity = Reflect.get(controller, "yieldWorkerForWait") as (callerAgentId: string) => () => boolean;
		const hasCapacity = Reflect.get(controller, "hasWorkerCapacity") as (settings: {
			maxConcurrent: number;
		}) => boolean;

		const releaseFirst = yieldCapacity.call(controller, "caller");
		const releaseSecond = yieldCapacity.call(controller, "caller");
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);

		releaseFirst();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);
		releaseFirst();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);

		releaseSecond();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(false);
	});

	it("keeps the caller yielded until its exact write reservation is restored", () => {
		const yieldedReservation = { laneId: "caller-task", lease: { attemptId: "attempt-caller" } };
		const yieldForWait = vi.fn(() => yieldedReservation);
		const restoreAfterWait = vi
			.fn()
			.mockReturnValueOnce({ kind: "blocked" })
			.mockReturnValueOnce({ kind: "granted" });
		const drain = vi.fn();
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: { isDisposed: () => false },
			lifecycle: {
				getAgent: () => ({ agentId: "caller", rootAgentId: "root" }),
				getLatestAgentAttempt: () => ({
					attemptId: "attempt-caller",
					taskId: "caller-task",
					status: "running",
					lease: { fencingToken: 7 },
				}),
			},
			scheduler: { drain },
			laneAbortControllers: new Map(),
			yieldedCapacityAttemptIds: new Map<string, number>(),
			yieldedWriteReservations: new Map(),
			writeReservations: { yieldForWait, restoreAfterWait },
		}) as unknown as WorkerDelegationController;
		const yieldCaller = Reflect.get(controller, "yieldWorkerForWait") as (callerAgentId: string) => () => boolean;

		const restore = yieldCaller.call(controller, "caller");
		expect(yieldForWait).toHaveBeenCalledWith("caller-task", "attempt-caller", 7);
		expect(drain).toHaveBeenCalledWith(true);

		expect(restore()).toBe(false);
		expect(Reflect.get(controller, "yieldedCapacityAttemptIds")).toEqual(new Map([["attempt-caller", 1]]));
		expect(restore()).toBe(true);
		expect(restoreAfterWait).toHaveBeenCalledTimes(2);
		expect(Reflect.get(controller, "yieldedCapacityAttemptIds")).toEqual(new Map());
		expect(Reflect.get(controller, "yieldedWriteReservations")).toEqual(new Map());
	});

	it("releases the caller's yield bookkeeping even when its write reservation restore is denied", () => {
		// Root-cause regression: a "denied" restore used to throw before ever reaching the
		// yieldedCapacityAttemptIds/yieldedWriteReservations cleanup, leaving a permanent stale
		// entry that over-counts virtual headroom in hasWorkerCapacity() for the rest of the
		// attempt's life -- silently admitting maxConcurrent+1 workers.
		const yieldedReservation = { laneId: "caller-task", lease: { attemptId: "attempt-caller" } };
		const yieldForWait = vi.fn(() => yieldedReservation);
		const restoreAfterWait = vi.fn(() => ({ kind: "denied", reasonCode: "write_reservation_unavailable" }));
		const abort = vi.fn();
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: { isDisposed: () => false },
			lifecycle: {
				getAgent: () => ({ agentId: "caller", rootAgentId: "root" }),
				getLatestAgentAttempt: () => ({
					attemptId: "attempt-caller",
					taskId: "caller-task",
					status: "running",
					lease: { fencingToken: 7 },
				}),
			},
			scheduler: { drain: vi.fn() },
			laneAbortControllers: new Map([["caller-task", { abort }]]),
			yieldedCapacityAttemptIds: new Map<string, number>(),
			yieldedWriteReservations: new Map(),
			writeReservations: { yieldForWait, restoreAfterWait },
		}) as unknown as WorkerDelegationController;
		const yieldCaller = Reflect.get(controller, "yieldWorkerForWait") as (callerAgentId: string) => () => boolean;

		const restore = yieldCaller.call(controller, "caller");
		expect(Reflect.get(controller, "yieldedCapacityAttemptIds")).toEqual(new Map([["attempt-caller", 1]]));

		expect(() => restore()).toThrow("Worker wait could not restore its write reservation");
		expect(abort).toHaveBeenCalledWith("write_reservation_unavailable");
		expect(Reflect.get(controller, "yieldedCapacityAttemptIds")).toEqual(new Map());
		expect(Reflect.get(controller, "yieldedWriteReservations")).toEqual(new Map());

		// Idempotent: calling the same restore closure again must not re-throw or re-abort.
		expect(restore()).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("bounds mandatory-verifier instructions while retaining omission disclosure", () => {
		const controller = Object.create(WorkerDelegationController.prototype) as WorkerDelegationController;
		const buildVerifierRequest = Reflect.get(controller, "buildVerifierRequest") as (args: {
			subjectTaskId: string;
			verifierProfileId: string;
			summary: string;
			artifactUris: readonly string[];
		}) => { instructions: string };
		const request = buildVerifierRequest.call(controller, {
			subjectTaskId: "subject",
			verifierProfileId: "verifier",
			summary: "implementation summary",
			artifactUris: Array.from({ length: 64 }, (_, index) => `${index}-`.padEnd(4_096, "x")),
		});

		expect(request.instructions.length).toBeLessThanOrEqual(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH);
		expect(request.instructions).toContain("artifact URI(s) omitted");
	});

	it("keeps complete verifier evidence when the request already fits", () => {
		const controller = Object.create(WorkerDelegationController.prototype) as WorkerDelegationController;
		const buildVerifierRequest = Reflect.get(controller, "buildVerifierRequest") as (args: {
			subjectTaskId: string;
			verifierProfileId: string;
			summary: string;
			artifactUris: readonly string[];
		}) => { instructions: string };
		const request = buildVerifierRequest.call(controller, {
			subjectTaskId: "subject",
			verifierProfileId: "verifier",
			summary: "implementation summary",
			artifactUris: ["src/one.ts", "src/two.ts"],
		});

		expect(request.instructions).toContain("- src/one.ts\n- src/two.ts");
		expect(request.instructions).not.toContain("artifact URI(s) omitted");
	});

	it("does not publish or fence a nonterminal verification-blocked subject projection", () => {
		const clearScheduledRetry = vi.fn();
		const recordTerminal = vi.fn();
		const publishTerminalObserversBestEffort = vi.fn();
		const signalStateChanged = vi.fn();
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			recovery: { clearScheduledRetry },
			lifecycle: {
				getActiveAttempt: () => ({ attemptId: "implementation-attempt", dispatch: {} }),
				getAgent: () => undefined,
			},
			publishedTerminalAttemptIds: new Set<string>(),
			recordTerminal,
			publishTerminalObserversBestEffort,
			agentControl: { signalStateChanged },
		}) as unknown as WorkerDelegationController;
		const publishTerminalRecord = Reflect.get(controller, "publishTerminalRecord") as (record: {
			laneId: string;
			type: "worker";
			status: "running";
		}) => void;

		publishTerminalRecord.call(controller, {
			laneId: "implementation-task",
			type: "worker",
			status: "running",
		});

		expect(clearScheduledRetry).not.toHaveBeenCalled();
		expect(recordTerminal).not.toHaveBeenCalled();
		expect(publishTerminalObserversBestEffort).not.toHaveBeenCalled();
		expect(signalStateChanged).not.toHaveBeenCalled();
		expect(Reflect.get(controller, "publishedTerminalAttemptIds")).toEqual(new Set());
	});

	it("continues teardown after durable suspension and awaits worker shell terminals", async () => {
		const stages: string[] = [];
		const emit = vi.fn();
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			workerAbort: { abort: () => stages.push("abort") },
			lifecycle: {
				suspendBoundInProcessAttemptsForRestart: () => {
					stages.push("suspend");
					throw new Error("durable suspension failed");
				},
				getRecords: () => [],
			},
			agentControl: { getProcessOwnerId: () => "owner" },
			inFlightLedgers: new Map(),
			scheduler: {
				cancelQueued: () => {
					stages.push("scheduler");
					throw new Error("scheduler cleanup failed");
				},
			},
			recovery: { dispose: () => stages.push("recovery") },
			terminalHandoffs: {
				dispose: () => {
					stages.push("handoffs");
					throw new Error("handoff cleanup failed");
				},
			},
			writeReservations: { dispose: () => stages.push("reservations") },
			conversations: { clearCache: () => stages.push("conversations") },
			shellSessionKeys: new Set(["worker:session:agent"]),
			deps: { emit },
		}) as unknown as WorkerDelegationController;

		const shutdown = controller.abort();
		expect(shutdown).toBeInstanceOf(Promise);
		await expect(shutdown).resolves.toBeUndefined();
		expect(stages).toEqual([
			"abort",
			"suspend",
			"scheduler",
			"recovery",
			"handoffs",
			"reservations",
			"conversations",
		]);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "warning", message: expect.stringContaining("durable suspension failed") }),
		);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "warning", message: expect.stringContaining("scheduler cleanup failed") }),
		);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "warning", message: expect.stringContaining("handoff cleanup failed") }),
		);
	});

	it("refuses worker admission when target requirement dependencies in goal-state are unsatisfied", () => {
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: {
				getGoalStateSnapshot: () => ({
					requirements: [
						{ id: "R1", status: "open" },
						{ id: "R2", status: "open", dependencies: ["R1"] },
					],
				}),
			},
		}) as unknown as WorkerDelegationController;

		const goalDepSkipReason = Reflect.get(controller, "workerGoalDependencySkipReason") as (
			req: unknown,
		) => string | undefined;

		expect(goalDepSkipReason.call(controller, { taskContext: { requirementIds: ["R2"] } })).toBe(
			"goal_dependency_unsatisfied",
		);
		expect(goalDepSkipReason.call(controller, { taskContext: { requirementIds: ["R1"] } })).toBeUndefined();
		expect(
			goalDepSkipReason.call(controller, {
				taskContext: { requirementIds: ["R2"] },
				verificationOfTaskId: "task-123",
			}),
		).toBeUndefined();
	});

	it("grants only the bounded memory_read adapter when retrieval is enabled", () => {
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: {
				getCwd: () => "/tmp",
				getAgentDir: () => "/tmp/.agent",
				getCapabilityEnvelope: () => undefined,
				getSettingsManager: () => ({
					getMemoryRetrievalSettings: () => ({ enabled: true }),
					getEdgeSettings: () => ({ mode: "guarded", allow: [], deny: [] }),
				}),
			},
		}) as unknown as WorkerDelegationController;

		const buildPlan = Reflect.get(controller, "buildWorkerExecutionPlan") as (
			profile: unknown,
			settings: unknown,
		) => { readMemory: boolean; requiredCapabilities: readonly string[] };

		const mockProfile = {
			role: "implementer",
			toolNames: ["read", "memory_read"],
			capabilityCeiling: ["filesystem.read", "memory.query"],
			budget: {},
		};
		const mockSettings = {
			writeEnabled: false,
			writePaths: [],
			maxUsd: 0,
			maxWallClockMs: 0,
		};

		const plan = buildPlan.call(controller, mockProfile, mockSettings);
		expect(plan.readMemory).toBe(true);
		expect(plan.requiredCapabilities).toContain("memory.query");
	});
});
