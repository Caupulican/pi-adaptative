import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createLocalPlatformShellOperations } from "../src/core/tools/bash.ts";
import {
	createWindowsShellEngineOperations,
	WindowsShellEngineFailure,
	type WindowsShellEngineFrame,
} from "../src/core/tools/windows-shell-engine.ts";

const READY_RUNTIME = {
	status: "ready" as const,
	uvPath: "/fake/uv",
	pythonPath: "/fake/python",
	pythonInstalled: false,
};

const FRAME_SENTINEL = "\x1e";
const ENGINE_FRAME_SENTINEL_BYTE = 0x1e;

function frameBytes(frame: WindowsShellEngineFrame): Buffer {
	return Buffer.from(`${FRAME_SENTINEL}${JSON.stringify(frame)}${FRAME_SENTINEL}`, "utf8");
}

interface FakeChildHandles {
	child: ChildProcess;
	stdout: EventEmitter;
	stderr: EventEmitter;
	request: unknown;
}

/** A fake spawn that hands the parsed stdin request to `scenario` once stdin is closed, mirroring
 * the real engine's read-to-EOF stdin protocol without spawning any process. */
function fakeStream(): EventEmitter {
	const stream = new EventEmitter();
	Object.assign(stream, { destroy: () => {}, ref: () => {}, unref: () => {} });
	return stream;
}

function fakeSpawn(scenario: (handles: FakeChildHandles) => void) {
	return () => {
		const stdout = fakeStream();
		const stderr = fakeStream();
		const child = new EventEmitter() as unknown as ChildProcess;
		let stdinData = "";
		Object.assign(child, {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			stdout,
			stderr,
			unref: () => {},
			ref: () => {},
			stdin: {
				end: (data: string) => {
					stdinData += data;
					queueMicrotask(() => scenario({ child, stdout, stderr, request: JSON.parse(stdinData) }));
				},
			},
		});
		return child;
	};
}

async function collectOutput(exec: (onData: (data: Buffer) => void) => Promise<{ exitCode: number | null }>) {
	const chunks: Buffer[] = [];
	const result = await exec((chunk) => chunks.push(chunk));
	return { result, output: Buffer.concat(chunks).toString("utf8") };
}

