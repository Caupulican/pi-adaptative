import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ProcessMatrixRuntimeHandle, ResumeWorkerLaunchOutcome } from "../src/core/process-matrix/runtime.ts";
import { SessionSupervisionRuntime } from "../src/core/session-supervision-runtime.ts";
import type { WorktreeSyncRuntimeHandle } from "../src/core/worktree-sync/runtime.ts";

const runtimeMocks = vi.hoisted(() => ({
	startProcessMatrixRuntime: vi.fn(),
	startWorktreeSyncRuntime: vi.fn(),
}));

vi.mock("../src/core/process-matrix/runtime.ts", () => ({
	getOrchestrationAgentId: () => undefined,
	getProcessTaskRef: () => undefined,
	startProcessMatrixRuntime: runtimeMocks.startProcessMatrixRuntime,
}));

vi.mock("../src/core/worktree-sync/runtime.ts", () => ({
	getBoundWorktreeLaneKey: () => undefined,
	startWorktreeSyncRuntime: runtimeMocks.startWorktreeSyncRuntime,
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createSupervision(): SessionSupervisionRuntime {
	return new SessionSupervisionRuntime({
		agentDir: "/agent",
		isProcessAlive: () => true,
		resumeWorker: async () => ({ status: "started" }) as unknown as ResumeWorkerLaunchOutcome,
		onDiagnostic: () => {},
		requestExit: async () => {},
	});
}

function createSession(): AgentSession {
	return {
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
			getSessionDir: () => "/sessions",
			getCwd: () => "/workspace",
		},
		settingsManager: {
			getActiveOrchestrationProfile: () => undefined,
			getActiveResourceProfileNames: () => [],
			getProcessMatrixSettings: () => ({}),
		},
		getGoalStateSnapshot: () => undefined,
		model: undefined,
	} as unknown as AgentSession;
}

describe("SessionSupervisionRuntime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not finish stop while a concurrent start can still publish handles", async () => {
		const worktree = deferred<WorktreeSyncRuntimeHandle>();
		const processMatrix = deferred<ProcessMatrixRuntimeHandle>();
		const stopWorktree = vi.fn(async () => {});
		const stopProcessMatrix = vi.fn(async () => {});
		runtimeMocks.startWorktreeSyncRuntime.mockReturnValueOnce(worktree.promise);
		runtimeMocks.startProcessMatrixRuntime.mockReturnValueOnce(processMatrix.promise);

		const supervision = createSupervision();
		const start = supervision.start(createSession());
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(runtimeMocks.startWorktreeSyncRuntime).toHaveBeenCalledOnce();
		expect(runtimeMocks.startProcessMatrixRuntime).toHaveBeenCalledOnce();
		let stopSettled = false;
		const stop = supervision.stop().then(() => {
			stopSettled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stopSettled).toBe(false);

		worktree.resolve({ stop: stopWorktree });
		processMatrix.resolve({ stop: stopProcessMatrix, waitForIdle: async () => {} });
		await Promise.all([start, stop]);

		expect(stopWorktree).toHaveBeenCalledOnce();
		expect(stopProcessMatrix).toHaveBeenCalledOnce();
	});

	it("stops a started peer when the other supervisor fails to start", async () => {
		const stopWorktree = vi.fn(async () => {});
		runtimeMocks.startWorktreeSyncRuntime.mockResolvedValueOnce({ stop: stopWorktree });
		runtimeMocks.startProcessMatrixRuntime.mockRejectedValueOnce(new Error("process matrix start failed"));

		const supervision = createSupervision();
		await expect(supervision.start(createSession())).rejects.toThrow("process matrix start failed");
		expect(stopWorktree).toHaveBeenCalledOnce();
	});

	it("waits for every supervisor stop when one stop fails", async () => {
		const processStop = deferred<void>();
		const stopWorktree = vi.fn(async () => {
			throw new Error("worktree stop failed");
		});
		const stopProcessMatrix = vi.fn(() => processStop.promise);
		runtimeMocks.startWorktreeSyncRuntime.mockResolvedValueOnce({ stop: stopWorktree });
		runtimeMocks.startProcessMatrixRuntime.mockResolvedValueOnce({
			stop: stopProcessMatrix,
			waitForIdle: async () => {},
		});

		const supervision = createSupervision();
		await supervision.start(createSession());
		let stopSettled = false;
		const stop = supervision.stop().finally(() => {
			stopSettled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(stopWorktree).toHaveBeenCalledOnce();
		expect(stopProcessMatrix).toHaveBeenCalledOnce();
		expect(stopSettled).toBe(false);
		processStop.resolve(undefined);
		await expect(stop).rejects.toThrow("worktree stop failed");
	});
});
