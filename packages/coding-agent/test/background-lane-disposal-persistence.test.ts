import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerRequest, WorkerResult } from "../src/core/autonomy/contracts.ts";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { appendWorkerResultSnapshot, getWorkerResultSnapshots } from "../src/core/delegation/session-worker-result.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";

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

	it("persists a durable canceled lane record + a bounded worker-result (with changedFiles) synchronously at the disposal cutoff, and appends nothing after dispose returns", async () => {
		const agentDir = "/tmp/pi-test-disposal-persistence";
		const model = { provider: "test", id: "test-model", contextWindow: 128_000 };
		const { sessionManager, entries, getAppendCount } = makeTrackedSessionManager();

		let disposed = false;
		let capturedAfterToolCall: FakeIsolatedCompletionOptions["afterToolCall"];

		const controller = new BackgroundLaneController({
			isDisposed: () => disposed,
			getSessionId: () => "test-session",
			getCwd: () => "/repo",
			getAgentDir: () => agentDir,
			getSessionManager: () => sessionManager,
			getSettingsManager: () =>
				({
					getWorkerDelegationSettings: () => ({
						enabled: true,
						maxUsd: 1,
						maxConcurrent: 4,
						maxWallClockMs: 0,
						writeEnabled: false,
						writePaths: [],
					}),
					getModelCapabilitySettings: () => ({ mode: "off" }),
				}) as never,
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
			saveWorkerResultSnapshot: (result: WorkerResult, request?: WorkerRequest) =>
				appendWorkerResultSnapshot(sessionManager, result, request),
			addSpawnedUsage: () => undefined,
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

		expect(getAppendCount()).toBe(2); // one canceled lane record + one bounded canceled worker-result
		const laneRecords = getLaneRecordSnapshots(entries as never);
		expect(laneRecords).toEqual([
			expect.objectContaining({ type: "worker", status: "canceled", reasonCode: "session_disposed" }),
		]);
		const workerResults = getWorkerResultSnapshots(entries as never);
		expect(workerResults).toEqual([
			expect.objectContaining({
				status: "cancelled",
				changedFiles: ["notes/output.md"],
			}),
		]);

		const appendCountAtCutoff = getAppendCount();

		// Let the in-flight worker's suspended await finally settle (the abort signal races it via
		// runBoundedCompletion) and the post-await disposed branch in runWorkerDelegationOnce run.
		const outcome = await runPromise;
		expect(outcome.started).toBe(true);

		// No append happened after dispose returned -- the consumed-ledger guard held.
		expect(getAppendCount()).toBe(appendCountAtCutoff);
	});

	it("persists a durable canceled lane record for a queued (never-started) worker, with no fabricated worker-result (no ledger exists for a lane that never ran)", () => {
		const { sessionManager, entries, getAppendCount } = makeTrackedSessionManager();

		const controller = new BackgroundLaneController({
			getSessionManager: () => sessionManager,
			saveWorkerResultSnapshot: () => "unused",
			addSpawnedUsage: () => undefined,
			emit: () => {},
		} as never);
		const internals = controller as unknown as {
			_laneTracker: { enqueue(args: { type: "worker" }): { laneId: string } };
		};
		const queued = internals._laneTracker.enqueue({ type: "worker" });

		controller.abortInFlightLanes();

		expect(getAppendCount()).toBe(1); // only the lane record -- no ledger means no WorkerResult
		const laneRecords = getLaneRecordSnapshots(entries as never);
		expect(laneRecords).toEqual([
			expect.objectContaining({ laneId: queued.laneId, status: "canceled", reasonCode: "session_disposed" }),
		]);
		expect(getWorkerResultSnapshots(entries as never)).toEqual([]);
	});

	it("dispose never throws even when persistence deps are entirely missing (defensive try/catch per lane)", () => {
		// No getSessionManager/emit/saveWorkerResultSnapshot at all -- every persist attempt must
		// fail silently (warn-and-continue), never propagate.
		const controller = new BackgroundLaneController({} as never);
		const internals = controller as unknown as {
			_laneTracker: {
				enqueue(args: { type: "worker" }): { laneId: string };
				start(args: { type: "research" }): { laneId: string };
			};
		};
		internals._laneTracker.enqueue({ type: "worker" });
		internals._laneTracker.start({ type: "research" });

		expect(() => controller.abortInFlightLanes()).not.toThrow();
		expect(controller.getActiveLaneCount()).toBe(0);
	});
});
