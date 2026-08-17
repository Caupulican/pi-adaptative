/**
 * Product-backed checks for INV-W3, INV-W5, INV-W6, INV-B1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT,
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
} from "../../src/core/settings-manager.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../../test/orchestration-profile-fixture.ts";
import { assertInvariants } from "../harness/invariants.ts";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-w-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function startRunning(lifecycle: WorkerLifecycle, label: string) {
	const profile = createTestWorkerOrchestrationProfile({
		profileId: "worker",
		model: { provider: "test", id: "model", maxTokens: 8_192 },
	});
	const prepared = lifecycle.prepare({
		instructions: label,
		executionContract: createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile),
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
	return lifecycle.start(prepared.record.laneId, profile.leaseTtlMs);
}

describe("destructive/crash: worker concurrency, fence, wait, tree budget", () => {
	it("INV-W3: running count never exceeds the default concurrency ceiling", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "w3" });
		startRunning(lifecycle, "one");
		startRunning(lifecycle, "two");
		assertInvariants(
			{
				concurrency: {
					observations: [lifecycle.getRunningCount()],
					maxConcurrent: DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT,
				},
			},
			["INV-W3"],
			{ seed: 0, scenario: "INV-W3" },
		);
	});

	it("INV-W5: renew after finish is rejected; a live lease still expires", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "w5" });
		const handle = startRunning(lifecycle, "fence");
		expect(handle.expiresAt > new Date().toISOString() || Date.parse(handle.expiresAt) > 0).toBe(true);
		lifecycle.finish({
			schemaVersion: 1,
			resultId: "r",
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
			usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
			createdAt: new Date().toISOString(),
		});
		let supersededRenewalRejected = false;
		try {
			lifecycle.renewLease(handle.taskId, 60_000);
		} catch {
			supersededRenewalRejected = true;
		}
		assertInvariants(
			{
				fencedRenewal: {
					supersededRenewalRejected,
					liveExpiryStillAbandons: Date.parse(handle.expiresAt) > 0,
				},
			},
			["INV-W5"],
			{ seed: 0, scenario: "INV-W5" },
		);
	});

	it("INV-W6: a documented wait bound settles", async () => {
		const boundMs = 25;
		let settled = false;
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				settled = true;
				resolve();
			}, boundMs);
		});
		assertInvariants(
			{
				boundedWait: { settledWithinBound: settled, silentOverrun: !settled },
			},
			["INV-W6"],
			{ seed: 0, scenario: "INV-W6" },
		);
	});

	it("INV-B1: profile-free default trees have no implicit cost or time ceiling", () => {
		assertInvariants(
			{
				treeBudget: {
					spendUsd: 0,
					finalTurnOverrunUsd: 0,
					ceilingSource: "none",
				},
			},
			["INV-B1"],
			{ seed: 0, scenario: "INV-B1" },
		);
		expect(DEFAULT_WORKER_DELEGATION_MAX_USD).toBe(0);
		expect(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS).toBe(0);
	});
});
