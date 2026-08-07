import { mkdirSync } from "node:fs";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { createHarness } from "./suite/harness.ts";

type DagControls = {
	startWorkerDelegation(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord };
	cancelWorkerAgent(agentId: string, reasonCode?: string): LaneRecord | undefined;
	_getWorkerLifecycle(): WorkerLifecycle;
	_getWorkerController(): {
		scheduler: WorkerDispatchScheduler;
		publishTerminalRecord(record: LaneRecord): void;
	};
};

function controlsFor(session: unknown): DagControls {
	return (session as { _backgroundLanes: DagControls })._backgroundLanes;
}

function dependencyRequest(instructions: string, dependencyTaskId: string): WorkerDelegationRequest {
	return {
		instructions,
		taskContext: {
			requirementIds: [],
			dependsOnTaskIds: [dependencyTaskId],
			acceptanceCriterionIds: [],
			resourcePointerIds: [],
		},
	};
}

function verifiedWriteWorkerProfiles(): {
	implementation: OrchestrationProfile;
	verifier: OrchestrationProfile;
} {
	const now = new Date().toISOString();
	const base: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "verified-write-worker",
		description: "Verified write worker",
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read", "filesystem.write"],
		toolNames: ["read", "write", "edit"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
		maxConcurrent: 3,
		leaseTtlMs: 90_000,
		requireIndependentVerification: true,
		verificationProfileId: "verified-write-review",
		createdAt: now,
		updatedAt: now,
	};
	const { verificationProfileId, ...verifierBase } = base;
	if (!verificationProfileId) throw new Error("Expected verifier profile identity.");
	return {
		implementation: base,
		verifier: {
			...verifierBase,
			profileId: "verified-write-review",
			description: "Verified write reviewer",
			role: "verifier",
			capabilityCeiling: ["filesystem.read"],
			toolNames: ["read"],
			requireIndependentVerification: false,
		},
	};
}

