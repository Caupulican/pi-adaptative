/**
 * Collaboration worker CLI: IPC failure versus resource cleanup.
 *
 * `runCollaborationWorker`'s `finally` (collaboration-worker.ts:118-123) begins with
 * `process.send?.({ type: "terminal", turnId }, () => process.disconnect?.())` and only then removes
 * the SIGTERM/SIGINT listeners and releases the work-directory lease. Both halves of that call are
 * unguarded at an OS boundary:
 *
 * - A synchronous throw from `process.send` (a closed IPC channel, a serialization failure) escapes
 *   the `finally` before any cleanup statement runs, so the lease and both signal listeners leak and
 *   the original outcome is replaced by the IPC error.
 * - The completion callback discards its `error` argument and calls `process.disconnect()`
 *   unconditionally. A send that failed *because* the channel is gone is exactly the case where
 *   `disconnect()` raises ERR_IPC_CHANNEL_CLOSED, and it raises it from an async callback where no
 *   try/finally is left to catch it.
 *
 * The existing controller coverage (collaboration-worker-controller.test.ts) stubs
 * `process.send` as unconditional success, so neither branch is ever taken.
 *
 * The callback throw is captured inside this file's own `process.send` stub, so it is observed as a
 * value and never reaches the runner as an uncaught exception.
 */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCollaborationWorker } from "../src/cli/collaboration-worker.ts";

const ports = vi.hoisted(() => ({
	construct: vi.fn(),
	claim: vi.fn(),
	load: vi.fn(),
	finish: vi.fn(),
	backend: vi.fn(),
	execute: vi.fn(),
	stop: vi.fn(),
	release: vi.fn(),
}));
vi.mock("../src/config.ts", () => ({ getAgentDir: () => "agent" }));
vi.mock("../src/utils/work-directory.ts", () => ({
	acquireWorkRun: () => ({ path: resolve("/managed"), release: ports.release }),
}));
vi.mock("../src/core/collaboration/herdr-runtime.ts", () => ({ createHerdrBackend: ports.backend }));
vi.mock("../src/core/collaboration/turn-runner.ts", () => ({ executeCollaborationTurn: ports.execute }));
vi.mock("../src/core/collaboration/coordinator.ts", () => ({ stopCollaborationAgent: ports.stop }));
vi.mock("../src/core/collaboration/job-store.ts", () => ({
	CollaborationJobStore: class {
		constructor() {
			ports.construct();
		}
		claimTurn = ports.claim;
		load = ports.load;
		finishTurn = ports.finish;
	},
}));

const args = [join(resolve("/managed"), "jobs"), "parent", "job", "agent", "turn", "null"];

type SendCallback = (error: Error | null) => void;

interface WorkerMessage {
	type?: string;
	turnId?: string;
}

function messageType(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	return (message as WorkerMessage).type;
}

function ipcError(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`mock ${code}`);
	error.code = code;
	return error;
}

interface ResourceState {
	releases: number;
	sigterm: number;
	sigint: number;
}

function resourceState(baseline: { sigterm: number; sigint: number }): ResourceState {
	return {
		releases: ports.release.mock.calls.length,
		sigterm: process.listenerCount("SIGTERM") - baseline.sigterm,
		sigint: process.listenerCount("SIGINT") - baseline.sigint,
	};
}

let exitCode: typeof process.exitCode;
let baseline: { sigterm: number; sigint: number };
let baselineListeners: { sigterm: Set<unknown>; sigint: Set<unknown> };

beforeEach(() => {
	exitCode = process.exitCode;
	vi.resetAllMocks();
	baseline = { sigterm: process.listenerCount("SIGTERM"), sigint: process.listenerCount("SIGINT") };
	baselineListeners = {
		sigterm: new Set(process.listeners("SIGTERM")),
		sigint: new Set(process.listeners("SIGINT")),
	};
	ports.claim.mockReturnValue(true);
	vi.spyOn(process, "send").mockImplementation(() => true);
	vi.spyOn(process, "disconnect").mockImplementation(() => {});
	ports.load.mockReturnValue({
		sessionName: "session",
		peerCommand: "pi --collaboration-peer",
		deadlineSeconds: 30,
		agents: [
			{
				id: "agent",
				backendName: "native",
				terminalId: "terminal",
				turnId: "turn",
				status: "running",
				deadlineAt: Date.now() + 30000,
				prompt: "work",
			},
		],
	});
	ports.backend.mockResolvedValue({});
	ports.execute.mockResolvedValue({ status: "done", evidence: "verified", usage: { tokens: 3 } });
	ports.stop.mockResolvedValue(undefined);
});

