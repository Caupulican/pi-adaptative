import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHerdrBackend } from "../src/core/collaboration/herdr-runtime.ts";

const ports = vi.hoisted(() => ({
	watch: vi.fn(),
	spawn: vi.fn(),
	terminal: vi.fn(),
	kill: vi.fn(),
	connect: vi.fn(),
	write: vi.fn(),
}));
vi.mock("node:fs", () => ({ watch: ports.watch }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));
vi.mock("../src/config.ts", () => ({ getAgentDir: () => "/state" }));
vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: ports.spawn,
	waitForChildProcess: ports.terminal,
}));
vi.mock("@caupulican/pi-agent-core/process-tree", () => ({ killTree: ports.kill }));
vi.mock("../src/utils/tools-manager.ts", () => ({ getToolPath: () => "/bin/herdr" }));
vi.mock("../src/core/util/atomic-file.ts", () => ({ writeFileAtomic: ports.write }));
vi.mock("../src/core/collaboration/command-runner.ts", () => ({
	runCollaborationCommand: vi.fn(async () => ({
		reason: "exited",
		code: 0,
		stdout: "socket: /state/named/server.sock",
	})),
}));
vi.mock("../src/core/collaboration/herdr-backend.ts", () => ({ HerdrBackend: class {} }));
vi.mock("../src/core/collaboration/herdr-channel.ts", () => ({ connectHerdrChannel: ports.connect }));
vi.mock("../src/core/collaboration/herdr-managed-config.ts", () => ({
	ensureHerdrManagedConfiguration: vi.fn(),
}));
vi.mock("../src/core/collaboration/herdr-provision.ts", () => ({
	provisionHerdr: async () => ({ path: "/bin/herdr" }),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	ports.connect.mockRejectedValue(new Error("Socket unavailable"));
	ports.terminal.mockImplementation(() => new Promise(() => {}));
	ports.kill.mockResolvedValue("killed");
});
afterEach(() => vi.useRealTimers());

function fixture() {
	const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
	const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn(), kill: vi.fn() });
	ports.watch.mockReturnValue(watcher);
	ports.spawn.mockReturnValue(child as unknown as ChildProcess);
	const onTerminal = vi.fn();
	return {
		watcher,
		child,
		onTerminal,
		start: () => createHerdrBackend({ session: "named", configPath: "/state/config.toml", onTerminal }),
	};
}

it("awaits bounded process-tree cleanup after a startup timeout without inventing a terminal handoff", async () => {
	const f = fixture();
	let finishCleanup: ((outcome: string) => void) | undefined;
	ports.kill.mockImplementation(
		() =>
			new Promise<string>((resolve) => {
				finishCleanup = resolve;
			}),
	);
	let rejected = false;
	const started = f.start().catch((error: unknown) => {
		rejected = true;
		return error;
	});
	await vi.advanceTimersByTimeAsync(30000);
	expect(ports.kill).toHaveBeenCalledExactlyOnceWith(f.child);
	expect(rejected).toBe(false);
	finishCleanup?.("killed");
	expect(await started).toEqual(expect.objectContaining({ message: "Herdr server readiness deadline exceeded." }));
	expect(f.child.kill).not.toHaveBeenCalled();
	expect(f.child.unref).not.toHaveBeenCalled();
	expect(f.watcher.close).toHaveBeenCalledOnce();
	expect(ports.write).not.toHaveBeenCalled();
	expect(f.onTerminal).not.toHaveBeenCalled();
});

it("preserves the startup failure and discloses unconfirmed cleanup", async () => {
	const f = fixture();
	ports.kill.mockResolvedValue("failed");
	const started = f.start().catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(30000);
	expect(await started).toEqual(
		expect.objectContaining({
			message: expect.stringContaining("cleanup could not confirm process-tree termination"),
			cause: expect.objectContaining({ message: "Herdr server readiness deadline exceeded." }),
		}),
	);
	expect(f.onTerminal).not.toHaveBeenCalled();
	expect(f.watcher.close).toHaveBeenCalledOnce();
});

it("keeps an acknowledged live server detached without terminating it", async () => {
	const f = fixture();
	ports.connect.mockRejectedValueOnce(new Error("Socket unavailable")).mockResolvedValue({
		request: vi.fn(async () => ({ protocol: 20 })),
		close: vi.fn(),
	});
	await f.start();
	expect(f.child.unref).toHaveBeenCalledOnce();
	expect(ports.kill).not.toHaveBeenCalled();
	expect(f.watcher.close).toHaveBeenCalledOnce();
});
