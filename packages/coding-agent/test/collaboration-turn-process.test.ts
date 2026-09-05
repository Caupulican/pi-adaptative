import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
	CollaborationAgent,
	CollaborationJob,
	CollaborationJobStore,
} from "../src/core/collaboration/job-store.ts";
import { launchCollaborationTurnProcess } from "../src/core/collaboration/turn-process.ts";

const ports = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn(), kill: vi.fn() }));
vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: ports.spawn }));
vi.mock("@caupulican/pi-agent-core/process-tree", () => ({ killTree: ports.kill }));
vi.mock("../src/core/collaboration/coordinator.ts", () => ({ stopCollaborationAgent: ports.stop }));
vi.mock("../src/core/process-matrix/self-launch-target.ts", () => ({
	getSelfLaunchTarget: () => ({ executable: "host", argsPrefix: [] }),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	ports.stop.mockResolvedValue(undefined);
	ports.kill.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function fixture() {
	const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), channel: { unref: vi.fn() } });
	ports.spawn.mockReturnValue(child as unknown as ChildProcess);
	const agent = { id: "one", turnId: "turn", status: "reserved" } as CollaborationAgent;
	const job = { id: "job", cwd: "/work", agents: [agent] } as CollaborationJob;
	const store = {
		directory: "/state",
		parentSessionId: "parent",
		load: vi.fn(() => job),
	} as unknown as CollaborationJobStore;
	return { child, agent, job, store, start: () => launchCollaborationTurnProcess(store, job, agent) };
}

it("admits one exact ready event and never treats a duplicate as another admission", async () => {
	const f = fixture();
	const started = f.start();
	f.child.emit("message", { type: "ready", turnId: "old" });
	expect(f.child.unref).not.toHaveBeenCalled();
	f.child.emit("message", { type: "ready", turnId: "turn" });
	await started;
	f.child.emit("message", { type: "ready", turnId: "turn" });
	expect(f.child.unref).toHaveBeenCalledTimes(1);
	f.agent.status = "done";
	f.child.emit("exit", 0);
	await Promise.resolve();
	expect(ports.stop).not.toHaveBeenCalled();
});

it("terminates a startup timeout through the process-tree owner and ignores late readiness", async () => {
	const f = fixture();
	const rejected = expect(f.start()).rejects.toThrow(/startup timed out/);
	await vi.advanceTimersByTimeAsync(30000);
	await rejected;
	f.child.emit("message", { type: "ready", turnId: "turn" });
	expect(f.child.unref).not.toHaveBeenCalled();
	expect(ports.kill).toHaveBeenCalledExactlyOnceWith(f.child);
	f.agent.status = "done";
	f.child.emit("exit", 1);
});

it("an early helper exit cleans only the admitted current turn without replaying input", async () => {
	const f = fixture();
	const rejected = expect(f.start()).rejects.toThrow(/before admission/);
	f.child.emit("exit", 1);
	await rejected;
	expect(ports.stop).toHaveBeenCalledWith(
		f.store,
		expect.any(Function),
		"job",
		"one",
		"turn",
		expect.stringContaining("will not be replayed"),
	);
	expect(ports.spawn).toHaveBeenCalledTimes(1);
});

it("a late helper exit cannot stop a successor turn", async () => {
	const f = fixture();
	const started = f.start();
	f.child.emit("message", { type: "ready", turnId: "turn" });
	await started;
	f.job.agents = [{ ...f.agent, turnId: "successor" }];
	f.child.emit("exit", 1);
	await Promise.resolve();
	expect(ports.stop).not.toHaveBeenCalled();
});
