import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-retry-recovery-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function startWorker(args: { agentDir: string; sessionId: string; maxAttempts: number }): {
	lifecycle: WorkerLifecycle;
	laneId: string;
	agentId: string;
	request: WorkerDelegationRequest;
} {
	const lifecycle = new WorkerLifecycle({ agentDir: args.agentDir, sessionId: args.sessionId });
	return { lifecycle, ...startWorkerInLifecycle({ ...args, lifecycle }) };
}

function startWorkerInLifecycle(args: {
	lifecycle: WorkerLifecycle;
	agentDir: string;
	sessionId: string;
	maxAttempts: number;
}): {
	laneId: string;
	agentId: string;
	request: WorkerDelegationRequest;
} {
	const { lifecycle } = args;
	const profile = createTestWorkerOrchestrationProfile({
		profileId: "retry-worker",
		model: { provider: "faux", id: "retry-model" },
	});
	profile.budget.maxAttempts = args.maxAttempts;
	const prepared = lifecycle.prepare({
		instructions: "Retry only classified transient failures.",
		executionContract: createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile, args.agentDir),
			},
		}),
		requiredCapabilities: [],
	});
	const task = lifecycle.getTask(prepared.record.laneId);
	if (!task) throw new Error("Expected a durable worker task.");
	const agentId = prepared.record.laneId;
	lifecycle.ensureAgent({
		agentId,
		role: profile.role,
		resumeContext: {
			provider: "external",
			sessionId: `agent-${args.sessionId}`,
			cwd: args.agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		},
	});
	lifecycle.bindGrant(
		prepared.attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: prepared.attempt.taskId,
			attemptId: prepared.attempt.attemptId,
			role: profile.role,
		}),
	);
	lifecycle.startAgent(prepared.record.laneId, agentId, profile.leaseTtlMs, "owner:retry-test");
	return {
		laneId: prepared.record.laneId,
		agentId,
		request: { instructions: prepared.attempt.dispatch.instructions, profileId: profile.profileId },
	};
}

function recovery(lifecycle: WorkerLifecycle, enqueue = vi.fn()): WorkerRecoveryCoordinator {
	return new WorkerRecoveryCoordinator({
		lifecycle,
		scheduler: { enqueue },
		recoverWriteReservations: vi.fn(),
		publishTerminalRecord: vi.fn(),
		dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
		recoverTaskBearingMailboxTurns: vi.fn(),
		recoverSessionRootReplies: vi.fn(),
		warn: vi.fn(),
	});
}

const transientFailure = {
	laneStatus: "failed",
	reasonCode: "completion_error",
	reasonDetail: "503 service unavailable",
};

