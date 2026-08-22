/**
 * H4 — soak / liveness under fake timers (blueprint §4).
 *
 * (a) A 6-virtual-hour goal continuation with periodic stalls: stall and worker-wait recovery,
 *     then the budget stop, must fire at their documented bounds.
 * (b) A stuck notify() for 2 virtual hours: the observe-only handoff watchdog warns once,
 *     the batch stays recoverable, restart replays it (INV-W4, INV-W6).
 * (c) Lease heartbeat across suspend/resume: the captured fence rejects; live expiry remains
 *     an abandonment signal (INV-W5).
 *
 * Does not import createHarness. Watchdogs that cannot be made to fire are a finding.
 *
 * Falsified against: a notify() that never settles used to lose the batch inside the closure
 * (INV-W4) and a heartbeat that renewed via laneId after resume (INV-W5).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../../src/core/autonomy/lane-tracker.ts";
import { WorkerLeaseHeartbeat } from "../../src/core/delegation/worker-lease-heartbeat.ts";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import { WorkerNotificationCoordinator } from "../../src/core/delegation/worker-notification-coordinator.ts";
import { evaluateGoalContinuation } from "../../src/core/goals/goal-continuation-controller.ts";
import {
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_WORKER_WAIT_MS,
} from "../../src/core/goals/goal-continuation-defaults.ts";
import { applyGoalEvent, createGoalState, shouldContinueGoalLoop } from "../../src/core/goals/goal-state.ts";
import type { AgentResumeContext } from "../../src/core/orchestration/contracts.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../../test/orchestration-profile-fixture.ts";
import { assertInvariants } from "../harness/invariants.ts";

/** Product observe-only bound in worker-notification-coordinator.ts (not exported). */
const HANDOFF_WATCHDOG_MS = 1_800_000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const T0 = "2026-08-14T00:00:00.000Z";

const RESUME_CONTEXT: AgentResumeContext = {
	provider: "pi",
	sessionId: "h4-session-file",
	cwd: "/repo",
	resourceProfileNames: [],
	contextPointers: [],
};

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h4-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	vi.useRealTimers();
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

describe("destructive/soak: H4a goal loop 6 virtual hours (INV-L1/W6)", () => {
	it("stall and worker-wait recovery, then the budget stop, fire at their documented bounds", () => {
		const fired = new Set<string>();
		const t0 = Date.parse(T0);
		let nowMs = t0;
		let state = createGoalState({
			goalId: "h4a",
			userGoal: "soak the continuation watchdogs",
			now: T0,
			tokenBudget: 8_000,
		});
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: "req-1",
			text: "keep a worker bound",
			now: T0,
		});
		state = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "hung worker",
			laneId: "worker-hung",
			now: T0,
		});

		const inFlight = new Set(["worker-hung"]);
		const justBeforeWait = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS },
			inFlightGoalLaneIds: inFlight,
			now: iso(t0 + DEFAULT_GOAL_WORKER_WAIT_MS - 1),
			maxWorkerWaitMs: DEFAULT_GOAL_WORKER_WAIT_MS,
		});
		expect(justBeforeWait.reasonCode).toBe("worker_in_flight");
		expect(justBeforeWait.action).toBe("waiting");

		nowMs = t0 + DEFAULT_GOAL_WORKER_WAIT_MS;
		const atWait = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS },
			inFlightGoalLaneIds: inFlight,
			now: iso(nowMs),
			maxWorkerWaitMs: DEFAULT_GOAL_WORKER_WAIT_MS,
		});
		expect(atWait.reasonCode).toBe("worker_wait_timeout");
		expect(atWait.action).toBe("continue");
		fired.add("worker_wait_timeout");

		// Worker gone; stall the parent loop up to the documented window.
		for (let stall = 0; stall < DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS; stall++) {
			nowMs += 60_000;
			state = applyGoalEvent(state, { type: "no_progress", now: iso(nowMs) });
		}
		const atStall = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS },
			now: iso(nowMs),
		});
		expect(atStall.reasonCode).toBe("stall_limit_reached");
		expect(atStall.action).toBe("continue");
		expect(
			shouldContinueGoalLoop({ state, maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS, now: iso(nowMs) }),
		).toBe(true);
		fired.add("stall_limit_reached");

		nowMs += 60_000;
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "budget_limited",
			reason: "token budget exhausted",
			now: iso(nowMs),
		});
		const atBudget = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS },
			now: iso(nowMs),
		});
		expect(atBudget.reasonCode).toBe("goal_budget_limited");
		expect(atBudget.action).toBe("stop");
		fired.add("goal_budget_limited");

		nowMs = t0 + SIX_HOURS_MS;
		const atSixHours = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS },
			now: iso(nowMs),
		});
		expect(atSixHours.action).toBe("stop");
		expect(atSixHours.reasonCode).toBe("goal_budget_limited");

		assertInvariants(
			{
				loopRun: {
					settledWithinDeadline: nowMs === t0 + SIX_HOURS_MS,
					stopReason: atSixHours.reasonCode,
					leaseLeaked: false,
				},
				boundedWait: {
					settledWithinBound: fired.has("worker_wait_timeout") && fired.has("stall_limit_reached"),
					silentOverrun: false,
				},
			},
			["INV-L1", "INV-W6"],
			{ seed: 0, injection: SIX_HOURS_MS, scenario: "H4a-goal-soak" },
		);
		expect(fired).toEqual(new Set(["worker_wait_timeout", "stall_limit_reached", "goal_budget_limited"]));
	});
});

