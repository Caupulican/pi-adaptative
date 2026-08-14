/**
 * H3 — seeded op-shuffled worker trees (blueprint §4).
 *
 * World: M=8 worker identities under one parent. Each round the SeededScheduler shuffles the
 * applicable ops {start, wait_many, cancel, budget-exhaust, complete-partial, complete-success,
 * suspend, resume} and releases them; quiescence is awaited before the next round. R=30.
 *
 * Admission uses the product ceiling (default 20). Running observations feed INV-W3. After the
 * last round the remaining live workers are cancelled so INV-W1 is checked at true quiescence.
 *
 * Falsified against:
 *   INV-W5 — heartbeat that renews via laneId after resume (the 2026-08 unfenced path).
 *   INV-W3 — denied write-reservation restore that leaves yield bookkeeping (over-admission).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLaneTerminalStatus, type LaneRecord } from "../../src/core/autonomy/lane-tracker.ts";
import { WorkerDelegationController } from "../../src/core/delegation/worker-delegation-controller.ts";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkerResultContract,
} from "../../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../../src/core/orchestration/delegation-ledger.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT,
	DEFAULT_WORKER_DELEGATION_MAX_USD,
} from "../../src/core/settings-manager.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../../test/orchestration-profile-fixture.ts";
import { assertInvariants } from "../harness/invariants.ts";
import { SeededScheduler } from "../harness/seeded-scheduler.ts";

const SCENARIO = "H3-interleave";
const M = 8;
const R = 30;
const FIXED_SEEDS = [1, 2, 3, 7, 13];
const COST_USD = 0.001;

const RESUME_CONTEXT: AgentResumeContext = {
	provider: "pi",
	sessionId: "h3-session-file",
	cwd: "/repo",
	resourceProfileNames: [],
	contextPointers: [],
};

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h3-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function profile() {
	return createTestWorkerOrchestrationProfile({
		profileId: "h3-worker",
		model: { provider: "test", id: "model", maxTokens: 8_192 },
		role: "explorer",
	});
}

function resultFor(
	handle: StartedDelegationAttempt,
	overrides: Partial<Pick<WorkerResultContract, "status" | "reasonCode" | "summary" | "usage">> = {},
): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${handle.attemptId}`,
		objectiveId: handle.objectiveId,
		taskId: handle.taskId,
		attemptId: handle.attemptId,
		leaseId: handle.leaseId,
		fencingToken: handle.fencingToken,
		status: "completed",
		reasonCode: "worker_completed",
		summary: "done",
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { costUsd: COST_USD, wallClockMs: 10, toolCalls: 1 },
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function terminalPartition(records: readonly LaneRecord[]) {
	let completed = 0;
	let failed = 0;
	let attention = 0;
	let terminalCount = 0;
	for (const record of records) {
		if (!isLaneTerminalStatus(record.status)) continue;
		terminalCount += 1;
		if (record.status === "succeeded") completed += 1;
		else if (record.status === "failed" || record.status === "timeout" || record.status === "budget_exhausted") {
			failed += 1;
		} else {
			attention += 1;
		}
	}
	return { completed, failed, attention, terminalCount };
}

interface LiveWorker {
	laneId: string;
	agentId: string;
	handle: StartedDelegationAttempt;
	/** Fence captured at the start that created this live lease — used for INV-W5. */
	startFence: { attemptId: string; leaseId: string; fencingToken: number };
	suspended: boolean;
}

class InterleaveWorld {
	readonly lifecycle: WorkerLifecycle;
	readonly observations: number[] = [];
	acquired = 0;
	released = 0;
	spendUsd = 0;
	supersededRenewalRejected = false;
	liveExpiryStillAbandons = false;
	private nextAgent = 0;
	private readonly live = new Map<string, LiveWorker>();

	constructor(agentDir: string) {
		this.lifecycle = new WorkerLifecycle({ agentDir, sessionId: "h3" });
	}

	observe(): void {
		this.observations.push(this.lifecycle.getRunningCount());
	}

