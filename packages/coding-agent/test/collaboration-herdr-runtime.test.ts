import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHerdrBackend, probeHerdrSocket } from "../src/core/collaboration/herdr-runtime.ts";

const ports = vi.hoisted(() => ({
	watch: vi.fn(),
	spawn: vi.fn(),
	terminal: vi.fn(),
	kill: vi.fn(),
	connect: vi.fn(),
	write: vi.fn(),
	realpath: vi.fn((path: string) => path),
}));
vi.mock("node:fs", () => ({ watch: ports.watch, realpathSync: { native: ports.realpath } }));
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
	ports.realpath.mockImplementation((path: string) => path);
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

it.each([true, false])(
	"canonicalizes readiness watcher paths without changing readiness or cleanup (alias=%s)",
	async (alias) => {
		const f = fixture();
		const canonical = String.raw`C:\Users\Runner Administrator\herdr\sessions\named`;
		ports.realpath.mockImplementation((path: string) => (alias ? canonical : path));
		ports.connect
			.mockRejectedValueOnce(new Error("Socket unavailable"))
			.mockResolvedValue({ request: vi.fn(async () => ({ protocol: 20 })), close: vi.fn() });
		await f.start();
		const original =
			process.platform === "win32"
				? join(process.env.APPDATA ?? "/state", "herdr", "sessions", "named")
				: "/state/named";
		expect(ports.watch).toHaveBeenCalledExactlyOnceWith(alias ? canonical : original, expect.any(Function));
		expect(f.child.unref).toHaveBeenCalledOnce();
		expect(f.watcher.close).toHaveBeenCalledOnce();
		expect(ports.kill).not.toHaveBeenCalled();
	},
);

it("drains coalesced readiness event when filesystem callback fires during in-flight probe", async () => {
	const f = fixture();
	let rejectInflightProbe: ((error: Error) => void) | undefined;
	const channel = { request: vi.fn(async () => ({ protocol: 20 })), close: vi.fn() };

	ports.connect
		.mockRejectedValueOnce(new Error("Existing server unavailable"))
		.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectInflightProbe = reject;
				}),
		)
		.mockResolvedValueOnce(channel);

	const started = f.start();
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 2; i++) {
		await Promise.resolve();
	}

	expect(ports.connect).toHaveBeenCalledTimes(2);
	expect(ports.watch).toHaveBeenCalledOnce();
	const watchCallback = ports.watch.mock.calls[0]?.[1];
	expect(watchCallback).toBeTypeOf("function");

	// Filesystem event fires while postspawn probe is in flight
	watchCallback();

	// Inflight probe rejects
	rejectInflightProbe!(new Error("Socket not ready yet"));
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 3; i++) {
		await Promise.resolve();
	}

	// Should have drained the pending event by probing again (call 3) and succeeded
	const backend = await started;
	expect(backend).toBeDefined();
	expect(ports.connect).toHaveBeenCalledTimes(3);
	expect(f.child.unref).toHaveBeenCalledOnce();
	expect(ports.kill).not.toHaveBeenCalled();
	expect(f.watcher.close).toHaveBeenCalledOnce();
});

it("does not repeat probe without an event (no polling)", async () => {
	const f = fixture();
	let rejectInflightProbe: ((error: Error) => void) | undefined;

	ports.connect.mockRejectedValueOnce(new Error("Existing server unavailable")).mockImplementationOnce(
		() =>
			new Promise((_, reject) => {
				rejectInflightProbe = reject;
			}),
	);

	const started = f.start().catch((err: unknown) => err);
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 2; i++) {
		await Promise.resolve();
	}

	expect(ports.connect).toHaveBeenCalledTimes(2);

	// Inflight probe rejects without any watch callback having fired
	rejectInflightProbe!(new Error("Socket not ready yet"));
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}

	// Advance timers by 5s — must NOT poll or retry without an event
	await vi.advanceTimersByTimeAsync(5000);
	expect(ports.connect).toHaveBeenCalledTimes(2);

	// Timeout at 30s
	await vi.advanceTimersByTimeAsync(25000);
	expect(await started).toEqual(expect.objectContaining({ message: "Herdr server readiness deadline exceeded." }));
	expect(ports.connect).toHaveBeenCalledTimes(2);
});

