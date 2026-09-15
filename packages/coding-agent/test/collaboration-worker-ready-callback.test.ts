/**
 * Collaboration worker CLI: the ready notification has no delivery-failure handler.
 *
 * The terminal notification supplies a completion callback
 * (`process.send({type:"terminal"}, () => process.disconnect?.())`, collaboration-worker.ts:119).
 * The ready notification does not: `process.send?.({ type: "ready", turnId })`
 * (collaboration-worker.ts:50) is a bare send.
 *
 * Node's contract for that shape: "If no callback function is provided and the message cannot be
 * sent, an 'error' event will be emitted" - on the sending side's own `process`/ChildProcess object.
 * `process` is an EventEmitter, so an 'error' event with no registered listener is raised as an
 * uncaught exception. The worker registers no `process.on("error")` handler anywhere, so an
 * asynchronously failed ready notification terminates the worker mid-turn, after `claimTurn` has
 * already durably claimed the work at :48.
 *
 * batch3's collaboration-worker-ipc-lifetime.test.ts covers only the SYNCHRONOUS ready-send throw,
 * which the surrounding try/catch does contain. This file covers the asynchronous path, which
 * nothing contains.
 *
 * The failure is captured as a recorded observation, never emitted: the stub inspects the send's
 * arguments and the live `process` error-listener count at call time and records whether a delivery
 * failure would have had anywhere to go. Nothing is ever emitted on the shared runner `process`.
 */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCollaborationWorker } from "../src/cli/collaboration-worker.ts";

const ports = vi.hoisted(() => ({
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
		claimTurn = ports.claim;
		load = ports.load;
		finishTurn = ports.finish;
	},
}));

const args = [join(resolve("/managed"), "jobs"), "parent", "job", "agent", "turn", "null"];

interface WorkerMessage {
	type?: string;
}

function messageType(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	return (message as WorkerMessage).type;
}

/** One recorded `process.send` call: which message, and where a delivery failure could be reported. */
interface SendRecord {
	type: string | undefined;
	hasCallback: boolean;
	/** `process.on("error")` listeners registered at send time - the only fallback Node would use. */
	processErrorListeners: number;
}

let exitCode: typeof process.exitCode;
let records: SendRecord[];

beforeEach(() => {
	exitCode = process.exitCode;
	vi.resetAllMocks();
	records = [];
	ports.claim.mockReturnValue(true);
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
	vi.spyOn(process, "disconnect").mockImplementation(() => {});
	vi.spyOn(process, "send").mockImplementation((message: unknown, sendHandle?: unknown): boolean => {
		records.push({
			type: messageType(message),
			hasCallback: typeof sendHandle === "function",
			processErrorListeners: process.listenerCount("error"),
		});
		return true;
	});
});

afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
});

describe("collaboration worker ready notification delivery", () => {
	it("gives the ready notification somewhere to report an asynchronous delivery failure", async () => {
		await runCollaborationWorker(args);

		const ready = records.find((record) => record.type === "ready");
		expect(ready).toBeDefined();
		// The completion callback is the only handler the worker itself controls, so it is the only
		// thing asserted here. `processErrorListeners` is recorded for diagnosis but deliberately not
		// asserted: this runner registers its own `process.on("error")` listener, while a real worker
		// process registers none, so a specific count would be an assertion about the test host.
		expect(ready?.hasCallback).toBe(true);
	});

	it("negative control: the terminal notification already supplies a completion callback", async () => {
		await runCollaborationWorker(args);

		const terminal = records.find((record) => record.type === "terminal");
		expect(terminal?.hasCallback).toBe(true);
	});

	it("negative control: a worker with no IPC channel still runs and finishes its turn", async () => {
		const original = Object.getOwnPropertyDescriptor(process, "send");
		vi.restoreAllMocks();
		vi.spyOn(process, "disconnect").mockImplementation(() => {});
		// A worker launched without an IPC channel has no `process.send` at all; the optional call
		// must remain a no-op rather than a failure path.
		Object.defineProperty(process, "send", { value: undefined, configurable: true, writable: true });
		try {
			await runCollaborationWorker(args);
		} finally {
			if (original) Object.defineProperty(process, "send", original);
		}

		expect(ports.execute).toHaveBeenCalledTimes(1);
		expect(ports.finish).toHaveBeenCalledExactlyOnceWith("job", "agent", "turn", "done", "verified", { tokens: 3 });
		expect(ports.stop).not.toHaveBeenCalled();
		expect(ports.release).toHaveBeenCalledTimes(1);
	});
});