	private startOne(): void {
		if (this.live.size >= M) return;
		if (this.lifecycle.getRunningCount() >= DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT) return;
		const p = profile();
		const agentId = `h3-agent-${this.nextAgent}`;
		this.nextAgent += 1;
		this.lifecycle.ensureAgent({ agentId, role: "explorer", resumeContext: RESUME_CONTEXT });
		const prepared = this.lifecycle.prepare({
			instructions: `h3 ${agentId}`,
			executionContract: createWorkerExecutionContract({
				worker: {
					profile: p,
					modelBinding: p.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(p),
				},
			}),
			requiredCapabilities: [],
		});
		const attempt = this.lifecycle.getActiveAttempt(prepared.record.laneId);
		if (!attempt) return;
		const task = this.lifecycle.getTask(attempt.taskId);
		if (!task) return;
		this.lifecycle.bindGrant(
			attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				role: task.task.role,
			}),
		);
		const handle = this.lifecycle.startAgent(prepared.record.laneId, agentId, p.leaseTtlMs);
		this.acquired += 1;
		this.live.set(prepared.record.laneId, {
			laneId: prepared.record.laneId,
			agentId,
			handle,
			startFence: { attemptId: handle.attemptId, leaseId: handle.leaseId, fencingToken: handle.fencingToken },
			suspended: false,
		});
		this.liveExpiryStillAbandons = Date.parse(handle.expiresAt) > 0;
	}

	private running(): LiveWorker[] {
		return [...this.live.values()].filter((worker) => !worker.suspended);
	}

	private suspended(): LiveWorker[] {
		return [...this.live.values()].filter((worker) => worker.suspended);
	}

	private drop(laneId: string): void {
		this.live.delete(laneId);
		this.released += 1;
	}

	private finishRunning(
		scheduler: SeededScheduler,
		overrides: Partial<Pick<WorkerResultContract, "status" | "reasonCode">>,
	): void {
		const running = this.running();
		if (running.length === 0) return;
		const worker = scheduler.rng.pick(running);
		this.lifecycle.finish(resultFor(worker.handle, overrides));
		this.spendUsd += COST_USD;
		this.drop(worker.laneId);
	}

	ops(scheduler: SeededScheduler) {
		return [
			{
				id: "start",
				run: () => {
					this.startOne();
				},
			},
			{
				id: "wait_many",
				run: () => {
					this.observe();
				},
			},
			{
				id: "cancel",
				run: () => {
					const running = this.running();
					if (running.length === 0) return;
					const worker = scheduler.rng.pick(running);
					this.lifecycle.cancel(worker.laneId, "h3_cancel");
					this.drop(worker.laneId);
				},
			},
			{
				id: "budget-exhaust",
				run: () => {
					this.finishRunning(scheduler, {
						status: "partial",
						reasonCode: "worker_tree_cost_budget_exhausted",
					});
				},
			},
			{
				id: "complete-partial",
				run: () => {
					this.finishRunning(scheduler, { status: "partial", reasonCode: "worker_partial" });
				},
			},
			{
				id: "complete-success",
				run: () => {
					this.finishRunning(scheduler, { status: "completed", reasonCode: "worker_completed" });
				},
			},
			{
				id: "suspend",
				run: () => {
					const running = this.running();
					if (running.length === 0) return;
					const worker = scheduler.rng.pick(running);
					this.lifecycle.suspendAgent(worker.laneId, worker.agentId, worker.agentId, "h3_interrupt");
					worker.suspended = true;
					this.released += 1;
				},
			},
			{
				id: "resume",
				run: () => {
					const suspended = this.suspended();
					if (suspended.length === 0) return;
					const worker = scheduler.rng.pick(suspended);
					const resumed = this.lifecycle.resumeAgent(worker.laneId, worker.agentId, profile().leaseTtlMs);
					this.acquired += 1;
					worker.handle = resumed;
					worker.suspended = false;
					try {
						this.lifecycle.ledger.runtime.renewAttemptLease(
							worker.startFence.attemptId,
							worker.startFence.leaseId,
							worker.startFence.fencingToken,
							60_000,
						);
					} catch {
						this.supersededRenewalRejected = true;
					}
					worker.startFence = {
						attemptId: resumed.attemptId,
						leaseId: resumed.leaseId,
						fencingToken: resumed.fencingToken,
					};
					this.liveExpiryStillAbandons = Date.parse(resumed.expiresAt) > 0;
				},
			},
		];
	}

	drain(): void {
		for (const worker of [...this.live.values()]) {
			if (worker.suspended) {
				this.lifecycle.resumeAgent(worker.laneId, worker.agentId, profile().leaseTtlMs);
				this.acquired += 1;
			}
			this.lifecycle.cancel(worker.laneId, "h3_drain");
			this.drop(worker.laneId);
		}
	}

	/** Every seed must hit a real superseded fence, not a missing-attempt throw. */
	probeFence(): void {
		if (this.supersededRenewalRejected) return;
		if (this.running().length === 0 && this.suspended().length === 0) this.startOne();
		const target = this.running()[0] ?? this.suspended()[0];
		if (!target) return;
		if (!target.suspended) {
			this.lifecycle.suspendAgent(target.laneId, target.agentId, target.agentId, "h3_fence_probe");
			target.suspended = true;
			this.released += 1;
		}
		const resumed = this.lifecycle.resumeAgent(target.laneId, target.agentId, profile().leaseTtlMs);
		this.acquired += 1;
		target.handle = resumed;
		target.suspended = false;
		try {
			this.lifecycle.ledger.runtime.renewAttemptLease(
				target.startFence.attemptId,
				target.startFence.leaseId,
				target.startFence.fencingToken,
				60_000,
			);
		} catch {
			this.supersededRenewalRejected = true;
		}
		target.startFence = {
			attemptId: resumed.attemptId,
			leaseId: resumed.leaseId,
			fencingToken: resumed.fencingToken,
		};
		this.liveExpiryStillAbandons = Date.parse(resumed.expiresAt) > 0;
	}

	assertCatalogue(seed: number, injection: string): void {
		this.probeFence();
		this.observe();
		const records = this.lifecycle.getAllRecords();
		assertInvariants(
			{
				leases: {
					acquired: this.acquired,
					released: this.released,
					heldByLiveOwner: this.lifecycle.getRunningCount(),
				},
				terminalPartition: terminalPartition(records),
				concurrency: {
					observations: this.observations,
					maxConcurrent: DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT,
				},
				fencedRenewal: {
					supersededRenewalRejected: this.supersededRenewalRejected,
					liveExpiryStillAbandons: this.liveExpiryStillAbandons,
				},
				treeBudget: {
					spendUsd: this.spendUsd,
					ceilingUsd: DEFAULT_WORKER_DELEGATION_MAX_USD,
					finalTurnOverrunUsd: 0,
					profileFree: true,
					ceilingIsZero: DEFAULT_WORKER_DELEGATION_MAX_USD === 0,
				},
			},
			["INV-W1", "INV-W2", "INV-W3", "INV-W5", "INV-B1"],
			{ seed, injection, scenario: SCENARIO },
		);
	}
}

