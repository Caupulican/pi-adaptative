import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
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
function buildQueuingDeps(agentDir: string): BackgroundLaneControllerDeps {
	const model = { provider: "ollama", id: "local-model", contextWindow: 32_000, baseUrl: "http://localhost:11434" };
	const settingsManager = SettingsManager.inMemory({
		workerDelegation: { enabled: true, orchestrationProfile: "local-worker" },
	});
	saveTestWorkerOrchestrationProfile({
		agentDir,
		cwd: "/repo",
		profile: createTestWorkerOrchestrationProfile({ profileId: "local-worker", model }),
	});
	const sessionManager = {
		getEntries: () => [],
		appendCustomEntry: () => "entry-1",
	} as unknown as SessionManager;
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => settingsManager,
		getModelRegistry: () => ({ find: () => model, hasConfiguredAuth: () => true }) as never,
		getModel: () => model,
		isModelExhausted: () => false,
		isDelegateToolActive: () => true,
		getCapabilityEnvelope: () => undefined,
		getGoalStateSnapshot: () => undefined,
		readMemoryForLane: async () => "",
		// Never resolves: once drained, the running worker stays suspended for the whole test.
		runIsolatedCompletion: () => new Promise(() => {}),
		saveWorkerResultSnapshot: () => "entry-2",
		addSpawnedUsage: () => undefined,
		emitAutonomyTelemetry: () => {},
		emit: () => {},
	} as never;
}

describe("queued-worker quiesce visibility", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

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
});