describe("windows shell engine operations", () => {
	it("strips the control frame, streams merged output, and applies state on success", async () => {
		const spawn = fakeSpawn(({ child, stdout, stderr }) => {
			stdout.emit("data", Buffer.from("hello\n"));
			stderr.emit(
				"data",
				frameBytes({ exitCode: 0, cwd: "/new/dir", envDelta: { FOO: "bar", REMOVED: null }, unsupported: null }),
			);
			child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-success-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		const { result, output } = await collectOutput((onData) =>
			ops.exec("echo hello", "/old/dir", { onData, timeout: 30 }),
		);

		expect(output).toBe("hello\n");
		expect(result.exitCode).toBe(0);
	});

	it("throws the refusal message and still applies the frame's state", async () => {
		const spawn = fakeSpawn(({ child, stdout, stderr }) => {
			stdout.emit("data", Buffer.from("heredocs are not supported\n"));
			stderr.emit(
				"data",
				frameBytes({
					exitCode: 2,
					cwd: "/old/dir",
					envDelta: {},
					unsupported: { code: "unsupported", construct: "heredoc", message: "heredocs are not supported" },
				}),
			);
			child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-refusal-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		await expect(collectOutput((onData) => ops.exec("cat <<EOF\nEOF", "/old/dir", { onData }))).rejects.toThrow(
			"heredocs are not supported",
		);
	});

	it("throws a named engine-failure error with captured output when no frame is parseable", async () => {
		const spawn = fakeSpawn(({ child, stderr }) => {
			stderr.emit("data", Buffer.from("Traceback (most recent call last):\nBoom\n"));
			child.emit("close", 1);
		});
		const ops = createWindowsShellEngineOperations("engine-crash-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		let caught: unknown;
		try {
			await collectOutput((onData) => ops.exec("echo hi", "/old/dir", { onData }));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WindowsShellEngineFailure);
		const failure = caught as WindowsShellEngineFailure;
		expect(failure.name).toBe("WindowsShellEngineFailure");
		expect(failure.capturedOutput).toContain("Traceback");
		expect(failure.message).toContain("Traceback");
	});

	it("throws a named degradation error and never falls back to a wrong approximation", async () => {
		const ops = createWindowsShellEngineOperations("engine-degraded-session", {
			resolveRuntime: async () => ({ status: "python-unavailable", reason: "uv could not resolve Python" }),
			engineScriptPath: "/fake/main.py",
			spawn: fakeSpawn(() => {
				throw new Error("must not spawn when the runtime is not ready");
			}),
		});

		await expect(collectOutput((onData) => ops.exec("echo hi", "/old/dir", { onData }))).rejects.toThrow(
			/uv could not resolve Python.*PowerShell floor/s,
		);
	});

	it("passes through raw 0x1e bytes embedded in command output without truncation", async () => {
		const binaryWithSentinel = Buffer.concat([
			Buffer.from("before"),
			Buffer.from([ENGINE_FRAME_SENTINEL_BYTE]),
			Buffer.from("after"),
		]);
		const spawn = fakeSpawn(({ child, stdout, stderr }) => {
			stdout.emit("data", binaryWithSentinel);
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
			child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-binary-output-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		const chunks: Buffer[] = [];
		const result = await ops.exec("cat binary-file", "/old/dir", { onData: (chunk) => chunks.push(chunk) });

		expect(Buffer.concat(chunks)).toEqual(binaryWithSentinel);
		expect(result.exitCode).toBe(0);
	});

	it("reassembles a large multi-chunk output with the frame arriving in the final chunk", async () => {
		const largeOutput = Buffer.from("x".repeat(50_000));
		const spawn = fakeSpawn(({ child, stdout, stderr }) => {
			const chunkSize = 4096;
			for (let offset = 0; offset < largeOutput.length; offset += chunkSize) {
				stdout.emit("data", largeOutput.subarray(offset, offset + chunkSize));
			}
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
			child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-large-output-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		const { result, output } = await collectOutput((onData) => ops.exec("big-command", "/old/dir", { onData }));

		expect(output).toBe(largeOutput.toString("utf8"));
		expect(result.exitCode).toBe(0);
	});

	it("sets the request's timeoutMs to exactly 500ms less than the hard exec timeout, and omits it when unset", async () => {
		let capturedRequestWithTimeout: { timeoutMs?: number } | undefined;
		const spawnWithTimeout = fakeSpawn(({ child, stderr, request }) => {
			capturedRequestWithTimeout = request as { timeoutMs?: number };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
			child.emit("close", 0);
		});
		const opsWithTimeout = createWindowsShellEngineOperations("engine-timeout-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: spawnWithTimeout,
		});
		await collectOutput((onData) => opsWithTimeout.exec("echo hi", "/old/dir", { onData, timeout: 30 }));
		expect(capturedRequestWithTimeout?.timeoutMs).toBe(30 * 1000 - 500);

		let capturedRequestNoTimeout: { timeoutMs?: number } | undefined;
		const spawnNoTimeout = fakeSpawn(({ child, stderr, request }) => {
			capturedRequestNoTimeout = request as { timeoutMs?: number };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
			child.emit("close", 0);
		});
		const opsNoTimeout = createWindowsShellEngineOperations("engine-no-timeout-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: spawnNoTimeout,
		});
		await collectOutput((onData) => opsNoTimeout.exec("echo hi", "/old/dir", { onData }));
		expect(capturedRequestNoTimeout?.timeoutMs).toBeUndefined();
	});

	it("threads engine cwd/env state into the very next createLocalPlatformShellOperations call, even to the PS tier", async () => {
		const sessionKey = "handoff-session";
		const psCalls: Array<{ cwd: string; env?: NodeJS.ProcessEnv }> = [];
		const fakePsOperations = {
			exec: async (_command: string, cwd: string, options: { env?: NodeJS.ProcessEnv }) => {
				psCalls.push({ cwd, env: options.env });
				return { exitCode: 0 };
			},
		};
		const spawn = fakeSpawn(({ child, stderr, request }) => {
			const parsed = request as { command: string };
			const frame: WindowsShellEngineFrame =
				parsed.command === "cd /new/dir"
					? { exitCode: 0, cwd: "/new/dir", envDelta: {}, unsupported: null }
					: { exitCode: 0, cwd: "/new/dir", envDelta: { FOO: "bar" }, unsupported: null };
			stderr.emit("data", frameBytes(frame));
			child.emit("close", 0);
		});
		const operations = createLocalPlatformShellOperations(
			{
				sessionKey,
				pythonEngine: true,
				operations: fakePsOperations,
				engineOptions: { resolveRuntime: async () => READY_RUNTIME, engineScriptPath: "/fake/main.py", spawn },
			},
			"win32",
		);

		await operations.exec("cd /new/dir", "/old/dir", { onData: () => {} });
		await operations.exec("export FOO=bar", "/old/dir", { onData: () => {} });
		await operations.exec("echo hi", "/old/dir", { onData: () => {} });

		expect(psCalls).toHaveLength(1);
		expect(psCalls[0].cwd).toBe("/new/dir");
		expect(psCalls[0].env?.FOO).toBe("bar");
	});
});