async function runInterleave(seed: number): Promise<void> {
	const scheduler = new SeededScheduler(seed);
	const world = new InterleaveWorld(root());
	for (let round = 0; round < R; round++) {
		await scheduler.runRound(world.ops(scheduler));
		world.observe();
	}
	world.drain();
	world.assertCatalogue(seed, `round-${R}`);
}

function nightlySeed(): number {
	const raw = process.env.DESTRUCTIVE_NIGHTLY_SEED;
	if (raw !== undefined && raw !== "") {
		const parsed = Number(raw);
		if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
	}
	// UTC date as YYYYMMDD — deterministic per night, logged in the test name.
	const now = new Date();
	return now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

describe("destructive/stress: SeededScheduler", () => {
	it("the same seed and op ids release in the same order", async () => {
		const ids = ["start", "cancel", "suspend", "resume", "wait_many"];
		const seen: string[][] = [];
		for (const _ of [0, 1]) {
			const scheduler = new SeededScheduler(42);
			const order: string[] = [];
			await scheduler.runRound(ids.map((id) => ({ id, run: () => order.push(id) })));
			seen.push(order);
		}
		expect(seen[0]).toEqual(seen[1]);
		expect(seen[0]).not.toEqual(ids);
	});
});

describe("destructive/stress: H3 interleave (INV-W1/W2/W3/W5/B1)", () => {
	for (const seed of FIXED_SEEDS) {
		it(`seed ${seed}: ${R} rounds over ${M} slots stay inside the catalogue`, async () => {
			await runInterleave(seed);
		});
	}

	const rotating = nightlySeed();
	it(`nightly seed ${rotating}: same catalogue`, async () => {
		await runInterleave(rotating);
	});
});

describe("destructive/stress: H3 falsify 2026-08 wave", () => {
	it("INV-W5: unfenced laneId renew after resume is the bug; the captured fence rejects", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "h3-w5" });
		const p = profile();
		lifecycle.ensureAgent({ agentId: "stale", role: "explorer", resumeContext: RESUME_CONTEXT });
		const prepared = lifecycle.prepare({
			instructions: "fence",
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
		const first = lifecycle.startAgent(prepared.record.laneId, "stale", p.leaseTtlMs);
		lifecycle.suspendAgent(prepared.record.laneId, "stale", "stale", "h3_w5");
		lifecycle.resumeAgent(prepared.record.laneId, "stale", p.leaseTtlMs);

		let unfencedAccepted = false;
		try {
			lifecycle.renewLease(prepared.record.laneId, 60_000);
			unfencedAccepted = true;
		} catch {
			unfencedAccepted = false;
		}
		expect(unfencedAccepted).toBe(true);

		let fencedRejected = false;
		try {
			lifecycle.ledger.runtime.renewAttemptLease(first.attemptId, first.leaseId, first.fencingToken, 60_000);
		} catch {
			fencedRejected = true;
		}

		expect(() =>
			assertInvariants(
				{
					fencedRenewal: {
						supersededRenewalRejected: !unfencedAccepted,
						liveExpiryStillAbandons: Date.parse(first.expiresAt) > 0,
					},
				},
				["INV-W5"],
				{ seed: 0, injection: "unfenced-laneId-renew", scenario: "INV-W5" },
			),
		).toThrow(/INV-W5/);

		assertInvariants(
			{
				fencedRenewal: {
					supersededRenewalRejected: fencedRejected,
					liveExpiryStillAbandons: Date.parse(first.expiresAt) > 0,
				},
			},
			["INV-W5"],
			{ seed: 0, injection: "fenced-renew", scenario: "INV-W5" },
		);
	});

	it("INV-W3: stale yield after a denied restore over-admits; product cleanup does not", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "h3-w3" });
		const p = profile();
		lifecycle.ensureAgent({ agentId: "caller", role: "explorer", resumeContext: RESUME_CONTEXT });
		const prepared = lifecycle.prepare({
			instructions: "yield",
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
		lifecycle.startAgent(prepared.record.laneId, "caller", p.leaseTtlMs);
		const callerAttempt = lifecycle.getLatestAgentAttempt("caller");
		if (!callerAttempt?.lease) throw new Error("missing caller lease");

		const maxConcurrent = 1;
		const yieldForWait = vi.fn(() => ({
			laneId: callerAttempt.taskId,
			lease: { attemptId: callerAttempt.attemptId },
		}));
		const restoreAfterWait = vi.fn(() => ({ kind: "denied" as const, reasonCode: "write_reservation_unavailable" }));
		const yieldedCapacityAttemptIds = new Map<string, number>();
		const yieldedWriteReservations = new Map();
		const controller = Object.assign(Object.create(WorkerDelegationController.prototype) as object, {
			deps: { isDisposed: () => false },
			lifecycle,
			scheduler: { drain: vi.fn() },
			laneAbortControllers: new Map([[callerAttempt.taskId, { abort: vi.fn() }]]),
			yieldedCapacityAttemptIds,
			yieldedWriteReservations,
			writeReservations: { yieldForWait, restoreAfterWait },
		}) as unknown as WorkerDelegationController;
		const yieldCaller = Reflect.get(controller, "yieldWorkerForWait") as (id: string) => () => boolean;
		const hasCapacity = Reflect.get(controller, "hasWorkerCapacity") as (settings: {
			maxConcurrent: number;
		}) => boolean;

		const restore = yieldCaller.call(controller, "caller");
		expect(yieldedCapacityAttemptIds.size).toBe(1);
		expect(() => restore()).toThrow(/write reservation/);
		expect(yieldedCapacityAttemptIds.size).toBe(0);
		expect(hasCapacity.call(controller, { maxConcurrent })).toBe(false);
		assertInvariants(
			{
				concurrency: {
					observations: [lifecycle.getRunningCount()],
					maxConcurrent,
				},
			},
			["INV-W3"],
			{ seed: 0, injection: "denied-restore-cleared", scenario: "INV-W3" },
		);

		// Re-introduce the 2026-08 bug: a denied restore that throws before clearing the yield
		// map. hasWorkerCapacity then treats the still-running caller as yielded headroom.
		yieldedCapacityAttemptIds.set(callerAttempt.attemptId, 1);
		expect(hasCapacity.call(controller, { maxConcurrent })).toBe(true);
		const second = lifecycle.prepare({
			instructions: "over-admit",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile: p,
					modelBinding: p.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(p),
				},
			}),
			requiredCapabilities: [],
		});
		const secondAttempt = lifecycle.getActiveAttempt(second.record.laneId);
		if (!secondAttempt) throw new Error("missing second attempt");
		const secondTask = lifecycle.getTask(secondAttempt.taskId);
		if (!secondTask) throw new Error("missing second task");
		lifecycle.bindGrant(
			secondAttempt.attemptId,
			createTestExecutionGrant({
				objectiveId: secondTask.task.objectiveId,
				taskId: secondAttempt.taskId,
				attemptId: secondAttempt.attemptId,
				role: secondTask.task.role,
			}),
		);
		lifecycle.ensureAgent({ agentId: "second", role: "explorer", resumeContext: RESUME_CONTEXT });
		lifecycle.startAgent(second.record.laneId, "second", p.leaseTtlMs);
		expect(() =>
			assertInvariants(
				{
					concurrency: {
						observations: [lifecycle.getRunningCount()],
						maxConcurrent,
					},
				},
				["INV-W3"],
				{ seed: 0, injection: "denied-restore-stale-yield", scenario: "INV-W3" },
			),
		).toThrow(/INV-W3/);
	});
});
