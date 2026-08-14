import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerDelegationController } from "../src/core/delegation/worker-delegation-controller.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerWriteReservationCoordinator } from "../src/core/delegation/worker-write-reservation-coordinator.ts";
import { type AgentBindingContract, ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function agent(agentId: string, activeAttemptId: string): AgentBindingContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		agentId,
		rootAgentId: agentId,
		depth: 0,
		role: "implementer",
		status: "active",
		activeAttemptId,
		resumeContext: {
			provider: "pi",
			sessionId: `session-${agentId}`,
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		},
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-12T00:00:00.000Z",
	};
}

function attempt(agentId: string, taskId: string, status: AttemptRuntimeState["status"]): AttemptRuntimeState {
	return {
		attemptId: `attempt-${agentId}`,
		taskId,
		agentId,
		dispatch: {
			provider: "pi",
			taskId,
			logicalLaneId: agentId,
			instructions: "work",
			profileId: "implementer",
			resourcePointerIds: [],
		},
		status,
		checkpointIds: [],
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-12T00:00:00.000Z",
	};
}

function waitCoordinator(
	waitBlockedByCaller?: (callerAgentId: string, targetAgentIds: readonly string[]) => readonly string[],
	yieldCallerForWait?: (callerAgentId: string) => () => boolean | undefined,
	childStatus: () => AttemptRuntimeState["status"] = () => "queued",
	subscribeReservationAvailability?: (listener: () => void) => () => void,
): WorkerAgentControlCoordinator {
	const callerAttempt = attempt("caller", "caller-task", "running");
	const childAttempt = attempt("child", "child-task", "queued");
	const caller = agent("caller", callerAttempt.attemptId);
	const child = agent("child", childAttempt.attemptId);
	const snapshot = (): TaskRuntimeProjection => {
		const currentChildAttempt = { ...childAttempt, status: childStatus() };
		return {
			agents: { caller, child },
			tasks: {
				[callerAttempt.taskId]: { attemptIds: [callerAttempt.attemptId] },
				[childAttempt.taskId]: { attemptIds: [childAttempt.attemptId] },
			},
			attempts: {
				[callerAttempt.attemptId]: callerAttempt,
				[childAttempt.attemptId]: currentChildAttempt,
			},
		} as unknown as TaskRuntimeProjection;
	};
	const lifecycle = {
		getAgent: (agentId: string) => ({ caller, child })[agentId as "caller" | "child"],
		getTaskRuntimeSnapshot: snapshot,
	} as unknown as WorkerLifecycle;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-wait-deadlock-"));
	temporaryDirectories.push(agentDir);
	return new WorkerAgentControlCoordinator({
		agentDir,
		parentSessionId: "parent-wait-deadlock",
		processOwnerId: "pi-worker:1:owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		recoveredRequest: () => ({ instructions: "unused" }),
		run: async () => ({ started: false, skipReason: "unused" }),
		scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
		statusChanged: vi.fn(),
		abortLane: vi.fn(),
		cancelLane: vi.fn(),
		...(waitBlockedByCaller ? { waitBlockedByCaller } : {}),
		...(yieldCallerForWait ? { yieldCallerForWait } : {}),
		...(subscribeReservationAvailability ? { subscribeReservationAvailability } : {}),
	} as ConstructorParameters<typeof WorkerAgentControlCoordinator>[0]);
}