afterEach(() => {
	process.exitCode = exitCode;
	// A leaked signal listener is the defect under test; removing it here keeps that leak inside the
	// test that produced it instead of accumulating on the shared runner process.
	for (const listener of process.listeners("SIGTERM")) {
		if (!baselineListeners.sigterm.has(listener)) process.off("SIGTERM", listener);
	}
	for (const listener of process.listeners("SIGINT")) {
		if (!baselineListeners.sigint.has(listener)) process.off("SIGINT", listener);
	}
	vi.restoreAllMocks();
});

describe("collaboration worker IPC failure lifetime", () => {
	it("releases the work lease and signal listeners when the terminal send throws synchronously", async () => {
		vi.spyOn(process, "send").mockImplementation((message: unknown): boolean => {
			if (messageType(message) === "terminal") throw ipcError("ERR_IPC_CHANNEL_CLOSED");
			return true;
		});

		await runCollaborationWorker(args).catch(() => {});

		// finishTurn already persisted the result; the IPC failure must not strand the lease.
		expect(ports.finish).toHaveBeenCalledTimes(1);
		expect(resourceState(baseline)).toEqual({ releases: 1, sigterm: 0, sigint: 0 });
	});

	it("does not throw from the terminal send completion callback when the send reports failure", async () => {
		const deliveries: Array<() => void> = [];
		vi.spyOn(process, "send").mockImplementation((message: unknown, sendHandle?: unknown): boolean => {
			const callback = typeof sendHandle === "function" ? (sendHandle as SendCallback) : undefined;
			if (messageType(message) === "terminal" && callback) {
				// Node reports a failed send through the callback, not a synchronous throw.
				deliveries.push(() => callback(ipcError("ERR_IPC_CHANNEL_CLOSED")));
				return false;
			}
			return true;
		});
		vi.spyOn(process, "disconnect").mockImplementation(() => {
			throw ipcError("ERR_IPC_CHANNEL_CLOSED");
		});

		await runCollaborationWorker(args);

		let callbackError: unknown;
		for (const deliver of deliveries) {
			try {
				deliver();
			} catch (error) {
				// Captured here so a throwing callback is observed as a value, never as an uncaught
				// exception in the test runner - which is exactly how it would surface in production.
				callbackError = error;
			}
		}

		expect(deliveries).toHaveLength(1);
		expect(callbackError).toBeUndefined();
		expect(resourceState(baseline)).toEqual({ releases: 1, sigterm: 0, sigint: 0 });
	});

	it("does not stop an already-claimed turn because the ready notification could not be sent", async () => {
		// The turn is durably claimed at collaboration-worker.ts:48, before any IPC. A parent that has
		// already gone away cannot receive `ready`, but an admitted helper is documented to survive a
		// parent reload (coordinator.ts:174), so the claimed work must not be torn down here.
		vi.spyOn(process, "send").mockImplementation((message: unknown): boolean => {
			if (messageType(message) === "ready") throw ipcError("ERR_IPC_CHANNEL_CLOSED");
			return true;
		});

		await runCollaborationWorker(args).catch(() => {});

		expect(ports.stop).not.toHaveBeenCalled();
		expect(ports.execute).toHaveBeenCalledTimes(1);
		expect(resourceState(baseline)).toEqual({ releases: 1, sigterm: 0, sigint: 0 });
	});

	it("negative control: a connected worker persists one result, disconnects once and replays nothing", async () => {
		const sent: Array<string | undefined> = [];
		vi.spyOn(process, "send").mockImplementation((message: unknown, sendHandle?: unknown): boolean => {
			sent.push(messageType(message));
			if (typeof sendHandle === "function") (sendHandle as SendCallback)(null);
			return true;
		});
		const disconnect = vi.spyOn(process, "disconnect").mockImplementation(() => {});

		await runCollaborationWorker(args);

		expect(sent).toEqual(["ready", "terminal"]);
		expect(ports.execute).toHaveBeenCalledTimes(1);
		expect(ports.finish).toHaveBeenCalledExactlyOnceWith("job", "agent", "turn", "done", "verified", { tokens: 3 });
		expect(ports.stop).not.toHaveBeenCalled();
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(resourceState(baseline)).toEqual({ releases: 1, sigterm: 0, sigint: 0 });
	});
});
