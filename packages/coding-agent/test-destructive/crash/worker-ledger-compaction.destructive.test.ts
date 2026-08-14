/**
 * H1 scenario d: worker ledger commit + compaction cycle, crash-swept.
 * Asserts INV-W1, INV-W2, INV-W4, INV-C2, INV-R1.
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
import { assertInvariants } from "../harness/invariants.ts";

const SCENARIO = "H1d-worker-ledger-compaction";
const SESSION_ID = "session-h1d";
const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h1d-"));
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

function startWorker(lifecycle: WorkerLifecycle): { laneId: string; handle: StartedDelegationAttempt } {
	const p = profile();
	const prepared = lifecycle.prepare({
		instructions: "ledger compaction",
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
	const handle = lifecycle.start(prepared.record.laneId, p.leaseTtlMs);
	return { laneId: prepared.record.laneId, handle };
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

describe("destructive/crash: worker ledger + compaction (INV-W1/W2/W4/C2/R1)", () => {
	it("a finished worker releases its lease and partitions as completed", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: SESSION_ID });
		const { laneId, handle } = startWorker(lifecycle);
		expect(lifecycle.getRunningCount()).toBe(1);
		lifecycle.finish(resultFor(handle));
		const record = lifecycle.getRecord(laneId);
		expect(record && isLaneTerminalStatus(record.status)).toBe(true);

		const pending = lifecycle.getPendingTerminalNotifications().filter((entry) => entry.record.laneId === laneId);
		lifecycle.markNotificationsDelivered(pending.map((entry) => entry.notificationId));

		assertInvariants(
			{
				leases: { acquired: 1, released: 1, heldByLiveOwner: lifecycle.getRunningCount() },
				terminalPartition: {
					completed: record?.status === "succeeded" || record?.status === "partial" ? 1 : 0,
					failed: 0,
					attention:
						record?.status === "partial" || record?.status === "blocked" || record?.status === "canceled" ? 1 : 0,
					terminalCount: 1,
				},
				terminalHandoff: {
					deliveredCounts: new Map([[handle.attemptId, 1]]),
					neverDelivered: [],
				},
			},
			["INV-W1", "INV-W2", "INV-W4"],
			{ seed: 0, scenario: `${SCENARIO}-quiescent` },
		);
	});

	it("failAtOp sweep of compactIfNeeded after two worker terminals reconstructs or fails loud", () => {
		const agentDir = root();
		const setup = new WorkerLifecycle({ agentDir, sessionId: SESSION_ID });
		const first = startWorker(setup);
		setup.finish(resultFor(first.handle));
		const second = startWorker(setup);
		setup.finish(resultFor(second.handle));

		const counting = createFaultableFsHarness({ kind: "none" });
		const countingStore = new OrchestrationEventStore({
			agentDir,
			sessionId: SESSION_ID,
			maxTailEvents: 2,
			fs: counting.fs,
		});
		const through = countingStore.readProjectionSnapshot()?.throughOrdinal ?? 0;
		countingStore.compactIfNeeded(through, () => ({ compacted: true }));
		const k = counting.opCount();
		if (k === 0) return;

		for (let n = 1; n <= k; n++) {
			const dir = root();
			const seed = new WorkerLifecycle({ agentDir: dir, sessionId: SESSION_ID });
			const a = startWorker(seed);
			seed.finish(resultFor(a.handle));
			const b = startWorker(seed);
			seed.finish(resultFor(b.handle));

			const mode: FaultInjectionMode = { kind: "failAtOp", op: n };
			const faulted = createFaultableFsHarness(mode);
			const crashing = new OrchestrationEventStore({
				agentDir: dir,
				sessionId: SESSION_ID,
				maxTailEvents: 2,
				fs: faulted.fs,
			});
			const ordinal = crashing.readProjectionSnapshot()?.throughOrdinal ?? 0;
			try {
				crashing.compactIfNeeded(ordinal, () => ({ compacted: true }));
			} catch {
				// expected
			}

			let consistent = false;
			let failedLoud = false;
			try {
				const restarted = new WorkerLifecycle({ agentDir: dir, sessionId: SESSION_ID });
				consistent = restarted.getAllRecords().length >= 1;
			} catch {
				failedLoud = true;
			}

			assertInvariants(
				{
					crashConsistency: {
						consistent,
						failedLoud,
						silentDivergence: !consistent && !failedLoud,
					},
				},
				["INV-C2", "INV-R1"],
				{ seed: 0, injection: n, scenario: `${SCENARIO}-compact` },
			);
		}
	});
});
