/**
 * H1 scenario b (blueprint §4): worker start -> terminal -> handoff flush, crash-swept.
 *
 * Target: WorkerLifecycle's durable terminal-notification outbox (DelegationOrchestrationLedger ->
 * DurableTaskRuntime -> OrchestrationEventStore), which is the durable half of "terminal handoff" —
 * WorkerTerminalHandoffCoordinator (src/core/delegation/worker-terminal-handoff-coordinator.ts) is a
 * pure in-memory delivery-retry wrapper with no fs of its own (confirmed in the Phase 1 seam
 * survey); everything it replays on restart is re-derived from this durable outbox via
 * WorkerLifecycle.getPendingTerminalNotifications()/markNotificationsDelivered(), which is exactly
 * the layer this sweep exercises directly, on 100% real production code.
 *
 * Driver (blueprint §4/§6): bring one worker to "running" for real (unfaulted prepare+start), then
 * measure K = the mutating fs ops finish() alone issues in a clean run. For every N in 1..K, redo
 * prepare+start for real, then run finish() with the fault engaged at op N (failAtOp, then again
 * with tornWriteAtOp), catch the crash, and reconstruct fresh WorkerLifecycle instances over the
 * surviving files ("restart"). Two consistent outcomes are possible depending on exactly how much of
 * finish()'s single durable transition completed before the fault fired:
 *   (a) the transition never became durable -> record stays non-terminal; the pilot completes it for
 *       real (simulating the outer system's natural resumption of an interrupted worker) and then
 *       asserts INV-W4 on the result;
 *   (b) the transition's authoritative event already committed but a subsequent same-transaction
 *       write (the cursor high-water-mark) did not -> the record already reads as terminal after
 *       restart (self-healed from the event tail, not the stale cursor) and INV-W4 is asserted
 *       directly, with no retry.
 * Never observing "torn"/partially-applied state (a status that is neither fully (a) nor fully (b),
 * or a restart that throws while reconstructing state from healthy surviving files) is itself part
 * of what this sweep is checking; assertRecoveredConsistently() below fails loudly if state doesn't
 * cleanly fall into one of the two buckets.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLaneTerminalStatus } from "../../src/core/autonomy/lane-tracker.ts";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../../src/core/orchestration/delegation-ledger.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../../test/orchestration-profile-fixture.ts";
import { createFaultableFsHarness, type FaultInjectionMode } from "../harness/faultable-fs.ts";
import { assertInvW4, type TerminalHandoffWorld } from "../harness/invariants.ts";
import { reproError } from "../harness/repro.ts";

const SCENARIO = "H1b-worker-terminal-handoff";
const SESSION_ID = "session-destructive-crash";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-crash-"));
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
		profileId: "worker",
		model: { provider: "test", id: "model", maxTokens: 8_192 },
	});
}

function executionContract(p: ReturnType<typeof profile>) {
	const authority = createTestWorkerExecutionAuthority(p);
	return createWorkerExecutionContract({
		worker: { profile: p, modelBinding: p.modelPolicy.candidates[0]!, authority },
	});
}

function startWithGrant(lifecycle: WorkerLifecycle, laneId: string, leaseTtlMs: number): StartedDelegationAttempt {
	const attempt = lifecycle.getActiveAttempt(laneId);
	if (!attempt) throw new Error(`Expected active attempt for ${laneId}`);
	const task = lifecycle.getTask(attempt.taskId);
	if (!task) throw new Error(`Expected durable task for ${laneId}`);
	lifecycle.bindGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			role: task.task.role,
		}),
	);
	return lifecycle.start(laneId, leaseTtlMs);
}

function resultFor(handle: StartedDelegationAttempt): WorkerResultContract {
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
		usage: { costUsd: 0, wallClockMs: 10, toolCalls: 1 },
		createdAt: new Date().toISOString(),
	};
}

/** Real, unfaulted prepare+start; returns everything needed to call finish() later. */
function bringWorkerToRunning(agentDir: string): { laneId: string; handle: StartedDelegationAttempt } {
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId: SESSION_ID });
	const p = profile();
	const prepared = lifecycle.prepare({
		instructions: "inspect the workspace",
		executionContract: executionContract(p),
		requiredCapabilities: [],
	});
	const handle = startWithGrant(lifecycle, prepared.record.laneId, p.leaseTtlMs);
	return { laneId: prepared.record.laneId, handle };
}

/** Measure K: the mutating fs ops finish() alone issues in a clean run, on a throwaway fixture. */
function measureCleanRunOpCount(): number {
	const agentDir = root();
	const { laneId, handle } = bringWorkerToRunning(agentDir);
	const counting = createFaultableFsHarness({ kind: "none" });
	const lifecycle = new WorkerLifecycle({
		agentDir,
		sessionId: SESSION_ID,
		store: new OrchestrationEventStore({ agentDir, sessionId: SESSION_ID, fs: counting.fs }),
	});
	lifecycle.finish(resultFor(handle));
	const k = counting.opCount();
	if (k <= 0) throw new Error(`Expected finish() to issue at least one mutating fs op, measured ${k}.`);
	void laneId;
	return k;
}