it("coalesces multiple filesystem events into a single follow-up probe", async () => {
	const f = fixture();
	let rejectInflightProbe: ((error: Error) => void) | undefined;
	const channel = { request: vi.fn(async () => ({ protocol: 20 })), close: vi.fn() };

	ports.connect
		.mockRejectedValueOnce(new Error("Existing server unavailable"))
		.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectInflightProbe = reject;
				}),
		)
		.mockResolvedValueOnce(channel);

	const started = f.start();
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 2; i++) {
		await Promise.resolve();
	}

	const watchCallback = ports.watch.mock.calls[0]?.[1];
	// Multiple events fire in rapid succession during inflight probe
	watchCallback();
	watchCallback();
	watchCallback();
	watchCallback();

	// Inflight probe fails
	rejectInflightProbe!(new Error("Socket not ready yet"));
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 3; i++) {
		await Promise.resolve();
	}

	const backend = await started;
	expect(backend).toBeDefined();
	// Total calls: 1 (existing) + 1 (postspawn) + 1 (coalesced follow-up) = 3
	expect(ports.connect).toHaveBeenCalledTimes(3);
});

it("ignores late probe success and ignores watch events after closure", async () => {
	const f = fixture();
	let resolveLateProbe: ((value: unknown) => void) | undefined;
	const channel = { request: vi.fn(async () => ({ protocol: 20 })), close: vi.fn() };

	ports.connect.mockRejectedValueOnce(new Error("Existing server unavailable")).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveLateProbe = resolve;
			}),
	);

	const started = f.start().catch((err: unknown) => err);
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 2; i++) {
		await Promise.resolve();
	}

	// Timeout occurs at 30s while probe is still in flight
	await vi.advanceTimersByTimeAsync(30000);
	expect(await started).toEqual(expect.objectContaining({ message: "Herdr server readiness deadline exceeded." }));
	expect(f.watcher.close).toHaveBeenCalledOnce();

	// Now late probe succeeds
	resolveLateProbe!(channel);
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}

	// Server should NOT be unreferenced or treated as live
	expect(f.child.unref).not.toHaveBeenCalled();

	// Further watch events after closure must be ignored
	const watchCallback = ports.watch.mock.calls[0]?.[1];
	watchCallback();
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	expect(ports.connect).toHaveBeenCalledTimes(2);
});

it("fences readiness immediately upon child termination even when terminal record write is deferred", async () => {
	const f = fixture();
	let resolveTerminal: ((code: number) => void) | undefined;
	ports.terminal.mockImplementation(
		() =>
			new Promise<number>((resolve) => {
				resolveTerminal = resolve;
			}),
	);

	let resolveWrite: (() => void) | undefined;
	ports.write.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				resolveWrite = resolve;
			}),
	);

	let resolveInflightProbe: ((value: unknown) => void) | undefined;
	const channel = { request: vi.fn(async () => ({ protocol: 20 })), close: vi.fn() };
	ports.connect.mockRejectedValueOnce(new Error("Existing server unavailable")).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveInflightProbe = resolve;
			}),
	);

	const started = f.start().catch((err: unknown) => err);
	for (let i = 0; i < 20 && ports.connect.mock.calls.length < 2; i++) {
		await Promise.resolve();
	}

	// Child terminates before probe finishes; terminal write starts and is pending (deferred)
	resolveTerminal!(1);
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}

	expect(ports.write).toHaveBeenCalledOnce();

	// While terminal write is still pending, late probe resolves
	resolveInflightProbe!(channel);
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}

	// Started should have failed with termination error, not succeeded via late probe
	expect(await started).toEqual(expect.objectContaining({ message: "Herdr server terminated before readiness." }));
	expect(f.child.unref).not.toHaveBeenCalled();

	// Finish deferred write
	resolveWrite!();
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	expect(f.onTerminal).toHaveBeenCalledOnce();
});

it("exports probeHerdrSocket validating protocol via isSupportedHerdrProtocol", async () => {
	const channel = {
		request: vi.fn(async () => ({ protocol: 20 })),
		close: vi.fn(),
	};
	ports.connect.mockResolvedValueOnce(channel);
	await expect(probeHerdrSocket("/test/socket.sock")).resolves.toBeUndefined();
	expect(channel.close).toHaveBeenCalledOnce();

	// Injected custom connector works
	const customConnect = vi.fn().mockResolvedValueOnce(channel);
	await expect(probeHerdrSocket("/test/socket.sock", customConnect)).resolves.toBeUndefined();
	expect(customConnect).toHaveBeenCalledOnce();

	// Supports protocol 22 from installed live server
	const channel22 = {
		request: vi.fn(async () => ({ protocol: 22 })),
		close: vi.fn(),
	};
	ports.connect.mockResolvedValueOnce(channel22);
	await expect(probeHerdrSocket("/test/socket.sock")).resolves.toBeUndefined();
	expect(channel22.close).toHaveBeenCalledOnce();

	const invalidChannel = {
		request: vi.fn(async () => ({ protocol: 99 })),
		close: vi.fn(),
	};
	ports.connect.mockResolvedValueOnce(invalidChannel);
	await expect(probeHerdrSocket("/test/socket.sock")).rejects.toThrow(
		"The installed Herdr server does not expose the supported collaboration protocol.",
	);
	expect(invalidChannel.close).toHaveBeenCalledOnce();
});