describe("worker wait deadlock prevention", () => {
	it("rejects a worker waiting for itself before installing a timed wait", async () => {
		const coordinator = waitCoordinator();

		await expect(
			Promise.resolve().then(() =>
				coordinator.waitForWorkerAgents(["caller"], "all", 1, { callerAgentId: "caller" }),
			),
		).rejects.toThrow("cannot wait for itself");
	});

	it("evaluates the deadlock condition before yielding, so a genuinely blocked target rejects and never yields", async () => {
		// Root-cause regression: yieldCallerForWait releases the caller's write reservation
		// (WorkerWriteReservationCoordinator.forgetLease), which erases the exact
		// blockedByLocalLaneIds entries waitBlockedByCaller inspects. Checking after yielding
		// always finds nothing blocked (the block was just released), so the deadlock guard could
		// never fire. The check must run on the PRE-yield state, before any yielding happens.
		vi.useFakeTimers();
		try {
			const waitBlockedByCaller = vi.fn(() => ["child"]);
			const restore = vi.fn(() => true);
			const yieldCallerForWait = vi.fn(() => restore);
			const coordinator = waitCoordinator(waitBlockedByCaller, yieldCallerForWait);

			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });

			expect(waitBlockedByCaller).toHaveBeenCalledWith("caller", ["child"]);
			expect(yieldCallerForWait).not.toHaveBeenCalled();
			await expect(waiting).rejects.toThrow("Worker wait would deadlock");
			expect(restore).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("yields and waits normally once the pre-yield deadlock check finds no blocked target", async () => {
		vi.useFakeTimers();
		try {
			const waitBlockedByCaller = vi.fn(() => []);
			const restore = vi.fn(() => true);
			const yieldCallerForWait = vi.fn(() => restore);
			const coordinator = waitCoordinator(waitBlockedByCaller, yieldCallerForWait);

			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });
			expect(waitBlockedByCaller).toHaveBeenCalledWith("caller", ["child"]);
			expect(yieldCallerForWait).toHaveBeenCalledWith("caller");
			await vi.advanceTimersByTimeAsync(1);

			await expect(waiting).resolves.toMatchObject({ timedOut: true });
			expect(restore).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not return a timed-out wait until the caller's yielded resources are restored", async () => {
		vi.useFakeTimers();
		try {
			const restore = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
			const coordinator = waitCoordinator(undefined, () => restore);
			let resolved = false;
			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });
			void waiting.then(() => {
				resolved = true;
			});

			await vi.advanceTimersByTimeAsync(1);
			expect(resolved).toBe(false);
			expect(restore).toHaveBeenCalledOnce();

			coordinator.signalStateChanged();
			await expect(waiting).resolves.toMatchObject({ timedOut: true });
			expect(restore).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a blocked restore from the reservation-availability event, not a 1s poll", async () => {
		// subscribeStateChanges is not a wakeup for write-reservation release. The 1s poll that
		// used to sit here was a workaround: reservation release already has an in-process event
		// (notifyAvailability / subscribeAvailability). A swarm wait must resume on that event.
		vi.useFakeTimers();
		try {
			const restore = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
			const availabilityListeners = new Set<() => void>();
			const coordinator = waitCoordinator(
				undefined,
				() => restore,
				undefined,
				(listener) => {
					availabilityListeners.add(listener);
					return () => {
						availabilityListeners.delete(listener);
					};
				},
			);
			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });

			await vi.advanceTimersByTimeAsync(1);
			expect(restore).toHaveBeenCalledOnce();

			// Two seconds of virtual time with no reservation event must not retry. The poll is gone.
			await vi.advanceTimersByTimeAsync(2_000);
			expect(restore).toHaveBeenCalledOnce();

			for (const listener of availabilityListeners) listener();
			await expect(waiting).resolves.toMatchObject({ timedOut: true });
			expect(restore).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects instead of hanging forever when a blocked restore never clears within its retry bound", async () => {
		vi.useFakeTimers();
		try {
			const restore = vi.fn(() => false); // never restores
			const coordinator = waitCoordinator(undefined, () => restore);
			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });
			let settledState: "pending" | "resolved" | "rejected" = "pending";
			void waiting.then(
				() => {
					settledState = "resolved";
				},
				() => {
					settledState = "rejected";
				},
			);

			await vi.advanceTimersByTimeAsync(1);
			expect(settledState).toBe("pending");

			// Well past the retry bound; still no signalStateChanged() call anywhere.
			await vi.advanceTimersByTimeAsync(310_000);

			expect(settledState).toBe("rejected");
			await expect(waiting).rejects.toThrow(/could not restore the caller's write reservation/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not overwrite a pre-deadline completion while restoration remains blocked past the deadline", async () => {
		vi.useFakeTimers();
		try {
			let status: AttemptRuntimeState["status"] = "queued";
			const restore = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
			const coordinator = waitCoordinator(
				undefined,
				() => restore,
				() => status,
			);
			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 100, { callerAgentId: "caller" });

			status = "completed";
			coordinator.signalStateChanged();
			expect(restore).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(100);
			expect(restore).toHaveBeenCalledOnce();

			coordinator.signalStateChanged();
			expect(restore).toHaveBeenCalledTimes(2);
			coordinator.signalStateChanged();
			await expect(waiting).resolves.toEqual({
				statuses: [{ agentId: "child", status: "idle" }],
				updatedAgentIds: ["child"],
				timedOut: false,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains exact local reservation blockers and clears them when the blocker releases", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-wait-reservation-"));
		temporaryDirectories.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		mkdirSync(source, { recursive: true });
		const coordinator = new WorkerWriteReservationCoordinator({
			agentDir: join(root, "agent"),
			getCwd: () => workspace,
			getParentSessionId: () => "parent-reservation",
			ownerId: "pi-worker:123:11111111-1111-4111-8111-111111111111",
			drainQueuedWorkers: vi.fn(),
			warn: vi.fn(),
		});
		const plan = { writeEnabled: true, writePaths: [source] };

		expect(coordinator.acquire("caller-task", { attemptId: "caller-attempt" }, plan)).toEqual({
			kind: "granted",
		});
		expect(coordinator.acquire("child-task", { attemptId: "child-attempt" }, plan)).toEqual({
			kind: "blocked",
		});
		const reservationState = coordinator as unknown as {
			isBlockedBy(targetLaneId: string, blockerLaneId: string): boolean;
		};
		expect(reservationState.isBlockedBy("child-task", "caller-task")).toBe(true);
		expect(reservationState.isBlockedBy("child-task", "other-task")).toBe(false);

		coordinator.release("caller-task");
		expect(reservationState.isBlockedBy("child-task", "caller-task")).toBe(false);
		coordinator.dispose();
	});

	it("yields and restores the exact caller reservation around a child writer", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-wait-reservation-yield-"));
		temporaryDirectories.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		mkdirSync(source, { recursive: true });
		const coordinator = new WorkerWriteReservationCoordinator({
			agentDir: join(root, "agent"),
			getCwd: () => workspace,
			getParentSessionId: () => "parent-reservation-yield",
			ownerId: "pi-worker:123:11111111-1111-4111-8111-111111111111",
			drainQueuedWorkers: vi.fn(),
			warn: vi.fn(),
		});
		const plan = { writeEnabled: true, writePaths: [source] };

		expect(coordinator.acquire("caller-task", { attemptId: "caller-attempt" }, plan)).toEqual({
			kind: "granted",
		});
		expect(coordinator.acquire("child-task", { attemptId: "child-attempt" }, plan)).toEqual({ kind: "blocked" });

		const yielded = coordinator.yieldForWait("caller-task", "caller-attempt", 1);
		expect(yielded).toBeDefined();
		expect(coordinator.acquire("child-task", { attemptId: "child-attempt" }, plan)).toEqual({ kind: "granted" });
		expect(coordinator.restoreAfterWait(yielded!)).toEqual({ kind: "blocked" });

		coordinator.release("child-task");
		expect(coordinator.restoreAfterWait(yielded!)).toEqual({ kind: "granted" });
		expect(coordinator.acquire("competitor-task", { attemptId: "competitor-attempt" }, plan)).toEqual({
			kind: "blocked",
		});
		coordinator.release("caller-task");
		coordinator.dispose();
	});

	it("wakes a blocked wait restore from the real reservation release event", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-wait-reservation-event-"));
		temporaryDirectories.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		mkdirSync(source, { recursive: true });
		const reservations = new WorkerWriteReservationCoordinator({
			agentDir: join(root, "agent"),
			getCwd: () => workspace,
			getParentSessionId: () => "parent-reservation-event",
			ownerId: "pi-worker:123:11111111-1111-4111-8111-111111111111",
			drainQueuedWorkers: vi.fn(),
			warn: vi.fn(),
		});
		const plan = { writeEnabled: true, writePaths: [source] };
		expect(reservations.acquire("caller-task", { attemptId: "caller-attempt" }, plan)).toEqual({
			kind: "granted",
		});
		const yielded = reservations.yieldForWait("caller-task", "caller-attempt", 1);
		expect(yielded).toBeDefined();
		expect(reservations.acquire("child-task", { attemptId: "child-attempt" }, plan)).toEqual({ kind: "granted" });

		vi.useFakeTimers();
		try {
			const coordinator = waitCoordinator(
				undefined,
				() => () => reservations.restoreAfterWait(yielded!).kind === "granted",
				undefined,
				(listener) => reservations.subscribeAvailability(listener),
			);
			const waiting = coordinator.waitForWorkerAgents(["child"], "all", 1, { callerAgentId: "caller" });
			await vi.advanceTimersByTimeAsync(1);
			let settled = false;
			void waiting.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(2_000);
			expect(settled).toBe(false);

			reservations.release("child-task");
			await Promise.resolve();
			await expect(waiting).resolves.toMatchObject({ timedOut: true });
			expect(reservations.restoreAfterWait(yielded!)).toEqual({ kind: "granted" });
		} finally {
			vi.useRealTimers();
			reservations.dispose();
		}
	});

	it("releases every held lease on dispose() instead of only forgetting them in memory", () => {
		// Root-cause regression: dispose() dropped this coordinator's in-memory `leases` map without
		// ever releasing the underlying durable reservations -- a competitor blocked by one of them
		// stayed blocked forever (until an unrelated recoverProvenStale() pass eventually proved the
		// owner dead), even though this process had already explicitly disposed the coordinator.
		const root = mkdtempSync(join(tmpdir(), "pi-worker-wait-reservation-dispose-"));
		temporaryDirectories.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		mkdirSync(source, { recursive: true });
		const agentDir = join(root, "agent");
		const coordinator = new WorkerWriteReservationCoordinator({
			agentDir,
			getCwd: () => workspace,
			getParentSessionId: () => "parent-reservation-dispose",
			ownerId: "pi-worker:123:11111111-1111-4111-8111-111111111111",
			drainQueuedWorkers: vi.fn(),
			warn: vi.fn(),
		});
		const plan = { writeEnabled: true, writePaths: [source] };

		expect(coordinator.acquire("caller-task", { attemptId: "caller-attempt" }, plan)).toEqual({
			kind: "granted",
		});
		expect(coordinator.acquire("competitor-task", { attemptId: "competitor-attempt" }, plan)).toEqual({
			kind: "blocked",
		});

		coordinator.dispose();

		// A fresh coordinator instance (simulating the durable store surviving a process restart)
		// must see the reservation as released, not still held by the disposed owner.
		const afterDispose = new WorkerWriteReservationCoordinator({
			agentDir,
			getCwd: () => workspace,
			getParentSessionId: () => "parent-reservation-dispose",
			ownerId: "pi-worker:123:11111111-1111-4111-8111-111111111111",
			drainQueuedWorkers: vi.fn(),
			warn: vi.fn(),
		});
		expect(afterDispose.acquire("competitor-task", { attemptId: "competitor-attempt" }, plan)).toEqual({
			kind: "granted",
		});
		afterDispose.dispose();
	});

	it("maps logical wait targets to the exact blocked task lanes", () => {
		const callerAttempt = attempt("caller", "caller-task", "running");
		const childAttempt = attempt("child", "child-task", "queued");
		const caller = agent("caller", callerAttempt.attemptId);
		const child = agent("child", childAttempt.attemptId);
		const isBlockedBy = vi.fn((targetLaneId: string, blockerLaneId: string) => {
			return targetLaneId === "child-task" && blockerLaneId === "caller-task";
		});
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			lifecycle: {
				getAgent: (agentId: string) => ({ caller, child })[agentId as "caller" | "child"],
				getLatestAgentAttempt: (agentId: string) => (agentId === "caller" ? callerAttempt : childAttempt),
			},
			writeReservations: { isBlockedBy },
		}) as unknown as WorkerDelegationController;
		const waitTargetsBlockedByCaller = Reflect.get(controller, "waitTargetsBlockedByCaller") as (
			callerAgentId: string,
			targetAgentIds: readonly string[],
		) => readonly string[];

		expect(waitTargetsBlockedByCaller.call(controller, "caller", ["child", "missing"])).toEqual(["child"]);
		expect(isBlockedBy).toHaveBeenCalledWith("child-task", "caller-task");
	});
});