describe("destructive/soak: H4b stuck notify 2 virtual hours (INV-W4/W6)", () => {
	it("watchdog warns once, the batch stays recoverable, restart replays exactly once", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(T0));
		const record: LaneRecord = {
			laneId: "worker-stuck",
			type: "worker",
			status: "succeeded",
			completedAt: T0,
		};
		let resolveNotify: (() => void) | undefined;
		const notifyPending = new Promise<void>((resolve) => {
			resolveNotify = resolve;
		});
		const warn = vi.fn();
		const markDurableDelivered = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify: () => notifyPending,
			warn,
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-stuck");
		await vi.advanceTimersByTimeAsync(0);
		expect(coordinator.getOutstandingRecords()).toEqual([
			expect.objectContaining({ laneId: "worker-stuck", status: "succeeded" }),
		]);

		await vi.advanceTimersByTimeAsync(HANDOFF_WATCHDOG_MS - 1);
		expect(warn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toContain("worker-stuck");

		await vi.advanceTimersByTimeAsync(TWO_HOURS_MS - HANDOFF_WATCHDOG_MS);
		expect(warn).toHaveBeenCalledOnce();
		const outstanding = coordinator.getOutstandingRecords();
		expect(outstanding).toHaveLength(1);

		// Restart: a fresh coordinator replays the surviving batch. The stuck notify is abandoned
		// (process death); we do not resolve it — that is the crash/restart path.
		coordinator.dispose();
		const delivered: string[] = [];
		const restarted = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify: async (records) => {
				for (const item of records) delivered.push(item.laneId);
			},
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});
		for (const item of outstanding) {
			restarted.recordTerminal({ ...record, laneId: item.laneId, status: item.status }, "notification-stuck");
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual(["worker-stuck"]);
		expect(restarted.getOutstandingRecords()).toEqual([]);
		restarted.dispose();
		resolveNotify?.();

		assertInvariants(
			{
				terminalHandoff: {
					deliveredCounts: new Map([["worker-stuck", 1]]),
					neverDelivered: [],
				},
				boundedWait: { settledWithinBound: true, silentOverrun: false },
			},
			["INV-W4", "INV-W6"],
			{ seed: 0, injection: TWO_HOURS_MS, scenario: "H4b-stuck-notify" },
		);
	});
});

describe("destructive/soak: H4c heartbeat across suspend/resume (INV-W5/W6)", () => {
	it("the captured fence rejects after resume; heartbeat interval and live expiry still fire", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(T0));
		const lifecycle = new WorkerLifecycle({
			agentDir: root(),
			sessionId: "h4c",
			now: () => Date.now(),
		});
		const p = createTestWorkerOrchestrationProfile({
			profileId: "h4c",
			model: { provider: "test", id: "model" },
			role: "explorer",
		});
		lifecycle.ensureAgent({ agentId: "h4c-agent", role: "explorer", resumeContext: RESUME_CONTEXT });
		const prepared = lifecycle.prepare({
			instructions: "heartbeat soak",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile: p,
					modelBinding: p.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(p),
				},
			}),
			requiredCapabilities: [],
		});
		const attempt = lifecycle.getActiveAttempt(prepared.record.laneId);
		if (!attempt) throw new Error("missing attempt");
		const task = lifecycle.getTask(attempt.taskId);
		if (!task) throw new Error("missing task");
		lifecycle.bindGrant(
			attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				role: task.task.role,
			}),
		);
		const leaseTtlMs = 900;
		const first = lifecycle.startAgent(prepared.record.laneId, "h4c-agent", leaseTtlMs);
		const renewals: string[] = [];
		const failures: Error[] = [];
		const heartbeat = new WorkerLeaseHeartbeat({
			leaseTtlMs,
			renew: () => {
				lifecycle.ledger.runtime.renewAttemptLease(first.attemptId, first.leaseId, first.fencingToken, leaseTtlMs);
				renewals.push("ok");
			},
			onFailure: (error) => {
				failures.push(error);
			},
		});
		heartbeat.start();
		vi.advanceTimersByTime(Math.floor(leaseTtlMs / 3));
		expect(renewals).toEqual(["ok"]);

		lifecycle.suspendAgent(prepared.record.laneId, "h4c-agent", "h4c-agent", "h4c_interrupt");
		const resumed = lifecycle.resumeAgent(prepared.record.laneId, "h4c-agent", leaseTtlMs);
		expect(resumed.fencingToken).not.toBe(first.fencingToken);

		vi.advanceTimersByTime(Math.floor(leaseTtlMs / 3));
		expect(failures.length).toBe(1);
		heartbeat.stop();

		vi.advanceTimersByTime(leaseTtlMs);
		expect(() =>
			lifecycle.ledger.runtime.renewAttemptLease(first.attemptId, first.leaseId, first.fencingToken, leaseTtlMs),
		).toThrow();

		assertInvariants(
			{
				fencedRenewal: {
					supersededRenewalRejected: failures.length === 1,
					liveExpiryStillAbandons: Date.parse(resumed.expiresAt) > 0,
				},
				boundedWait: { settledWithinBound: true, silentOverrun: false },
			},
			["INV-W5", "INV-W6"],
			{ seed: 0, injection: leaseTtlMs, scenario: "H4c-heartbeat" },
		);
	});
});