describe("worker controller dependency dispatch", () => {
	it("revalidates dynamic verifier queue demand when a write reservation forces an immediate worker to queue", async () => {
		const profiles = verifiedWriteWorkerProfiles();
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, maxConcurrent: 3, writeEnabled: true, writePaths: ["src"] } },
			workerOrchestrationProfile: profiles.implementation,
			additionalOrchestrationProfiles: [profiles.verifier],
		});
		let releaseFirst!: (message: AssistantMessage) => void;
		const firstResponse = new Promise<AssistantMessage>((resolve) => {
			releaseFirst = resolve;
		});
		let providerCalls = 0;
		try {
			mkdirSync(`${harness.tempDir}/src`, { recursive: true });
			await harness.session.setModel({ ...harness.getModel(), baseUrl: "https://faux.invalid" });
			harness.setResponses([
				() => {
					providerCalls += 1;
					return firstResponse;
				},
			]);
			const controls = controlsFor(harness.session);
			const first = controls.startWorkerDelegation({ instructions: "Hold the first scoped write reservation." });
			if (!first.started) throw new Error(first.skipReason);
			await vi.waitFor(() => expect(providerCalls).toBe(1));

			const scheduler = controls._getWorkerController().scheduler;
			for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 2; index += 1) {
				const record: LaneRecord = { laneId: `saturated-${index}`, type: "worker", status: "queued" };
				scheduler.enqueue(record, { instructions: `saturated ${index}` });
			}
			expect(scheduler.queuedCount).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 2);

			const enqueue = vi.spyOn(scheduler, "enqueue");
			const rejectedLaneId = controls._getWorkerLifecycle().getNextAvailableLaneIdCandidate();
			expect(controls.startWorkerDelegation({ instructions: "Contend for the same scoped write." })).toEqual({
				started: false,
				skipReason: "worker_not_started",
			});
			expect(enqueue).not.toHaveBeenCalled();
			expect(controls._getWorkerLifecycle().getRecord(rejectedLaneId)).toMatchObject({
				status: "canceled",
				reasonCode: "worker_dispatch_queue_full",
			});
		} finally {
			releaseFirst?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("keeps a dependent attempt queued without a lease and starts it after completion", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		let releasePrerequisite!: (message: AssistantMessage) => void;
		let releaseDependent!: (message: AssistantMessage) => void;
		const prerequisiteResponse = new Promise<AssistantMessage>((resolve) => {
			releasePrerequisite = resolve;
		});
		const dependentResponse = new Promise<AssistantMessage>((resolve) => {
			releaseDependent = resolve;
		});
		let providerCalls = 0;
		try {
			await harness.session.setModel({ ...harness.getModel(), baseUrl: "https://faux.invalid" });
			harness.setResponses([
				() => {
					providerCalls += 1;
					return prerequisiteResponse;
				},
				() => {
					providerCalls += 1;
					return dependentResponse;
				},
			]);
			const controls = controlsFor(harness.session);
			const prerequisite = controls.startWorkerDelegation({ instructions: "Produce the prerequisite." });
			if (!prerequisite.started) throw new Error(prerequisite.skipReason);
			const dependent = await harness.session.runWorkerDelegationOnce(
				dependencyRequest("Consume the prerequisite.", prerequisite.record.laneId),
			);
			if (!dependent.started || !dependent.record) throw new Error(dependent.skipReason ?? "dependent not queued");

			await vi.waitFor(() => expect(providerCalls).toBe(1));
			let snapshot = controls._getWorkerLifecycle().getTaskRuntimeSnapshot();
			const dependentAttemptId = snapshot.tasks[dependent.record.laneId]?.attemptIds[0];
			expect(dependentAttemptId).toBeDefined();
			const dependentAttempt = dependentAttemptId ? snapshot.attempts[dependentAttemptId] : undefined;
			expect(dependentAttempt?.status).toBe("queued");
			expect(dependentAttempt?.lease).toBeUndefined();
			expect(dependentAttempt?.grant).toBeUndefined();

			releasePrerequisite(fauxAssistantMessage('{"summary":"prerequisite complete","status":"completed"}'));
			await vi.waitFor(() => expect(providerCalls).toBe(2));
			snapshot = controls._getWorkerLifecycle().getTaskRuntimeSnapshot();
			expect(dependentAttemptId ? snapshot.attempts[dependentAttemptId]?.status : undefined).toMatch(
				/^(leased|running)$/,
			);

			releaseDependent(fauxAssistantMessage('{"summary":"dependent complete","status":"completed"}'));
			await vi.waitFor(() => {
				const current = controls._getWorkerLifecycle().getTaskRuntimeSnapshot();
				expect(dependentAttemptId ? current.attempts[dependentAttemptId]?.status : undefined).toBe("completed");
			});
		} finally {
			releasePrerequisite?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			releaseDependent?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("cancels a newly queued attempt from the controller's stable failed-dependency readiness", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		try {
			const controls = controlsFor(harness.session);
			const lifecycle = controls._getWorkerLifecycle();
			const runtime = lifecycle.ledger.runtime;
			const objectiveId = `session:${harness.session.sessionId}`;
			runtime.createObjective({ objectiveId, title: "Session", description: "DAG controller regression" });
			runtime.createTask({
				taskId: "failed-input",
				objectiveId,
				title: "Failed input",
				description: "Failed before dependent admission",
				role: "implementer",
			});
			runtime.failTask("failed-input", "test_dependency_failed");
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute"}')]);

			const dependent = controls.startWorkerDelegation(dependencyRequest("Must be cancelled.", "failed-input"));
			if (!dependent.started) throw new Error(dependent.skipReason);

			const snapshot = lifecycle.getTaskRuntimeSnapshot();
			const attemptId = snapshot.tasks[dependent.record.laneId]?.attemptIds[0];
			expect(attemptId ? snapshot.attempts[attemptId] : undefined).toMatchObject({
				status: "cancelled",
				reasonCode: "dependency_failed_or_cancelled",
			});
			expect(snapshot.tasks[dependent.record.laneId]?.attemptIds).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("retains admission-cancel work until durable cancellation succeeds, then ignores publication failure", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		try {
			const controls = controlsFor(harness.session);
			const lifecycle = controls._getWorkerLifecycle();
			const runtime = lifecycle.ledger.runtime;
			const objectiveId = `session:${harness.session.sessionId}`;
			runtime.createObjective({ objectiveId, title: "Session", description: "Cancellation retry regression" });
			runtime.createTask({
				taskId: "failed-cancel-input",
				objectiveId,
				title: "Failed input",
				description: "Force dependent cancellation",
				role: "implementer",
			});
			runtime.failTask("failed-cancel-input", "test_dependency_failed");
			const cancel = lifecycle.cancel.bind(lifecycle);
			const cancelSpy = vi
				.spyOn(lifecycle, "cancel")
				.mockImplementationOnce(() => {
					throw new Error("simulated durable cancel failure");
				})
				.mockImplementation((laneId, reasonCode) => cancel(laneId, reasonCode));
			const controller = controls._getWorkerController();
			const publish = vi.spyOn(controller, "publishTerminalRecord").mockImplementationOnce(() => {
				throw new Error("simulated publication observer failure");
			});

			const dependent = controls.startWorkerDelegation(
				dependencyRequest("Cancel only after the durable write succeeds.", "failed-cancel-input"),
			);
			if (!dependent.started) throw new Error(dependent.skipReason);
			const attemptId = lifecycle.getTaskRuntimeSnapshot().tasks[dependent.record.laneId]?.attemptIds[0];
			expect(attemptId).toBeDefined();
			expect(controller.scheduler.queuedCount).toBe(1);
			expect(attemptId ? lifecycle.getTaskRuntimeSnapshot().attempts[attemptId]?.status : undefined).toBe("queued");

			controller.scheduler.drain();
			expect(cancelSpy).toHaveBeenCalledTimes(2);
			expect(publish).toHaveBeenCalledOnce();
			expect(controller.scheduler.queuedCount).toBe(0);
			expect(attemptId ? lifecycle.getTaskRuntimeSnapshot().attempts[attemptId]?.status : undefined).toBe(
				"cancelled",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("cascades dependency cancellation to a dependent queued earlier in one drain", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 3 } } });
		let releaseRoot!: (message: AssistantMessage) => void;
		const rootResponse = new Promise<AssistantMessage>((resolve) => {
			releaseRoot = resolve;
		});
		try {
			await harness.session.setModel({ ...harness.getModel(), baseUrl: "https://faux.invalid" });
			harness.setResponses([() => rootResponse]);
			const controls = controlsFor(harness.session);
			const root = controls.startWorkerDelegation({ instructions: "Root prerequisite." });
			if (!root.started) throw new Error(root.skipReason);
			const middleRequest = dependencyRequest("Middle dependent.", root.record.laneId);
			const middle = controls.startWorkerDelegation(middleRequest);
			if (!middle.started) throw new Error(middle.skipReason);
			const outerRequest = dependencyRequest("Outer dependent.", middle.record.laneId);
			const outer = controls.startWorkerDelegation(outerRequest);
			if (!outer.started) throw new Error(outer.skipReason);

			const scheduler = controls._getWorkerController().scheduler;
			expect(scheduler.dropQueued(middle.record.laneId)).toBe(true);
			expect(scheduler.dropQueued(outer.record.laneId)).toBe(true);
			// Deliberately reverse topological order: outer is inspected before middle.
			scheduler.enqueue(outer.record, outerRequest);
			scheduler.enqueue(middle.record, middleRequest);

			expect(controls.cancelWorkerAgent(root.record.laneId, "test_root_cancelled")?.status).toBe("canceled");
			const snapshot = controls._getWorkerLifecycle().getTaskRuntimeSnapshot();
			for (const record of [middle.record, outer.record]) {
				const attemptIds = snapshot.tasks[record.laneId]?.attemptIds ?? [];
				expect(attemptIds).toHaveLength(1);
				expect(snapshot.attempts[attemptIds[0] ?? ""]).toMatchObject({
					status: "cancelled",
					reasonCode: "dependency_failed_or_cancelled",
				});
			}
		} finally {
			releaseRoot?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});
});
