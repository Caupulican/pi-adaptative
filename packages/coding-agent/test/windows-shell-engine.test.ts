import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createLocalPlatformShellOperations } from "../src/core/tools/bash.ts";
import {
	createWindowsShellEngineOperations,
	disposeWindowsShellEngineSession,
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

/** Persistent coordinator fake. It correlates legacy frame fixtures to the request id and emits
 * the stdout barrier after each synchronous scenario, keeping individual tests focused on their
 * command behavior. A scenario that emits no frame can still terminate the child to model a crash. */
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
		let requestId: string | undefined;
		let emittedFrame = false;
		const emitControl = stderr.emit.bind(stderr);
		Object.assign(stderr, {
			emit: (eventName: string | symbol, ...args: unknown[]) => {
				if (eventName === "data" && requestId && Buffer.isBuffer(args[0])) {
					const bytes = args[0];
					const first = bytes.indexOf(ENGINE_FRAME_SENTINEL_BYTE);
					const second = bytes.indexOf(ENGINE_FRAME_SENTINEL_BYTE, first + 1);
					if (first !== -1 && second !== -1) {
						const frame = JSON.parse(bytes.subarray(first + 1, second).toString("utf8")) as Record<
							string,
							unknown
						>;
						args[0] = frameBytes({ ...frame, requestId } as unknown as WindowsShellEngineFrame);
						emittedFrame = true;
					}
				}
				return emitControl(eventName, ...args);
			},
		});
		const dispatch = (line: string) => {
			const request = JSON.parse(line) as { requestId?: string };
			requestId = request.requestId;
			emittedFrame = false;
			scenario({ child, stdout, stderr, request });
			if (requestId && emittedFrame) stdout.emit("data", outputBarrierBytes(requestId));
			requestId = undefined;
		};
		Object.assign(child, {
			pid: undefined,
			exitCode: null,
			signalCode: null,
			stdout,
			stderr,
			unref: () => {},
			ref: () => {},
			stdin: {
				end: (data: string) => {
					stdinData += data;
					queueMicrotask(() => dispatch(stdinData));
				},
				write: (
					data: string,
					encodingOrCallback?: string | ((error?: Error | null) => void),
					callback?: (error?: Error | null) => void,
				) => {
					stdinData += data;
					let newlineIndex = stdinData.indexOf("\n");
					while (newlineIndex !== -1) {
						const line = stdinData.slice(0, newlineIndex);
						stdinData = stdinData.slice(newlineIndex + 1);
						if (line) queueMicrotask(() => dispatch(line));
						newlineIndex = stdinData.indexOf("\n");
					}
					const onWritten = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
					onWritten?.(null);
					return true;
				},
			},
		});
		return child;
	};
}

interface FakeCoordinatorHandles extends FakeChildHandles {
	request: { command: string; cwd: string; env: NodeJS.ProcessEnv; requestId?: string };
	persistent: boolean;
}

function outputBarrierBytes(requestId: string): Buffer {
	return Buffer.from(`${FRAME_SENTINEL}${requestId}${FRAME_SENTINEL}`, "utf8");
}

/** Accept both the current EOF protocol and the intended newline-framed coordinator protocol so
 * persistence assertions fail on behavior (spawn count/state ordering), not fake transport setup. */
function fakeCoordinatorSpawn(scenario: (handles: FakeCoordinatorHandles) => void) {
	let spawnCount = 0;
	return {
		get spawnCount() {
			return spawnCount;
		},
		spawn: () => {
			spawnCount += 1;
			const stdout = fakeStream();
			const stderr = fakeStream();
			const child = new EventEmitter() as unknown as ChildProcess;
			let stdinData = "";
			const dispatch = (raw: string, persistent: boolean) => {
				const request = JSON.parse(raw) as FakeCoordinatorHandles["request"];
				queueMicrotask(() => scenario({ child, stdout, stderr, request, persistent }));
			};
			Object.assign(child, {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				stdout,
				stderr,
				unref: () => {},
				ref: () => {},
				stdin: {
					end: (data: string) => {
						stdinData += data;
						dispatch(stdinData, false);
					},
					write: (
						data: string,
						encodingOrCallback?: string | ((error?: Error | null) => void),
						callback?: (error?: Error | null) => void,
					) => {
						stdinData += data;
						let newlineIndex = stdinData.indexOf("\n");
						while (newlineIndex !== -1) {
							const line = stdinData.slice(0, newlineIndex);
							stdinData = stdinData.slice(newlineIndex + 1);
							if (line) dispatch(line, true);
							newlineIndex = stdinData.indexOf("\n");
						}
						const onWritten = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
						onWritten?.(null);
						return true;
					},
				},
			});
			return child;
		},
	};
}