describe("durable worker retry recovery", () => {
	it("rejects non-canonical retry deadlines before suspension", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T10:00:00.000Z"));
		const agentDir = root();
		const started = startWorker({ agentDir, sessionId: "session-invalid-deadline", maxAttempts: 3 });

		expect(() =>
			started.lifecycle.scheduleAgentRetry({
				laneId: started.laneId,
				agentId: started.agentId,
				ownerId: "owner:retry-test",
				reasonCode: "retry_scheduled:server_error",
				retry: { retriesUsed: 1, notBefore: "2026-08-07T10:01:00+00:00" },
			}),
		).toThrow("notBefore is invalid");
		expect(started.lifecycle.getActiveAttempt(started.laneId)).toMatchObject({ status: "running" });
	});

	it("recovers legacy retry suspensions that predate durable retry metadata", () => {
		const agentDir = root();
		const sessionId = "session-legacy-suspension";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 2 });
		started.lifecycle.suspendAgent(
			started.laneId,
			started.agentId,
			"owner:retry-test",
			"retry_scheduled:server_error",
		);

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		expect(restartedLifecycle.getActiveAttempt(started.laneId)?.retry).toBeUndefined();
		const enqueue = vi.fn();
		recovery(restartedLifecycle, enqueue).recover();

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ laneId: started.laneId }),
			expect.objectContaining(started.request),
			true,
			false,
		);
	});

	it("does not auto-resume a deliberately interrupted agent after restart", () => {
		const agentDir = root();
		const sessionId = "session-manual-suspension";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 2 });
		started.lifecycle.suspendAgent(started.laneId, started.agentId, "owner:retry-test", "agent_interrupted");

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const enqueue = vi.fn();
		recovery(restartedLifecycle, enqueue).recover();

		expect(enqueue).not.toHaveBeenCalled();
		expect(restartedLifecycle.getActiveAttempt(started.laneId)).toMatchObject({
			status: "suspended",
			reasonCode: "agent_interrupted",
		});
	});

	it("does not treat retained retry history as a new retry after a later manual interruption", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T11:00:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-manual-suspension-after-retry";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 3 });
		const firstOwner = recovery(started.lifecycle);
		const scheduled = firstOwner.scheduleAttemptRetry({
			laneId: started.laneId,
			agentId: started.agentId,
			ownerId: "owner:retry-test",
			request: started.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		if (!scheduled.scheduled) throw new Error("Expected the retry to be scheduled.");
		firstOwner.dispose();
		await vi.advanceTimersByTimeAsync(Date.parse(scheduled.notBefore) - Date.now());
		started.lifecycle.resumeAgent(started.laneId, started.agentId, 90_000, "owner:retry-test");
		started.lifecycle.suspendAgent(started.laneId, started.agentId, "owner:retry-test", "agent_interrupted");

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const enqueue = vi.fn();
		recovery(restartedLifecycle, enqueue).recover();

		expect(enqueue).not.toHaveBeenCalled();
		expect(restartedLifecycle.getActiveAttempt(started.laneId)).toMatchObject({
			status: "suspended",
			reasonCode: "agent_interrupted",
			retry: { retriesUsed: 1, notBefore: scheduled.notBefore },
		});
	});

	it("keeps maxAttempts exhausted after the owner process restarts", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-retry-exhaustion";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 2 });
		const firstOwner = recovery(started.lifecycle);

		const firstRetry = firstOwner.scheduleAttemptRetry({
			laneId: started.laneId,
			agentId: started.agentId,
			ownerId: "owner:retry-test",
			request: started.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 2,
		});
		expect(firstRetry).toMatchObject({ scheduled: true, retriesUsed: 1 });
		if (!firstRetry.scheduled) throw new Error("Expected the first retry to be scheduled.");
		firstOwner.dispose();

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		await vi.advanceTimersByTimeAsync(Date.parse(firstRetry.notBefore) - Date.now());
		restartedLifecycle.resumeAgent(started.laneId, started.agentId, 90_000, "owner:retry-test");
		const restartedOwner = recovery(restartedLifecycle);

		expect(
			restartedOwner.scheduleAttemptRetry({
				laneId: started.laneId,
				agentId: started.agentId,
				ownerId: "owner:retry-test",
				request: started.request,
				outcome: transientFailure,
				provider: "faux",
				maxAttempts: 2,
			}),
		).toEqual({ scheduled: false, reason: "attempts_exhausted" });
		expect(restartedLifecycle.getActiveAttempt(started.laneId)).toMatchObject({
			status: "running",
			retry: { retriesUsed: 1 },
		});
		restartedLifecycle.cancel(started.laneId, "attempts_exhausted");
		expect(restartedLifecycle.getActiveAttempt(started.laneId)).toMatchObject({ status: "cancelled" });
		expect(restartedLifecycle.getActiveAttempt(started.laneId)?.retry).toBeUndefined();
	});

	it("retains the not-before deadline and rejects early resume after restart", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T13:00:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-retry-delay";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 3 });
		const firstOwner = recovery(started.lifecycle);

		const firstRetry = firstOwner.scheduleAttemptRetry({
			laneId: started.laneId,
			agentId: started.agentId,
			ownerId: "owner:retry-test",
			request: started.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		if (!firstRetry.scheduled) throw new Error("Expected the first retry to be scheduled.");
		const persisted = started.lifecycle.getActiveAttempt(started.laneId);
		expect(persisted).toMatchObject({
			status: "suspended",
			retry: { retriesUsed: 1, notBefore: firstRetry.notBefore },
		});
		firstOwner.dispose();

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const enqueue = vi.fn();
		const restartedOwner = recovery(restartedLifecycle, enqueue);
		restartedOwner.recover();
		expect(enqueue).not.toHaveBeenCalled();
		expect(() => restartedLifecycle.resumeAgent(started.laneId, started.agentId, 90_000, "owner:retry-test")).toThrow(
			/retry backoff/i,
		);

		const retainedDelayMs = Date.parse(firstRetry.notBefore) - Date.now();
		await vi.advanceTimersByTimeAsync(retainedDelayMs - 1);
		expect(enqueue).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ laneId: started.laneId }),
			expect.objectContaining(started.request),
			true,
			false,
		);
		restartedOwner.recover();
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("reconciles a restart after resume was requested but before the attempt received its lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T13:15:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-resume-request-crash";
		const started = startWorker({ agentDir, sessionId, maxAttempts: 3 });
		const firstOwner = recovery(started.lifecycle);
		const scheduled = firstOwner.scheduleAttemptRetry({
			laneId: started.laneId,
			agentId: started.agentId,
			ownerId: "owner:retry-test",
			request: started.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		if (!scheduled.scheduled) throw new Error("Expected the retry to be scheduled.");
		firstOwner.dispose();
		await vi.advanceTimersByTimeAsync(Date.parse(scheduled.notBefore) - Date.now());
		const suspended = started.lifecycle.getActiveAttempt(started.laneId);
		if (!suspended) throw new Error("Expected a suspended retry attempt.");

		started.lifecycle.ledger.runtime.requestAgentResume(started.agentId, suspended.attemptId);
		const requestedSnapshot = started.lifecycle.getTaskRuntimeSnapshot();
		expect(requestedSnapshot.agents[started.agentId]).toMatchObject({
			status: "resuming",
			activeAttemptId: suspended.attemptId,
		});
		expect(started.lifecycle.getActiveAttempt(started.laneId)).toMatchObject({ status: "suspended" });
		expect(started.lifecycle.ledger.runtime.requestAgentResume(started.agentId, suspended.attemptId)).toMatchObject({
			status: "resuming",
		});
		expect(started.lifecycle.getTaskRuntimeSnapshot().lastOrdinal).toBe(requestedSnapshot.lastOrdinal);

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const enqueue = vi.fn();
		const restartedOwner = recovery(restartedLifecycle, enqueue);
		restartedOwner.recover();
		expect(enqueue).toHaveBeenCalledTimes(1);

		const resumed = restartedLifecycle.resumeAgent(started.laneId, started.agentId, 90_000, "owner:retry-test");
		expect(resumed.fencingToken).toBe((suspended.lease?.fencingToken ?? 0) + 1);
		expect(restartedLifecycle.getActiveAttempt(started.laneId)).toMatchObject({ status: "running" });
		restartedOwner.dispose();
	});

	it("reserves the final retry queue slot only for verifier work during an early post-restart wake", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T13:30:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-early-retry-priority";
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const ordinary = startWorkerInLifecycle({
			lifecycle,
			agentDir,
			sessionId: `${sessionId}-ordinary`,
			maxAttempts: 3,
		});
		const verifier = startWorkerInLifecycle({
			lifecycle,
			agentDir,
			sessionId: `${sessionId}-verifier`,
			maxAttempts: 3,
		});
		const firstOwner = recovery(lifecycle);
		const ordinaryRetry = firstOwner.scheduleAttemptRetry({
			laneId: ordinary.laneId,
			agentId: ordinary.agentId,
			ownerId: "owner:retry-test",
			request: ordinary.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		const verifierRequest = { ...verifier.request, verificationOfTaskId: "verification-subject" };
		const verifierRetry = firstOwner.scheduleAttemptRetry({
			laneId: verifier.laneId,
			agentId: verifier.agentId,
			ownerId: "owner:retry-test",
			request: verifierRequest,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		if (!ordinaryRetry.scheduled || !verifierRetry.scheduled) throw new Error("Expected both retries to schedule.");
		firstOwner.dispose();

		const restartedLifecycle = new WorkerLifecycle({ agentDir, sessionId });
		let occupiedSlots = DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
		const accepted: Array<{ laneId: string; priority: boolean }> = [];
		const capacityListeners = new Set<() => void>();
		const scheduler = {
			enqueue(record: LaneRecord, _request: WorkerDelegationRequest, _recovered = false, priority = false): void {
				const ceiling = priority
					? DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches
					: DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
				if (occupiedSlots >= ceiling) throw new Error("worker_dispatch_queue_full");
				occupiedSlots += 1;
				accepted.push({ laneId: record.laneId, priority });
			},
			onQueueCapacityAvailable(listener: () => void): () => void {
				capacityListeners.add(listener);
				return () => capacityListeners.delete(listener);
			},
		};
		const restartedOwner = new WorkerRecoveryCoordinator({
			lifecycle: restartedLifecycle,
			scheduler,
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});
		const ordinaryRecord = restartedLifecycle.getRecord(ordinary.laneId);
		const verifierRecord = restartedLifecycle.getRecord(verifier.laneId);
		if (!ordinaryRecord || !verifierRecord) throw new Error("Expected retained retry records.");
		expect(restartedOwner.deferRetryIfNeeded(ordinaryRecord, ordinary.request)).toBe(true);
		expect(restartedOwner.deferRetryIfNeeded(verifierRecord, verifierRequest)).toBe(true);

		await vi.advanceTimersByTimeAsync(
			Math.max(Date.parse(ordinaryRetry.notBefore), Date.parse(verifierRetry.notBefore)) - Date.now(),
		);
		expect(accepted).toEqual([{ laneId: verifier.laneId, priority: true }]);
		expect(restartedLifecycle.getActiveAttempt(ordinary.laneId)).toMatchObject({ status: "suspended" });

		occupiedSlots -= 2;
		for (const listener of capacityListeners) listener();
		expect(accepted).toEqual([
			{ laneId: verifier.laneId, priority: true },
			{ laneId: ordinary.laneId, priority: false },
		]);
		restartedOwner.dispose();
	});

	it("retains two due ordinary retries without consuming the reserved verifier slot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T14:00:00.000Z"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const agentDir = root();
		const sessionId = "session-retry-queue-saturation";
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const first = startWorkerInLifecycle({ lifecycle, agentDir, sessionId: `${sessionId}-first`, maxAttempts: 3 });
		const second = startWorkerInLifecycle({ lifecycle, agentDir, sessionId: `${sessionId}-second`, maxAttempts: 3 });
		let occupiedSlots = DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
		const accepted: Array<{ laneId: string; recovered: boolean; priority: boolean }> = [];
		const capacityListeners = new Set<() => void>();
		const scheduler = {
			enqueue(record: LaneRecord, _request: WorkerDelegationRequest, recovered = false, priority = false): void {
				const ceiling = priority
					? DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches
					: DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
				if (occupiedSlots >= ceiling) {
					throw new Error("worker_dispatch_queue_full");
				}
				occupiedSlots += 1;
				accepted.push({ laneId: record.laneId, recovered, priority });
			},
			onQueueCapacityAvailable(listener: () => void): () => void {
				capacityListeners.add(listener);
				return () => capacityListeners.delete(listener);
			},
		};
		const retryReady = vi.fn();
		const coordinator = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler,
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			retryReady,
			warn: vi.fn(),
		});

		const firstRetry = coordinator.scheduleAttemptRetry({
			laneId: first.laneId,
			agentId: first.agentId,
			ownerId: "owner:retry-test",
			request: first.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		const secondRetry = coordinator.scheduleAttemptRetry({
			laneId: second.laneId,
			agentId: second.agentId,
			ownerId: "owner:retry-test",
			request: second.request,
			outcome: transientFailure,
			provider: "faux",
			maxAttempts: 3,
		});
		expect(firstRetry.scheduled).toBe(true);
		expect(secondRetry.scheduled).toBe(true);
		if (!firstRetry.scheduled || !secondRetry.scheduled) throw new Error("Expected both retries to be scheduled.");

		await vi.advanceTimersByTimeAsync(
			Math.max(Date.parse(firstRetry.notBefore), Date.parse(secondRetry.notBefore)) - Date.now(),
		);
		expect(accepted).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		expect(lifecycle.getActiveAttempt(first.laneId)).toMatchObject({ status: "suspended" });
		expect(lifecycle.getActiveAttempt(second.laneId)).toMatchObject({ status: "suspended" });

		occupiedSlots -= 2;
		for (const listener of capacityListeners) listener();
		expect(accepted).toEqual([
			{ laneId: first.laneId, recovered: true, priority: false },
			{ laneId: second.laneId, recovered: true, priority: false },
		]);
		expect(retryReady).toHaveBeenCalledTimes(2);
		coordinator.dispose();
	});

	it("re-enters unfinished durable queue recovery when ordinary capacity is released", () => {
		const agentDir = root();
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-recovered-queue-saturation" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "recovered-queue-worker",
			model: { provider: "faux", id: "retry-model" },
		});
		const executionContract = createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile, agentDir),
			},
		});
		const laneIds: string[] = [];
		for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches; index += 1) {
			laneIds.push(
				lifecycle.prepare({
					instructions: `Recover durable queued worker ${index}.`,
					executionContract,
					requiredCapabilities: [],
				}).record.laneId,
			);
		}
		const queued = new Set<string>();
		const capacityListeners = new Set<() => void>();
		const scheduler = {
			enqueue(record: LaneRecord, _request: WorkerDelegationRequest, _recovered = false, priority = false): void {
				if (queued.has(record.laneId)) return;
				const ceiling = priority
					? DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches
					: DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
				if (queued.size >= ceiling) throw new Error("worker_dispatch_queue_full");
				queued.add(record.laneId);
			},
			onQueueCapacityAvailable(listener: () => void): () => void {
				capacityListeners.add(listener);
				return () => capacityListeners.delete(listener);
			},
		};
		const coordinator = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler,
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});

		expect(() => coordinator.recover()).not.toThrow();
		expect(queued.size).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1);
		const retainedLaneId = laneIds.find((laneId) => !queued.has(laneId));
		if (!retainedLaneId) throw new Error("Expected one retained durable dispatch.");

		lifecycle.cancel(laneIds[0]!, "test_slot_released");
		queued.delete(laneIds[0]!);
		for (const listener of capacityListeners) listener();
		expect(queued.size).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1);
		expect(queued.has(retainedLaneId)).toBe(true);
		coordinator.dispose();
	});
});
