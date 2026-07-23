import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import { adaptWorkerResult } from "../src/core/orchestration/worker-result-adapter.ts";

const roots: string[] = [];

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-delegation-ledger-"));
	roots.push(directory);
	return directory;
}

function profile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "implementer-fast",
		description: "Pinned implementer",
		role: "implementer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "test", modelId: "fast", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "filesystem.write", "worktree.read", "worktree.mutate"],
		toolNames: ["read", "write", "edit"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxAttempts: 3, maxWallClockMs: 30_000, maxToolCalls: 6 },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: true,
		createdAt: now,
		updatedAt: now,
	};
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DelegationOrchestrationLedger", () => {
	it("persists dispatch before execution and requeues interrupted isolated work with a fresh fenced attempt", () => {
		const agentDir = root();
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-1" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "Implement the bounded change",
			profile: profile(),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		const handle = first.start(queued.attemptId, 60_000);

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-1" });
		const recovered = reopened.recoverQueuedDispatches();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			taskId: "worker-1",
			status: "queued",
			dispatch: {
				profileId: "implementer-fast",
				instructions: "Implement the bounded change",
			},
		});
		expect(recovered[0]?.attemptId).not.toBe(handle.attemptId);
		expect(() =>
			first.runtime.finishAttempt(
				adaptWorkerResult({
					handle,
					result: {
						requestId: "worker-1",
						status: "completed",
						summary: "stale completion",
						changedFiles: [],
					},
					accepted: true,
					costUsd: 0,
					cwd: agentDir,
					wallClockMs: 1,
					toolCalls: 0,
				}),
			),
		).toThrow("cannot finish from 'expired'");
	});

	it("replays an already queued dispatch without duplicating its attempt", () => {
		const agentDir = root();
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-2" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "Inspect",
			profile: profile(),
			requiredCapabilities: ["filesystem.read"],
		});
		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-2" });
		const recovered = reopened.recoverQueuedDispatches();
		expect(recovered.map((attempt) => attempt.attemptId)).toEqual([queued.attemptId]);
	});

	it("fails an interrupted task instead of requeueing past its profile attempt budget", () => {
		const agentDir = root();
		const limitedProfile = profile();
		limitedProfile.budget = { ...limitedProfile.budget, maxAttempts: 1 };
		const first = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-limited" });
		const queued = first.prepare({
			laneId: "worker-1",
			instructions: "One attempt only",
			profile: limitedProfile,
			requiredCapabilities: ["filesystem.read"],
		});
		first.start(queued.attemptId, 60_000);

		const reopened = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-limited" });
		expect(reopened.recoverQueuedDispatches()).toEqual([]);
		expect(reopened.runtime.getSnapshot().tasks["worker-1"]?.task.status).toBe("failed");
	});

	it("keeps an independently verified profile result non-terminal until verification", () => {
		const agentDir = root();
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-3" });
		const queued = ledger.prepare({
			laneId: "worker-1",
			instructions: "Change one file",
			profile: profile(),
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
		});
		const handle = ledger.start(queued.attemptId, 60_000);
		const result = adaptWorkerResult({
			handle,
			result: {
				requestId: "worker-1",
				status: "completed",
				summary: "implemented",
				changedFiles: ["result.ts"],
			},
			accepted: true,
			costUsd: 0.01,
			cwd: agentDir,
			wallClockMs: 20,
			toolCalls: 2,
			verificationRequired: true,
		});
		ledger.runtime.finishAttempt(result);

		expect(result).toMatchObject({ status: "partial", nextAction: "independent_verification_required" });
		expect(ledger.runtime.getSnapshot().tasks["worker-1"]?.task.status).toBe("blocked");
	});
});
