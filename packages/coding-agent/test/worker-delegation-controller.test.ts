import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerDelegationController } from "../src/core/delegation/worker-delegation-controller.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../src/core/orchestration/contracts.ts";

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
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-controller-store-ownership-"));
		try {
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
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
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

	it("continues teardown after durable suspension and individual cleanup failures", () => {
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
			shellSessionKeys: new Set<string>(),
			deps: { emit },
		}) as unknown as WorkerDelegationController;

		expect(() => controller.abort()).not.toThrow();
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

	it("automatically injects memory query capability into worker execution plan when memory retrieval is enabled", () => {
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: {
				getCwd: () => "/tmp",
				getAgentDir: () => "/tmp/.agent",
				getCapabilityEnvelope: () => undefined,
				getSettingsManager: () => ({
					getMemoryRetrievalSettings: () => ({ enabled: true }),
				}),
			},
		}) as unknown as WorkerDelegationController;

		const buildPlan = Reflect.get(controller, "buildWorkerExecutionPlan") as (
			profile: unknown,
			settings: unknown,
		) => { readMemory: boolean; requiredCapabilities: readonly string[] };

		const mockProfile = {
			role: "implementer",
			toolNames: ["read"],
			capabilityCeiling: ["filesystem.read"],
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
