import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createPythonRuntimeManager,
	type PythonRuntimeCommandResult,
	type PythonRuntimeDependencies,
} from "../src/core/python-runtime.ts";

function commandResult(
	code: number,
	stdout = "",
	stderr = "",
	overrides: Partial<PythonRuntimeCommandResult> = {},
): PythonRuntimeCommandResult {
	return { code, stdout, stderr, killed: false, stdoutTruncated: false, ...overrides };
}

function createDeps(
	run: PythonRuntimeDependencies["run"],
	overrides: Partial<PythonRuntimeDependencies> = {},
): PythonRuntimeDependencies {
	return {
		agentDir: "/agent",
		ensureUv: async () => "/agent/bin/uv",
		isOffline: () => false,
		makeDirectory: () => {},
		inspectInterpreter: (path) =>
			path === "/agent/runtimes/python/cpython-3.13/bin/python" ? "fixture-identity" : undefined,
		run,
		now: () => 1_000,
		...overrides,
	};
}

describe("uv-managed Python runtime", () => {
	it.each([
		"/fixture/space at end ",
		"/fixture/Unicode\u00a0",
		"/fixture/embedded\nnewline/python",
		"/fixture/python\r",
		"/fixture/python\n",
		"Q:\\fixture\\python.exe",
		"\\\\fixture-host\\share\\python.exe",
	])("preserves the complete interpreter path %j", async (pythonPath) => {
		const manager = createPythonRuntimeManager(
			createDeps(async () => commandResult(0, `${pythonPath}\n`), {
				inspectInterpreter: (path) => (path === pythonPath ? "fixture-identity" : undefined),
			}),
		);
		await expect(manager.ensure()).resolves.toMatchObject({ status: "ready", pythonPath });
	});

	it("rediscovers a removed cached interpreter without requiring force", async () => {
		let current = "/fixture/first/python";
		let calls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(
				async () => {
					calls++;
					return commandResult(0, `${current}\n`);
				},
				{ inspectInterpreter: (path) => (path === current ? current : undefined) },
			),
		);
		await expect(manager.ensure()).resolves.toMatchObject({ pythonPath: current });
		current = "/fixture/relocated/python";
		await expect(manager.ensure()).resolves.toMatchObject({ pythonPath: current });
		expect(calls).toBe(2);
	});

	it("rediscovers a changed executable at the same path", async () => {
		let identity = "original";
		let calls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(
				async () => {
					calls++;
					return commandResult(0, "/fixture/python\n");
				},
				{ inspectInterpreter: () => identity },
			),
		);
		await manager.ensure();
		identity = "replacement";
		await manager.ensure();
		await manager.ensure();
		expect(calls).toBe(2);
	});

	it.each([
		commandResult(0, ""),
		commandResult(0, "\n"),
		commandResult(0, "/fixture/python"),
		commandResult(0, "/fixture/python\0\n"),
		commandResult(0, "/fixture/python\n", "", { stdoutTruncated: true }),
	])("does not inspect or install from an incomplete path result: %j", async (result) => {
		let inspections = 0;
		let calls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(
				async () => {
					calls++;
					return result;
				},
				{
					inspectInterpreter: () => {
						inspections++;
						return "identity";
					},
				},
			),
		);
		await expect(manager.ensure()).resolves.toMatchObject({
			status: "python-unavailable",
			reason: expect.stringContaining("complete"),
		});
		expect(inspections).toBe(0);
		expect(calls).toBe(1);
	});

	it("does not select the first existing path from extra stdout lines", async () => {
		const inspected: string[] = [];
		const manager = createPythonRuntimeManager(
			createDeps(async () => commandResult(0, "/fixture/python\nextra output\n"), {
				inspectInterpreter: (path) => {
					inspected.push(path);
					return path === "/fixture/python" ? "identity" : undefined;
				},
			}),
		);
		await expect(manager.ensure()).resolves.toMatchObject({ status: "python-unavailable" });
		expect(inspected).toEqual(["/fixture/python\nextra output"]);
	});

	it("does not retain ready status when the executable vanishes offline", async () => {
		let present = true;
		const calls: string[] = [];
		const manager = createPythonRuntimeManager(
			createDeps(
				async (_command, args) => {
					calls.push(args[1]);
					return present ? commandResult(0, "/fixture/python\n") : commandResult(1);
				},
				{ isOffline: () => true, inspectInterpreter: () => (present ? "identity" : undefined) },
			),
		);
		await expect(manager.ensure()).resolves.toMatchObject({ status: "ready" });
		present = false;
		await expect(manager.ensure()).resolves.toMatchObject({ status: "offline" });
		expect(calls).toEqual(["find", "find"]);
	});

	it("joins a forced refresh instead of returning the previous cached outcome", async () => {
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(async () => {
				if (++calls === 2) await gate.promise;
				return commandResult(0, "/agent/runtimes/python/cpython-3.13/bin/python\n");
			}),
		);
		await manager.ensure();
		const refresh = manager.ensure({ force: true });
		const joined = manager.ensure();
		const sameOperation = refresh === joined;
		gate.resolve();
		await Promise.all([refresh, joined]);
		expect(sameOperation).toBe(true);
		expect(calls).toBe(2);
	});

	it("does not let a consumer mutate the cached interpreter identity", async () => {
		const manager = createPythonRuntimeManager(
			createDeps(async () => commandResult(0, "/agent/runtimes/python/cpython-3.13/bin/python\n")),
		);
		const outcome = await manager.ensure();
		Reflect.set(outcome, "pythonPath", "/fixture/unverified/python");
		await expect(manager.ensure()).resolves.toMatchObject({
			pythonPath: "/agent/runtimes/python/cpython-3.13/bin/python",
		});
	});
	it("finds and caches an existing interpreter without installing", async () => {
		const calls: string[][] = [];
		let ensureCalls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(
				async (_command, args) => {
					calls.push(args);
					return commandResult(0, "/agent/runtimes/python/cpython-3.13/bin/python\n");
				},
				{
					ensureUv: async () => {
						ensureCalls += 1;
						return "/agent/bin/uv";
					},
				},
			),
		);

		const first = await manager.ensure();
		const second = await manager.ensure();

		expect(first).toEqual({
			status: "ready",
			uvPath: "/agent/bin/uv",
			pythonPath: "/agent/runtimes/python/cpython-3.13/bin/python",
			pythonInstalled: false,
		});
		expect(second).toEqual(first);
		expect(ensureCalls).toBe(1);
		expect(calls).toEqual([["python", "find", ">=3.10", "--no-project"]]);
	});

	it("shares one in-flight provisioning operation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const manager = createPythonRuntimeManager(
			createDeps(async () => {
				calls += 1;
				await gate;
				return commandResult(0, "/agent/runtimes/python/cpython-3.13/bin/python\n");
			}),
		);

		const first = manager.ensure();
		const second = manager.ensure();
		release();

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(calls).toBe(1);
	});

	it("installs Python through uv only when find cannot resolve one", async () => {
		const calls: Array<{ args: string[]; timeout: number | undefined; env: NodeJS.ProcessEnv | undefined }> = [];
		const results = [
			commandResult(1, "", "not found"),
			commandResult(0, "installed\n"),
			commandResult(0, "/agent/runtimes/python/cpython-3.13/bin/python\n"),
		];
		const manager = createPythonRuntimeManager(
			createDeps(async (_command, args, _cwd, options) => {
				calls.push({ args, timeout: options.timeoutMs, env: options.env });
				const next = results.shift();
				if (!next) throw new Error("Unexpected command");
				return next;
			}),
		);

		await expect(manager.ensure()).resolves.toMatchObject({ status: "ready", pythonInstalled: true });
		expect(calls.map((call) => call.args)).toEqual([
			["python", "find", ">=3.10", "--no-project"],
			["python", "install", "3.13"],
			["python", "find", ">=3.10", "--no-project"],
		]);
		expect(calls[1]?.timeout).toBe(300_000);
		expect(calls[0]?.env).toMatchObject({
			UV_CACHE_DIR: join("/agent", "cache", "uv"),
			UV_PYTHON_INSTALL_DIR: join("/agent", "runtimes", "python"),
			UV_NO_PROGRESS: "1",
		});
	});

	it("does not attempt a Python download in offline mode", async () => {
		const calls: string[][] = [];
		const manager = createPythonRuntimeManager(
			createDeps(
				async (_command, args) => {
					calls.push(args);
					return commandResult(1, "", "not found");
				},
				{ isOffline: () => true },
			),
		);

		await expect(manager.ensure()).resolves.toEqual({
			status: "offline",
			reason: "No Python interpreter is available and offline mode prevents uv from installing one.",
		});
		expect(calls).toEqual([["python", "find", ">=3.10", "--no-project"]]);
	});

	it("reports missing uv and bounded install failures", async () => {
		const missingUv = createPythonRuntimeManager(
			createDeps(async () => commandResult(0), { ensureUv: async () => undefined }),
		);
		await expect(missingUv.ensure()).resolves.toEqual({
			status: "uv-unavailable",
			reason: "uv is unavailable; run `pi doctor` or reconnect and retry.",
		});

		const longError = "x".repeat(80_000);
		const failedInstall = createPythonRuntimeManager(
			createDeps(async (_command, args) =>
				args[1] === "find" ? commandResult(1) : commandResult(1, "", longError, { killed: true }),
			),
		);
		const failed = await failedInstall.ensure();
		expect(failed).toMatchObject({ status: "python-unavailable" });
		if (failed.status !== "python-unavailable") throw new Error("Expected python-unavailable");
		expect(failed.reason.length).toBeLessThan(5_000);
		expect(failed.reason).toContain("uv python install");
	});

	it("rejects a successful uv result that does not name an existing interpreter", async () => {
		const manager = createPythonRuntimeManager(
			createDeps(async () => commandResult(0, "/missing/python\n"), { inspectInterpreter: () => undefined }),
		);
		await expect(manager.ensure()).resolves.toEqual({
			status: "python-unavailable",
			reason: "uv reported a Python path that is not an available executable file: /missing/python",
		});
	});
});
