import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { appendWorkerClaimSnapshot, getWorkerClaimSnapshots } from "../src/core/delegation/session-worker-claim.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTestWorkerOrchestrationProfile,
	saveTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface FakeAfterToolCallArgs {
	toolCall: { name: string };
	args: unknown;
	isError: boolean;
}

interface FakeIsolatedCompletionOptions {
	afterToolCall?: (args: FakeAfterToolCallArgs) => Promise<unknown> | undefined;
}

function makeTrackedSessionManager(): {
	sessionManager: SessionManager;
	entries: unknown[];
	getAppendCount: () => number;
} {
	const entries: unknown[] = [];
	let appendCount = 0;
	const sessionManager = {
		getEntries: () => entries,
		buildSessionContext: () => ({ messages: [] }),
		appendCustomEntry: (customType: string, data: unknown) => {
			appendCount++;
			const id = `entry-${appendCount}`;
			entries.push({ type: "custom", customType, data, id });
			return id;
		},
	} as unknown as SessionManager;
	return { sessionManager, entries, getAppendCount: () => appendCount };
}

describe("background lane disposal persistence", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("suspends a running agent for resume, preserving changed files without terminal parent-session writes", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-test-disposal-persistence-"));
		const model = { provider: "test", id: "test-model", contextWindow: 128_000 };
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: {
				enabled: true,
				orchestrationProfile: "disposal-worker",
				maxConcurrent: 3,
				writeEnabled: true,
				writePaths: ["/repo"],
			},
		});
		saveTestWorkerOrchestrationProfile({
			agentDir,
			cwd: "/repo",
			profile: createTestWorkerOrchestrationProfile({
				profileId: "disposal-worker",
				model,
				capabilityCeiling: ["filesystem.write"],
				toolNames: ["write"],
			}),
		});
		const { sessionManager, entries, getAppendCount } = makeTrackedSessionManager();

		let disposed = false;
		let capturedAfterToolCall: FakeIsolatedCompletionOptions["afterToolCall"];

		const controller = new BackgroundLaneController({
			isDisposed: () => disposed,
			getSessionId: () => "test-session",
			getCwd: () => "/repo",
			getAgentDir: () => agentDir,
			getSessionManager: () => sessionManager,
			getSettingsManager: () => settingsManager,
			getResourceLoader: () => createTestResourceLoader(),
			getModelRegistry: () => ({ find: () => model, hasConfiguredAuth: () => true }) as never,
			getModel: () => model,
			isModelExhausted: () => false,
			isDelegateToolActive: () => true,
			getCapabilityEnvelope: () => undefined,
			getGoalStateSnapshot: () => undefined,
			readMemoryForLane: async () => "",
			// Never resolves: the worker stays suspended at `await runWorker(...)` inside
			// runWorkerDelegationOnce for the whole test, mirroring the real cutoff scenario where
			// abortInFlightLanes() runs while a delegation is genuinely mid-flight.
			runIsolatedCompletion: (opts: FakeIsolatedCompletionOptions) => {
				capturedAfterToolCall = opts.afterToolCall;
				return new Promise(() => {});
			},
			saveWorkerClaimSnapshot: (claim: WorkerClaim, request?: WorkerRequest) =>
				appendWorkerClaimSnapshot(sessionManager, claim, request),
			addSpawnedUsage: () => undefined,
			notifyWorkerTerminalHandoff: async () => {},
			emitAutonomyTelemetry: () => {},
			emit: () => {},
		} as never);

		const runPromise = controller.runWorkerDelegationOnce({ instructions: "write a note to disk" });
		// Let the synchronous setup (through the awaited `runIsolatedCompletion` call) settle.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(capturedAfterToolCall).toBeDefined();
		// Simulate a real file mutation the worker already applied before dispose interrupts it —
		// the same `afterToolCall` hook a real isolated-completion tool loop would drive.
		await capturedAfterToolCall?.({ toolCall: { name: "write" }, args: { path: "notes/output.md" }, isError: false });

		expect(getAppendCount()).toBe(0); // nothing durable yet -- the worker is still "running"

		// Mirror agent-session.dispose()'s real ordering: the session's own disposed flag flips
		// BEFORE abortInFlightLanes() runs (agent-session.ts sets `_disposed = true` immediately
		// before calling `_backgroundLanes.abortInFlightLanes()`).
		disposed = true;
		controller.abortInFlightLanes();

		expect(getAppendCount()).toBe(0);
		expect(getLaneRecordSnapshots(entries as never)).toEqual([]);
		expect(getWorkerClaimSnapshots(entries as never)).toEqual([]);
		const runtime = controller.getTaskRuntimeSnapshot();
		expect(runtime).toBeDefined();
		const [attempt] = Object.values(runtime?.attempts ?? {});
		expect(attempt).toMatchObject({ status: "suspended", reasonCode: "agent_process_interrupted" });
		if (!attempt?.agentId) throw new Error("Expected the interrupted worker to retain its agent binding.");
		const agent = runtime?.agents[attempt.agentId];
		expect(agent).toMatchObject({ status: "suspended" });
		if (!agent) throw new Error("Expected a durable suspended worker agent.");
		const conversation = new WorkerConversationStore().open({
			agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.agentId,
		});
		expect(conversation.getChangedFiles(attempt.attemptId)).toEqual(["notes/output.md"]);

		const appendCountAtCutoff = getAppendCount();

		// Let the in-flight worker's suspended await finally settle (the abort signal races it via
		// runBoundedCompletion) and the post-await disposed branch in runWorkerDelegationOnce run.
		const outcome = await runPromise;
		expect(outcome.started).toBe(true);

		// No terminal append happened after dispose returned; the suspended attempt remains resumable.
		expect(getAppendCount()).toBe(appendCountAtCutoff);
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("persists a durable canceled lane record for a queued (never-started) worker, with no fabricated worker-result (no ledger exists for a lane that never ran)", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-test-disposal-queued-"));
		const model = {
			provider: "ollama",
			id: "local-model",
			contextWindow: 32_000,
			baseUrl: "http://localhost:11434",
		};
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: true, orchestrationProfile: "queued-worker", maxConcurrent: 1 },
		});
		saveTestWorkerOrchestrationProfile({
			agentDir,
			cwd: "/repo",
			profile: createTestWorkerOrchestrationProfile({ profileId: "queued-worker", model }),
		});
		const { sessionManager, entries, getAppendCount } = makeTrackedSessionManager();

		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getSessionId: () => "test-session",
			getCwd: () => "/repo",
			getAgentDir: () => agentDir,
			getSessionManager: () => sessionManager,
			getSettingsManager: () => settingsManager,
			getResourceLoader: () => createTestResourceLoader(),
			getModelRegistry: () => ({ find: () => model, hasConfiguredAuth: () => true }) as never,
			getModel: () => model,
			isModelExhausted: () => false,
			isDelegateToolActive: () => true,
			getCapabilityEnvelope: () => undefined,
			getGoalStateSnapshot: () => undefined,
			saveWorkerClaimSnapshot: () => "unused",
			addSpawnedUsage: () => undefined,
			notifyWorkerTerminalHandoff: async () => {},
			emitAutonomyTelemetry: () => {},
			emit: () => {},
		} as never);
		const started = controller.startWorkerDelegation({ instructions: "queued work" });
		expect(started).toMatchObject({ started: true, record: { status: "queued" } });

		controller.abortInFlightLanes();

		expect(getAppendCount()).toBe(1); // Only the lane record; no running worker means no claim.
		const laneRecords = getLaneRecordSnapshots(entries as never);
		expect(laneRecords).toEqual([
			expect.objectContaining({
				laneId: started.started ? started.record.laneId : "unreachable",
				status: "canceled",
				reasonCode: "session_disposed",
			}),
		]);
		expect(getWorkerClaimSnapshots(entries as never)).toEqual([]);
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("dispose never throws even when persistence deps are entirely missing (defensive try/catch per lane)", () => {
		// No getSessionManager/emit/saveWorkerClaimSnapshot at all -- every persist attempt must
		// fail silently (warn-and-continue), never propagate.
		const controller = new BackgroundLaneController({} as never);
		const internals = controller as unknown as {
			_laneTracker: {
				enqueue(args: { type: "research" }): { laneId: string };
				start(args: { type: "research" }): { laneId: string };
				getRecords(): Array<{ status: string }>;
			};
		};
		internals._laneTracker.enqueue({ type: "research" });
		internals._laneTracker.start({ type: "research" });

		expect(() => controller.abortInFlightLanes()).not.toThrow();
		expect(internals._laneTracker.getRecords().every((record) => record.status === "canceled")).toBe(true);
	});
});
