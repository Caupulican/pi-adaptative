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
	}) as unknown as WorkerDelegationController;
}

describe("WorkerDelegationController integration invariants", () => {
	it("retains a caller capacity yield until every independent wait lease releases it", () => {
		const controller = controllerWithRunningCaller();
		const yieldCapacity = Reflect.get(controller, "yieldWorkerCapacity") as (
			callerAgentId: string,
			targetAgentId: string,
		) => () => void;
		const hasCapacity = Reflect.get(controller, "hasWorkerCapacity") as (settings: {
			maxConcurrent: number;
		}) => boolean;

		const releaseFirst = yieldCapacity.call(controller, "caller", "target-a");
		const releaseSecond = yieldCapacity.call(controller, "caller", "target-b");
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);

		releaseFirst();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);
		releaseFirst();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(true);

		releaseSecond();
		expect(hasCapacity.call(controller, { maxConcurrent: 1 })).toBe(false);
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
			shellSessionKeys: new Set<string>(),
			deps: { emit },
		}) as unknown as WorkerDelegationController;

		expect(() => controller.abort()).not.toThrow();
		expect(stages).toEqual(["abort", "suspend", "scheduler", "recovery", "handoffs", "reservations"]);
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
});
