import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
let exitCode: typeof process.exitCode;
beforeEach(() => {
	exitCode = process.exitCode;
	vi.resetAllMocks();
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
	vi.restoreAllMocks();
});

it("releases its work lease and signal handlers even when state construction fails", async () => {
	const before = process.listenerCount("SIGTERM");
	ports.construct.mockImplementation(() => {
		throw new Error("corrupt state root");
	});
	await expect(runCollaborationWorker(args)).resolves.toBeUndefined();
	expect(ports.release).toHaveBeenCalledTimes(1);
	expect(process.listenerCount("SIGTERM")).toBe(before);
	expect(ports.backend).not.toHaveBeenCalled();
});

it("never submits an already claimed or superseded turn", async () => {
	ports.claim.mockReturnValue(false);
	await runCollaborationWorker(args);
	expect(ports.backend).not.toHaveBeenCalled();
	expect(ports.execute).not.toHaveBeenCalled();
	expect(ports.stop).not.toHaveBeenCalled();
	expect(ports.release).toHaveBeenCalledTimes(1);
});

it("persists exactly one stopped result including advisory usage", async () => {
	await runCollaborationWorker(args);
	expect(ports.execute).toHaveBeenCalledTimes(1);
	expect(ports.finish).toHaveBeenCalledExactlyOnceWith("job", "agent", "turn", "done", "verified", { tokens: 3 });
	expect(ports.stop).not.toHaveBeenCalled();
	expect(ports.release).toHaveBeenCalledTimes(1);
});

it("keeps uncertain native work fenced when delivery and cleanup both fail", async () => {
	ports.execute.mockRejectedValue(new Error("delivery unknown"));
	ports.stop.mockRejectedValue(new Error("backend offline"));
	await runCollaborationWorker(args);
	expect(ports.execute).toHaveBeenCalledTimes(1);
	expect(ports.stop).toHaveBeenCalledTimes(1);
	expect(ports.finish).not.toHaveBeenCalled();
	expect(ports.release).toHaveBeenCalledTimes(1);
});
