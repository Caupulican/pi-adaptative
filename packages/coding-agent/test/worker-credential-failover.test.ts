import { describe, expect, it, vi } from "vitest";
import { describeWorkerModelMoves } from "../src/core/delegation/worker-credential-health.ts";
import { WorkerModelFailover, type WorkerModelFailoverPorts } from "../src/core/delegation/worker-model-failover.ts";
import { evaluateWorkerRetry } from "../src/core/delegation/worker-retry-policy.ts";
import type { OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { emptyProjection } from "../src/core/orchestration/task-runtime-projection.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import { ScriptedProvider } from "./fixtures/harness/scripted-provider.ts";

const provider = new ScriptedProvider();
const first = provider.model("worker-a");
const second = provider.model("worker-b", 8192);
const now = "2026-11-17T00:00:00Z";
const request = {
	laneId: "worker-1",
	agentId: "worker-1",
	ownerId: "owner",
	request: { instructions: "Read the file" },
	outcome: {
		laneStatus: "failed",
		reasonCode: "completion_error",
		reasonDetail: "OAuth credential expired on sign-in",
	},
};

function setup(mode: OrchestrationProfile["modelPolicy"]["mode"]) {
	const bindings = (mode === "fixed" ? [first] : [first, second]).map((model) => ({
		provider: model.provider,
		modelId: model.id,
		thinkingLevel: "off" as const,
	}));
	const profile: OrchestrationProfile = {
		schemaVersion: 1,
		profileId: "reader",
		description: "Read the file",
		role: "explorer",
		modelPolicy: { mode, candidates: bindings },
		capabilityCeiling: [],
		toolNames: [],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
	const contract = createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: bindings[0]!,
			resourcePointers: [],
			authority: { capabilities: [], toolNames: [], readPaths: [], writePaths: [], deniedPaths: [], budget: {} },
		},
	});
	const scheduleRetry = vi.fn<WorkerModelFailoverPorts["scheduleRetry"]>().mockReturnValue({
		scheduled: true,
		record: { laneId: "worker-1", type: "worker", status: "running" },
		retriesUsed: 1,
		notBefore: now,
	});
	const resolveContract = vi.fn<ReturnType<WorkerModelFailoverPorts["resolver"]>["resolveContract"]>(() => ({
		ok: true,
		resolved: { model: second, modelBinding: bindings[bindings.length - 1]!, profile, resourcePointers: [] },
	}));
	const failover = new WorkerModelFailover({
		resolver: () => ({ resolveContract }),
		snapshot: emptyProjection,
		unfitFor: () => undefined,
		activeAttempt: () => ({
			attemptId: "attempt-1",
			taskId: "worker-1",
			status: "running",
			createdAt: now,
			updatedAt: now,
			dispatch: {
				taskId: "worker-1",
				profileId: "reader",
				instructions: request.request.instructions,
				resourcePointerIds: [],
				executionContract: contract,
			},
			checkpointIds: [],
		}),
		credentialHealth: { loginExpired: () => true, tellLoginExpired: () => {} },
		isSubscription: () => true,
		scheduleRetry,
		warn: () => {},
	});
	return { failover, scheduleRetry, resolveContract };
}

describe("worker start credential failure", () => {
	it("schedules a candidate for fresh admission and reports the candidate only after durable suspension", () => {
		const { failover, scheduleRetry } = setup("ordered-fallback");
		const result = failover.schedule("credential", first, request);
		expect(scheduleRetry).toHaveBeenCalledWith({
			...request,
			provider: first.provider,
			subscription: true,
			failover: "login_expired",
		});
		const move = result?.move;
		expect(move).toEqual({
			from: `${first.provider}/worker-a`,
			to: `${second.provider}/worker-b`,
			reason: "login_expired",
		});
		expect(describeWorkerModelMoves(move && [move])).toContain("retry scheduled");
		expect(
			evaluateWorkerRetry({
				...request.outcome,
				provider: first.provider,
				retriesUsed: 2,
				failover: "login_expired",
			}),
		).toMatchObject({ retry: true, reason: "auth_failover" });
		scheduleRetry.mockReturnValue({ scheduled: false, reason: "disposed" });
		expect(failover.schedule("credential", first, request)).toBeUndefined();
	});
	it("keeps a fixed model pinned and stops once an ordered contract runs out of candidates", () => {
		const fixed = setup("fixed");
		expect(fixed.failover.schedule("credential", first, request)).toBeUndefined();
		expect(fixed.resolveContract).not.toHaveBeenCalled();
		expect(fixed.scheduleRetry).not.toHaveBeenCalled();
		const ordered = setup("ordered-fallback");
		ordered.resolveContract.mockReturnValue({ ok: false, reason: "no usable credentials" });
		expect(ordered.failover.schedule("credential", second, request)).toBeUndefined();
		expect(ordered.scheduleRetry).not.toHaveBeenCalled();
	});
});