/** One sweep point: fresh worker up to "running", then finish() faulted at the given mode/op. */
function runOneSweepPoint(mode: FaultInjectionMode): {
	agentDir: string;
	laneId: string;
	handle: StartedDelegationAttempt;
	threw: boolean;
} {
	const agentDir = root();
	const { laneId, handle } = bringWorkerToRunning(agentDir);
	const faulted = createFaultableFsHarness(mode);
	const lifecycle = new WorkerLifecycle({
		agentDir,
		sessionId: SESSION_ID,
		store: new OrchestrationEventStore({ agentDir, sessionId: SESSION_ID, fs: faulted.fs }),
	});
	let threw = false;
	try {
		lifecycle.finish(resultFor(handle));
	} catch {
		threw = true;
	}
	return { agentDir, laneId, handle, threw };
}

/**
 * Reconstruct fresh, unfaulted WorkerLifecycle instances over the surviving files and assert the
 * two-bucket consistency described in this file's header, then assert INV-W4 on the outcome.
 */
function assertRecoveredConsistently(args: {
	agentDir: string;
	laneId: string;
	handle: StartedDelegationAttempt;
	mode: FaultInjectionMode;
	injection: number;
}): void {
	const repro = { seed: 0, injection: args.injection, scenario: SCENARIO };

	const restarted = new WorkerLifecycle({ agentDir: args.agentDir, sessionId: SESSION_ID });
	const record = restarted.getRecord(args.laneId);
	if (!record) throw reproError(`No durable record survived for lane ${args.laneId}.`, repro);

	if (!isLaneTerminalStatus(record.status)) {
		// Bucket (a): the transition never became durable. Complete it for real, simulating the
		// outer system's natural resumption of an interrupted worker.
		restarted.finish(resultFor(args.handle));
	}
	// Bucket (b) needs no action: the transition's authoritative event already committed.

	const deliveredCounts = new Map<string, number>();
	const neverDelivered: string[] = [];

	const beforeDelivery = new WorkerLifecycle({ agentDir: args.agentDir, sessionId: SESSION_ID });
	const pendingBefore = beforeDelivery.getPendingTerminalNotifications();
	const ours = pendingBefore.filter((entry) => entry.record.laneId === args.laneId);
	if (ours.length === 0) {
		neverDelivered.push(args.handle.attemptId);
	} else if (ours.length > 1) {
		throw reproError(
			`${ours.length} pending terminal notifications observed for lane ${args.laneId}; expected at most 1.`,
			repro,
		);
	} else {
		// Replaying the recovery read again (another fresh restart, no delivery yet) must be stable —
		// stay at "not yet delivered", never accumulate a second entry.
		const replay = new WorkerLifecycle({ agentDir: args.agentDir, sessionId: SESSION_ID });
		const replayOurs = replay
			.getPendingTerminalNotifications()
			.filter((entry) => entry.record.laneId === args.laneId);
		if (replayOurs.length !== 1) {
			throw reproError(
				`Undelivered terminal replay was not stable for lane ${args.laneId}: ${replayOurs.length} entries on a second fresh restart.`,
				repro,
			);
		}
		replay.markNotificationsDelivered([ours[0]!.notificationId]);
		const afterDelivery = new WorkerLifecycle({ agentDir: args.agentDir, sessionId: SESSION_ID });
		const stillPending = afterDelivery
			.getPendingTerminalNotifications()
			.filter((entry) => entry.record.laneId === args.laneId);
		deliveredCounts.set(args.handle.attemptId, stillPending.length === 0 ? 1 : 1 + stillPending.length);
	}

	const world: TerminalHandoffWorld = { deliveredCounts, neverDelivered };
	assertInvW4({ terminalHandoff: world }, repro);
}

describe("destructive/crash: worker terminal handoff (INV-W4)", () => {
	it("failAtOp sweep: every crash point during finish() recovers to exactly-once terminal delivery", () => {
		const k = measureCleanRunOpCount();
		expect(k).toBeGreaterThan(0);
		for (let n = 1; n <= k; n++) {
			const { agentDir, laneId, handle, threw } = runOneSweepPoint({ kind: "failAtOp", op: n });
			expect(threw, `failAtOp(${n}) of ${k} should have interrupted finish()`).toBe(true);
			assertRecoveredConsistently({ agentDir, laneId, handle, mode: { kind: "failAtOp", op: n }, injection: n });
		}
	});

	it("tornWriteAtOp sweep: a torn write during finish() never leaves an unrecoverable or duplicated state", () => {
		const k = measureCleanRunOpCount();
		expect(k).toBeGreaterThan(0);
		for (let n = 1; n <= k; n++) {
			const mode: FaultInjectionMode = { kind: "tornWriteAtOp", op: n, seed: 1 };
			const { agentDir, laneId, handle, threw } = runOneSweepPoint(mode);
			expect(threw, `tornWriteAtOp(${n}) of ${k} should have interrupted finish()`).toBe(true);
			assertRecoveredConsistently({ agentDir, laneId, handle, mode, injection: n });
		}
	});
});
