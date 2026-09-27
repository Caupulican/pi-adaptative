// @isolated: mocks node:child_process to exercise the pre-spawn ownership window
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { launchRuntimeChild } from "../src/cli/runtime-child-process.ts";

function childFixture(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperties(child, {
		connected: { value: false, writable: true },
		exitCode: { value: null, writable: true },
		pid: { value: undefined, writable: true },
		signalCode: { value: null, writable: true },
	});
	child.kill = vi.fn(() => true) as ChildProcess["kill"];
	child.send = vi.fn() as unknown as ChildProcess["send"];
	return child;
}

function launch(child: ChildProcess) {
	spawnMock.mockReturnValue(child);
	return launchRuntimeChild({ executable: "pi-runtime", argsPrefix: [] }, [], {
		cwd: process.cwd(),
		env: { ...process.env },
		terminal: "ignore",
	});
}

beforeEach(() => {
	spawnMock.mockReset();
});

describe("runtime child process ownership", () => {
	it("does not signal a child when stop wins before spawn ownership", async () => {
		const child = childFixture();
		const runtime = launch(child);

		runtime.stop();
		expect(child.kill).not.toHaveBeenCalled();

		child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
		await expect(runtime.terminal).resolves.toBe(1);
		expect(child.kill).not.toHaveBeenCalled();

		Object.defineProperty(child, "pid", { value: 12345, writable: true });
		child.emit("spawn");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("delivers one deferred termination after spawn grants ownership", async () => {
		const child = childFixture();
		const runtime = launch(child);

		runtime.stop();
		expect(child.kill).not.toHaveBeenCalled();

		Object.defineProperty(child, "pid", { value: 12345, writable: true });
		child.emit("spawn");
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");

		child.emit("exit", null, "SIGTERM");
		await expect(runtime.terminal).resolves.toBe(1);
		runtime.stop();
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
});
