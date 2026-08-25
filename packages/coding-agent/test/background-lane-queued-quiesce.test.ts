import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTestWorkerOrchestrationProfile,
	saveTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const tempDirs: string[] = [];

function createAgentDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-${label}-`));
	tempDirs.push(dir);
	return dir;
}

/**
 * A local-execution model (ollama) used as BOTH the foreground and the worker-lane model, so
 * `startWorkerDelegation`'s "contends with local foreground" check routes the request through the
 * QUEUED path instead of starting it immediately -- the scenario this file targets.
 */
function buildQueuingDeps(
	agentDir: string,
	options: { local?: boolean; maxConcurrent?: number } = {},
): BackgroundLaneControllerDeps {
	const local = options.local ?? true;
	const model = {
		provider: local ? "ollama" : "test",
		id: local ? "local-model" : "remote-model",
		contextWindow: 32_000,
		baseUrl: local ? "http://localhost:11434" : "https://models.invalid/v1",
	};
	const settingsManager = SettingsManager.inMemory({
		workerDelegation: {
			enabled: true,
			orchestrationProfile: "local-worker",
			maxConcurrent: options.maxConcurrent ?? 1,
		},
	});
	saveTestWorkerOrchestrationProfile({
		agentDir,
		cwd: "/repo",
		profile: createTestWorkerOrchestrationProfile({ profileId: "local-worker", model }),
	});
	const sessionManager = {
		getEntries: () => [],
		buildSessionContext: () => ({ messages: [] }),
		appendCustomEntry: () => "entry-1",
	} as unknown as SessionManager;
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => settingsManager,
		getResourceLoader: () =>
			({
				getDiscoverableSkillPaths: () => [],
				getDiscoverablePromptPaths: () => [],
				getAgentsFiles: () => ({ agentsFiles: [] }),
			}) as never,
		getModelRegistry: () => ({ find: () => model, hasConfiguredAuth: () => true }) as never,
		getModel: () => model,
		isModelExhausted: () => false,
		isDelegateToolActive: () => true,
		getCapabilityEnvelope: () => undefined,
		getGoalStateSnapshot: () => undefined,
		readMemoryForLane: async () => "",
		// Never resolves: once drained, the running worker stays suspended for the whole test.
		runIsolatedCompletion: () => new Promise(() => {}),
		saveWorkerClaimSnapshot: () => "entry-2",
		addSpawnedUsage: () => undefined,
		emitAutonomyTelemetry: () => {},
		emit: () => {},
	} as never;
}

afterEach(() => {
	resetInFlightWorkRegistryForTests();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("queued-worker quiesce visibility", () => {
	it("registers a queued worker in the reload-gate quiesce registry at ENQUEUE, before it ever runs", () => {
		const agentDir = createAgentDir("quiesce-queued-enqueue");
		const controller = new BackgroundLaneController(buildQueuingDeps(agentDir));

		const started = controller.startWorkerDelegation({ instructions: "queued work" });
		expect(started.started).toBe(true);

		const units = getInFlightWorkUnits(agentDir);
		expect(units).toHaveLength(1);
		expect(units[0]?.kind).toBe("lane");
		expect(units[0]?.label).toMatch(/^worker-queued:/);
	});

	it("deregisters the queued registration exactly once at the running handoff, with no gap and no double count", () => {
		const agentDir = createAgentDir("quiesce-queued-handoff");
		const controller = new BackgroundLaneController(buildQueuingDeps(agentDir));

		const started = controller.startWorkerDelegation({ instructions: "queued work" });
		expect(started.started).toBe(true);
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		// The handoff is fully synchronous -- runWorkerDelegationOnce registers its own "running"
		// unit before its first `await`, and no `await` separates the queued deregister (inside
		// drainQueuedWorkerDelegations) from that call. So immediately after this returns, the
		// registry holds exactly the RUNNING unit -- never zero, never two.
		controller.drainQueuedWorkerDelegations();

		const units = getInFlightWorkUnits(agentDir);
		expect(units).toHaveLength(1);
		expect(units[0]?.label).toMatch(/^worker:/);
	});

	it("deregisters the queued registration exactly once on disposal cancellation (never started)", () => {
		const agentDir = createAgentDir("quiesce-queued-cancel");
		const controller = new BackgroundLaneController(buildQueuingDeps(agentDir));

		const started = controller.startWorkerDelegation({ instructions: "queued work" });
		expect(started.started).toBe(true);
		expect(getInFlightWorkUnits(agentDir)).toHaveLength(1);

		controller.abortInFlightLanes();

		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("never double-deregisters: draining an already-canceled queue is a no-op on the registry", () => {
		const agentDir = createAgentDir("quiesce-queued-cancel-then-drain");
		const controller = new BackgroundLaneController(buildQueuingDeps(agentDir));

		controller.startWorkerDelegation({ instructions: "queued work" });
		controller.abortInFlightLanes();
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);

		// _queuedWorkers was cleared by abortInFlightLanes(), so this is a no-op loop -- it must not
		// throw and must not resurrect a registry entry.
		expect(() => controller.drainQueuedWorkerDelegations()).not.toThrow();
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("queues a remote worker at the global concurrency ceiling instead of rejecting it", () => {
		const agentDir = createAgentDir("quiesce-remote-capacity");
		const controller = new BackgroundLaneController(buildQueuingDeps(agentDir, { local: false, maxConcurrent: 1 }));

		const first = controller.startWorkerDelegation({ instructions: "first remote worker" });
		const second = controller.startWorkerDelegation({ instructions: "second remote worker" });

		expect(first).toMatchObject({ started: true, record: { status: "running" } });
		expect(second).toMatchObject({ started: true, record: { status: "queued" } });
		expect(
			getInFlightWorkUnits(agentDir)
				.map((unit) => unit.label)
				.sort(),
		).toEqual([expect.stringMatching(/^worker-queued:/), expect.stringMatching(/^worker:/)]);
		controller.abortInFlightLanes();
	});

	it("rebuilds the scheduler queue from the durable dispatch after a process restart", () => {
		const agentDir = createAgentDir("quiesce-durable-recovery");
		const deps = buildQueuingDeps(agentDir);
		const first = new BackgroundLaneController(deps);
		const started = first.startWorkerDelegation({ instructions: "survive restart" });
		expect(started).toMatchObject({ started: true, record: { status: "queued" } });

		// A real process restart drops the in-memory quiesce registry and controller instance while
		// retaining the orchestration event store under agentDir.
		resetInFlightWorkRegistryForTests();
		const reopened = new BackgroundLaneController(deps);
		expect(reopened.getLaneRecords()).toEqual([
			expect.objectContaining({
				laneId: started.started ? started.record.laneId : "unreachable",
				status: "queued",
			}),
		]);
		expect(getInFlightWorkUnits(agentDir)).toEqual([
			expect.objectContaining({ label: expect.stringMatching(/^worker-recovered:/) }),
		]);

		reopened.drainQueuedWorkerDelegations();
		expect(reopened.getLaneRecords()[0]?.status).toBe("running");
		expect(getInFlightWorkUnits(agentDir)).toEqual([
			expect.objectContaining({ label: expect.stringMatching(/^worker:/) }),
		]);
		reopened.abortInFlightLanes();
	});
});

describe("worker dispatch priority", () => {
	it("routes queued cancellation through the controller-owned cancellation boundary", () => {
		const agentDir = createAgentDir("queued-reservation-release");
		const records = new Map<string, LaneRecord>();
		const cancelled: Array<{ laneId: string; reasonCode: string }> = [];
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "write_reservation" }),
			getRecord: (laneId) => records.get(laneId),
			run: async () => ({ started: false, skipReason: "unused" }),
			cancel: (laneId, reasonCode) => cancelled.push({ laneId, reasonCode }),
			warn: () => {},
		});
		const record: LaneRecord = { laneId: "reserved-write-lane", type: "worker", status: "queued" };
		records.set(record.laneId, record);
		scheduler.enqueue(record, { instructions: "write only inside the reserved path" });
		scheduler.drain();

		scheduler.cancelQueued();

		expect(cancelled).toEqual([{ laneId: record.laneId, reasonCode: "session_disposed" }]);
	});

	it("starts a mandatory verifier before earlier ordinary queued work", () => {
		const agentDir = createAgentDir("verification-priority");
		const records = new Map<string, LaneRecord>();
		const started: string[] = [];
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => ({ action: "start" }),
			getRecord: (laneId) => records.get(laneId),
			run: (_request, record) => {
				started.push(record.laneId);
				return new Promise(() => {});
			},
			cancel: () => {},
			warn: () => {},
		});
		for (const laneId of ["ordinary-1", "ordinary-2", "verifier"]) {
			const record: LaneRecord = { laneId, type: "worker", status: "queued" };
			records.set(laneId, record);
			scheduler.enqueue(
				record,
				{
					instructions: laneId,
					...(laneId === "verifier" ? { verificationOfTaskId: "subject" } : {}),
				},
				false,
				laneId === "verifier",
			);
		}

		scheduler.drain();

		expect(started).toEqual(["verifier", "ordinary-1", "ordinary-2"]);
	});
});
