// @isolated: mocks node:child_process to prove pre-aborted work is never launched
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CapabilityProofRunner } from "../src/core/adaptive/capability-proof-runner.ts";

function childFixture(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperties(child, {
		exitCode: { value: null, writable: true },
		pid: { value: undefined, writable: true },
		signalCode: { value: null, writable: true },
		stderr: { value: null },
		stdout: { value: null },
	});
	child.kill = vi.fn(() => {
		queueMicrotask(() => child.emit("close", null, "SIGKILL"));
		return true;
	}) as ChildProcess["kill"];
	return child;
}

beforeEach(() => {
	spawnMock.mockReset();
	spawnMock.mockReturnValue(childFixture());
});

describe("capability proof process lifecycle", () => {
	it("does not launch proof work whose cancellation was already observed", async () => {
		const cancellation = new AbortController();
		cancellation.abort();

		const result = await new CapabilityProofRunner({ defaultTimeoutMs: 10 }).runProof({
			proofId: "pre-aborted",
			kind: "deterministic_test",
			command: "never-run",
			cwd: process.cwd(),
			signal: cancellation.signal,
		});

		expect(spawnMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "failed", exitCode: null, signal: null });
	});

	it("launches admitted POSIX proof work as a process-group leader", async () => {
		const child = childFixture();
		Object.defineProperty(child, "pid", { value: 12345, writable: true });
		spawnMock.mockReturnValue(child);

		const pending = new CapabilityProofRunner({ defaultTimeoutMs: 1_000 }).runProof({
			proofId: "admitted",
			kind: "deterministic_test",
			command: "run-proof",
			cwd: process.cwd(),
		});
		Object.defineProperty(child, "exitCode", { value: 0, writable: true });
		child.emit("exit", 0, null);

		await expect(pending).resolves.toMatchObject({ status: "passed", exitCode: 0 });
		expect(spawnMock).toHaveBeenCalledWith(
			process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
			expect.any(Array),
			expect.objectContaining({ detached: process.platform !== "win32" }),
		);
	});
});