function emitCoordinatorTerminal(
	{ stdout, stderr, request }: FakeCoordinatorHandles,
	frame: WindowsShellEngineFrame,
	requestId = request.requestId,
): void {
	if (!requestId) throw new Error("persistent request did not carry a requestId");
	stdout.emit("data", outputBarrierBytes(requestId));
	stderr.emit("data", frameBytes({ ...frame, requestId } as unknown as WindowsShellEngineFrame));
}

async function collectOutput(exec: (onData: (data: Buffer) => void) => Promise<{ exitCode: number | null }>) {
	const chunks: Buffer[] = [];
	const result = await exec((chunk) => chunks.push(chunk));
	return { result, output: Buffer.concat(chunks).toString("utf8") };
}

describe("windows shell engine operations", () => {
	it("reuses one Python coordinator for sequential commands in the same session", async () => {
		const coordinator = fakeCoordinatorSpawn(({ child, stdout, stderr, request, persistent }) => {
			stdout.emit("data", Buffer.from(`${request.command}\n`));
			if (request.requestId) stdout.emit("data", outputBarrierBytes(request.requestId));
			stderr.emit(
				"data",
				frameBytes({
					exitCode: 0,
					cwd: request.cwd,
					envDelta: {},
					unsupported: null,
					...(request.requestId ? { requestId: request.requestId } : {}),
				}),
			);
			if (!persistent) child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-persistent-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		const first = await collectOutput((onData) => ops.exec("first", "/old/dir", { onData }));
		const second = await collectOutput((onData) => ops.exec("second", "/old/dir", { onData }));

		expect(first.output).toBe("first\n");
		expect(second.output).toBe("second\n");
		expect(coordinator.spawnCount).toBe(1);
	});

	it("serializes concurrent requests before deriving the next request state", async () => {
		const requests: FakeCoordinatorHandles["request"][] = [];
		const coordinator = fakeCoordinatorSpawn(({ child, stdout, stderr, request, persistent }) => {
			requests.push(request);
			const envDelta: Record<string, string | null> = request.command === "export FOO=bar" ? { FOO: "bar" } : {};
			if (request.requestId) stdout.emit("data", outputBarrierBytes(request.requestId));
			stderr.emit(
				"data",
				frameBytes({
					exitCode: 0,
					cwd: request.cwd,
					envDelta,
					unsupported: null,
					...(request.requestId ? { requestId: request.requestId } : {}),
				}),
			);
			if (!persistent) child.emit("close", 0);
		});
		const ops = createWindowsShellEngineOperations("engine-serialized-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		await Promise.all([
			ops.exec("export FOO=bar", "/old/dir", { onData: () => {} }),
			ops.exec("echo $FOO", "/old/dir", { onData: () => {} }),
		]);

		expect(coordinator.spawnCount).toBe(1);
		expect(requests).toHaveLength(2);
		expect(requests[1].env.FOO).toBe("bar");
	});

	it("isolates coordinator processes and state across simultaneous tenant session keys", async () => {
		const requests: FakeCoordinatorHandles["request"][] = [];
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requests.push(handles.request);
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: handles.request.command === "export TENANT_A=private" ? { TENANT_A: "private" } : {},
				unsupported: null,
			});
		});
		const options = {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		};
		const tenantAKey = "engine-tenant-a";
		const tenantBKey = "engine-tenant-b";
		const tenantA = createWindowsShellEngineOperations(tenantAKey, options);
		const tenantB = createWindowsShellEngineOperations(tenantBKey, options);

		await tenantA.exec("export TENANT_A=private", "/tenant-a", { onData: () => {} });
		await tenantB.exec("printf b", "/tenant-b", { onData: () => {} });
		await tenantA.exec("printf a", "/tenant-a", { onData: () => {} });

		expect(coordinator.spawnCount).toBe(2);
		expect(requests[1].cwd).toBe("/tenant-b");
		expect(requests[1].env.TENANT_A).toBeUndefined();
		expect(requests[2].cwd).toBe("/tenant-a");
		expect(requests[2].env.TENANT_A).toBe("private");
		disposeWindowsShellEngineSession(tenantAKey);
		await tenantB.exec("printf still-b", "/tenant-b", { onData: () => {} });
		expect(coordinator.spawnCount).toBe(2);
		expect(requests[3].env.TENANT_A).toBeUndefined();
		disposeWindowsShellEngineSession(tenantBKey);
	});

	it("assigns separate tenant coordinators to keyless platform-operation factories", async () => {
		const requests: FakeCoordinatorHandles["request"][] = [];
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requests.push(handles.request);
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: handles.request.command === "export TENANT_A=private" ? { TENANT_A: "private" } : {},
				unsupported: null,
			});
		});
		const createTenant = () =>
			createLocalPlatformShellOperations(
				{
					pythonEngine: true,
					operations: {
						exec: async () => {
							throw new Error("engine-owned command reached the PowerShell floor");
						},
					},
					engineOptions: {
						resolveRuntime: async () => READY_RUNTIME,
						engineScriptPath: "/fake/main.py",
						spawn: coordinator.spawn,
					},
				},
				"win32",
			);
		const tenantA = createTenant();
		const tenantB = createTenant();

		await tenantA.exec("export TENANT_A=private", "/tenant-a", { onData: () => {} });
		await tenantB.exec("printf b | head -1", "/tenant-b", { onData: () => {} });
		await tenantA.exec("printf a | head -1", "/tenant-a", { onData: () => {} });

		expect(coordinator.spawnCount).toBe(2);
		expect(requests[1].env.TENANT_A).toBeUndefined();
		expect(requests[2].env.TENANT_A).toBe("private");
	});

	it("rejects a stale control frame, resets the coordinator, and recovers on the next request", async () => {
		let requestCount = 0;
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				emitCoordinatorTerminal(
					handles,
					{ exitCode: 0, cwd: handles.request.cwd, envDelta: {}, unsupported: null },
					"0000000000000000",
				);
				return;
			}
			handles.stdout.emit("data", Buffer.from("recovered\n"));
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-stale-frame-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		await expect(ops.exec("first", "/old/dir", { onData: () => {} })).rejects.toThrow(/stale control frame/);
		const { output } = await collectOutput((onData) => ops.exec("second", "/old/dir", { onData }));

		expect(output).toBe("recovered\n");
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("fails a complete malformed control frame immediately and recovers without waiting for timeout", async () => {
		let requestCount = 0;
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				const requestId = handles.request.requestId;
				if (!requestId) throw new Error("missing request id");
				handles.stdout.emit("data", outputBarrierBytes(requestId));
				handles.stderr.emit("data", Buffer.from(`${FRAME_SENTINEL}not-json${FRAME_SENTINEL}`));
				return;
			}
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-malformed-frame-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		await expect(ops.exec("first", "/old/dir", { onData: () => {} })).rejects.toThrow(/malformed control frame/);
		await expect(ops.exec("second", "/old/dir", { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("rejects post-barrier output before admitting the next queued request", async () => {
		let requestCount = 0;
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				handles.stdout.emit("data", Buffer.from("before\n"));
				emitCoordinatorTerminal(handles, {
					exitCode: 0,
					cwd: handles.request.cwd,
					envDelta: {},
					unsupported: null,
				});
				handles.stdout.emit("data", Buffer.from("late\n"));
				return;
			}
			handles.stdout.emit("data", Buffer.from("fresh\n"));
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-post-barrier-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});
		const firstChunks: Buffer[] = [];

		await expect(ops.exec("first", "/old/dir", { onData: (data) => firstChunks.push(data) })).rejects.toThrow(
			/after its terminal barrier/,
		);
		const { output } = await collectOutput((onData) => ops.exec("second", "/old/dir", { onData }));

		expect(Buffer.concat(firstChunks).toString("utf8")).toBe("before\n");
		expect(output).toBe("fresh\n");
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("ignores late bytes from a crashed coordinator after the replacement starts", async () => {
		let firstHandles: FakeCoordinatorHandles | undefined;
		let requestCount = 0;
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				firstHandles = handles;
				handles.stderr.emit("data", Buffer.from("coordinator crash\n"));
				handles.child.emit("close", 1);
				return;
			}
			firstHandles?.stdout.emit("data", Buffer.from("stale\n"));
			firstHandles?.stderr.emit(
				"data",
				frameBytes({
					exitCode: 0,
					cwd: "/stale",
					envDelta: { STALE: "1" },
					unsupported: null,
				}),
			);
			handles.stdout.emit("data", Buffer.from("fresh\n"));
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-crash-recovery-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		await expect(ops.exec("first", "/old/dir", { onData: () => {} })).rejects.toBeInstanceOf(
			WindowsShellEngineFailure,
		);
		const { output } = await collectOutput((onData) => ops.exec("second", "/old/dir", { onData }));

		expect(output).toBe("fresh\n");
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("aborts the whole coordinator and lazily respawns for the next request", async () => {
		let requestCount = 0;
		let markFirstRequest: () => void = () => {};
		const firstRequest = new Promise<void>((resolve) => {
			markFirstRequest = resolve;
		});
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				markFirstRequest();
				return;
			}
			handles.stdout.emit("data", Buffer.from("after-abort\n"));
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-abort-recovery-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});
		const abortController = new AbortController();
		const aborted = ops.exec("hang", "/old/dir", { onData: () => {}, signal: abortController.signal });
		await firstRequest;
		abortController.abort();

		await expect(aborted).rejects.toThrow("aborted");
		const { output } = await collectOutput((onData) => ops.exec("second", "/old/dir", { onData }));

		expect(output).toBe("after-abort\n");
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("does not apply a control frame until its output barrier arrives", async () => {
		let requestCount = 0;
		let secondRequest: FakeCoordinatorHandles["request"] | undefined;
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				const requestId = handles.request.requestId;
				if (!requestId) throw new Error("missing request id");
				handles.stderr.emit(
					"data",
					frameBytes({
						requestId,
						exitCode: 0,
						cwd: "/unacknowledged",
						envDelta: { STALE: "1" },
						unsupported: null,
					} as unknown as WindowsShellEngineFrame),
				);
				return;
			}
			secondRequest = handles.request;
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-output-barrier-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});

		await expect(ops.exec("first", "/old/dir", { onData: () => {}, timeout: 0.02 })).rejects.toThrow("timeout:0.02");
		await ops.exec("second", "/old/dir", { onData: () => {} });

		expect(secondRequest?.cwd).toBe("/old/dir");
		expect(secondRequest?.env.STALE).toBeUndefined();
		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("disposal rejects an active request and lets the same tool reacquire its tenant coordinator", async () => {
		let requestCount = 0;
		let markFirstRequest: () => void = () => {};
		const firstRequest = new Promise<void>((resolve) => {
			markFirstRequest = resolve;
		});
		const coordinator = fakeCoordinatorSpawn((handles) => {
			requestCount += 1;
			if (requestCount === 1) {
				markFirstRequest();
				return;
			}
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		const sessionKey = "engine-dispose-session";
		const firstOps = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: coordinator.spawn,
		});
		const active = firstOps.exec("hang", "/old/dir", { onData: () => {} });
		await firstRequest;
		disposeWindowsShellEngineSession(sessionKey);

		await expect(active).rejects.toThrow(/is disposed/);
		await firstOps.exec("fresh", "/old/dir", { onData: () => {} });

		expect(coordinator.spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("resets after a synchronous coordinator write failure", async () => {
		const healthy = fakeCoordinatorSpawn((handles) => {
			emitCoordinatorTerminal(handles, {
				exitCode: 0,
				cwd: handles.request.cwd,
				envDelta: {},
				unsupported: null,
			});
		});
		let spawnCount = 0;
		const spawn = () => {
			spawnCount += 1;
			if (spawnCount > 1) return healthy.spawn();
			const child = new EventEmitter() as unknown as ChildProcess;
			Object.assign(child, {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				stdout: fakeStream(),
				stderr: fakeStream(),
				ref: () => {},
				unref: () => {},
				stdin: {
					write: () => {
						throw new Error("broken pipe");
					},
				},
			});
			return child;
		};
		const sessionKey = "engine-write-failure-session";
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		await expect(ops.exec("first", "/old/dir", { onData: () => {} })).rejects.toThrow(
			/Failed to write.*broken pipe/s,
		);
		await expect(ops.exec("second", "/old/dir", { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		expect(spawnCount).toBe(2);
		disposeWindowsShellEngineSession(sessionKey);
	});

	it("strips the control frame, streams merged output, and applies state on success", async () => {
		const spawn = fakeSpawn(({ stdout, stderr }) => {
			stdout.emit("data", Buffer.from("hello\n"));
			stderr.emit(
				"data",
				frameBytes({ exitCode: 0, cwd: "/new/dir", envDelta: { FOO: "bar", REMOVED: null }, unsupported: null }),
			);
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
		const spawn = fakeSpawn(({ stdout, stderr }) => {
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
		const spawn = fakeSpawn(({ stdout, stderr }) => {
			stdout.emit("data", binaryWithSentinel);
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
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
		const spawn = fakeSpawn(({ stdout, stderr }) => {
			const chunkSize = 4096;
			for (let offset = 0; offset < largeOutput.length; offset += chunkSize) {
				stdout.emit("data", largeOutput.subarray(offset, offset + chunkSize));
			}
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
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

	it("sets the request's soft timeout 100ms before the hard reset, and omits it when unset", async () => {
		let capturedRequestWithTimeout: { timeoutMs?: number } | undefined;
		const spawnWithTimeout = fakeSpawn(({ stderr, request }) => {
			capturedRequestWithTimeout = request as { timeoutMs?: number };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
		});
		const opsWithTimeout = createWindowsShellEngineOperations("engine-timeout-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: spawnWithTimeout,
		});
		await collectOutput((onData) => opsWithTimeout.exec("echo hi", "/old/dir", { onData, timeout: 30 }));
		expect(capturedRequestWithTimeout?.timeoutMs).toBe(30 * 1000 - 100);

		let capturedRequestNoTimeout: { timeoutMs?: number } | undefined;
		const spawnNoTimeout = fakeSpawn(({ stderr, request }) => {
			capturedRequestNoTimeout = request as { timeoutMs?: number };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
		});
		const opsNoTimeout = createWindowsShellEngineOperations("engine-no-timeout-session", {
			resolveRuntime: async () => READY_RUNTIME,
			engineScriptPath: "/fake/main.py",
			spawn: spawnNoTimeout,
		});
		await collectOutput((onData) => opsNoTimeout.exec("echo hi", "/old/dir", { onData }));
		expect(capturedRequestNoTimeout?.timeoutMs).toBeUndefined();
	});

	it("passes the selected PowerShell host to the portable engine for .ps1 adaptation", async () => {
		let capturedRequest: { powershellPath?: string } | undefined;
		const spawn = fakeSpawn(({ stderr, request }) => {
			capturedRequest = request as { powershellPath?: string };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
		});
		const ops = createWindowsShellEngineOperations("engine-powershell-adapter-session", {
			resolveRuntime: async () => READY_RUNTIME,
			resolvePowerShellPath: () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		await collectOutput((onData) => ops.exec("probe.ps1 > result.txt", "/old/dir", { onData }));

		expect(capturedRequest?.powershellPath).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
	});

	it("does not resolve or start PowerShell for a combined native rg command", async () => {
		let capturedRequest: { powershellPath?: string } | undefined;
		let powerShellResolutions = 0;
		const spawn = fakeSpawn(({ stderr, request }) => {
			capturedRequest = request as { powershellPath?: string };
			stderr.emit("data", frameBytes({ exitCode: 0, cwd: "/old/dir", envDelta: {}, unsupported: null }));
		});
		const ops = createWindowsShellEngineOperations("engine-native-rg-session", {
			resolveRuntime: async () => READY_RUNTIME,
			resolvePowerShellPath: () => {
				powerShellResolutions += 1;
				return "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
			},
			engineScriptPath: "/fake/main.py",
			spawn,
		});

		await collectOutput((onData) => ops.exec("rg needle file.txt | head -1", "/old/dir", { onData }));

		expect(powerShellResolutions).toBe(0);
		expect(capturedRequest?.powershellPath).toBeUndefined();
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
		const spawn = fakeSpawn(({ stderr, request }) => {
			const parsed = request as { command: string };
			const frame: WindowsShellEngineFrame =
				parsed.command === "cd /new/dir"
					? { exitCode: 0, cwd: "/new/dir", envDelta: {}, unsupported: null }
					: { exitCode: 0, cwd: "/new/dir", envDelta: { FOO: "bar" }, unsupported: null };
			stderr.emit("data", frameBytes(frame));
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
