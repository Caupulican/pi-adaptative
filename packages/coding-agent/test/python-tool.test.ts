import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPythonToolDefinition,
	type PythonExecutionRequest,
	type PythonOperations,
	resolvePythonToolPath,
} from "../src/core/tools/python.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-python-tool-"));
	tempDirectories.push(directory);
	return directory;
}

function readyRuntime() {
	return Promise.resolve({
		status: "ready" as const,
		uvPath: "/agent/bin/uv",
		pythonPath: "/agent/runtimes/python/bin/python",
		pythonInstalled: false,
	});
}

function operation(
	run: (
		request: PythonExecutionRequest,
	) => Promise<{ exitCode: number | null; reason: "exited" | "aborted" | "timeout"; signal: string | null }>,
): PythonOperations {
	return { exec: run };
}

describe("native python tool", () => {
	it("executes bounded stdin code through the uv-resolved interpreter without a shell", async () => {
		const cwd = await createTempDirectory();
		let captured: PythonExecutionRequest | undefined;
		const tool = createPythonToolDefinition(cwd, {
			resolveRuntime: readyRuntime,
			operations: operation(async (request) => {
				captured = request;
				request.onStdout(Buffer.from("out\n"));
				request.onStderr(Buffer.from("warn\n"));
				return { exitCode: 0, reason: "exited", signal: null };
			}),
			outputDirectory: cwd,
		});

		const result = await tool.execute(
			"python-1",
			{ code: "print('out')", args: ["one", "two"] },
			undefined,
			undefined,
			undefined as never,
		);

		expect(captured).toMatchObject({
			python: "/agent/runtimes/python/bin/python",
			args: ["-B", "-", "one", "two"],
			cwd,
			stdin: "print('out')",
			timeoutMs: 30_000,
		});
		expect(captured?.env).toMatchObject({
			PI_PYTHON_TOOL: "1",
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONUNBUFFERED: "1",
			PYTHONUTF8: "1",
		});
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected Python text output");
		expect(content.text).toBe("out\n\n[stderr]\nwarn\n\n[python exitCode=0]");
		expect(result.details).toMatchObject({ mode: "code", exitCode: 0, timedOut: false, uvPath: "/agent/bin/uv" });
	});

	it("validates xor input, cwd, and script paths before spawning", async () => {
		const cwd = await createTempDirectory();
		const script = join(cwd, "script.py");
		await writeFile(script, "print('ok')\n", "utf8");
		const requests: PythonExecutionRequest[] = [];
		const tool = createPythonToolDefinition(cwd, {
			resolveRuntime: readyRuntime,
			operations: operation(async (request) => {
				requests.push(request);
				return { exitCode: 0, reason: "exited", signal: null };
			}),
			outputDirectory: cwd,
		});

		await expect(tool.execute("none", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/Provide exactly one of code or scriptPath/,
		);
		await expect(
			tool.execute("both", { code: "pass", scriptPath: "script.py" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/Provide exactly one/);
		await expect(
			tool.execute("cwd", { code: "pass", cwd: "missing" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/cwd does not exist/);
		await expect(
			tool.execute("script", { scriptPath: "missing.py" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/scriptPath does not exist/);

		await tool.execute("ok", { scriptPath: "@script.py", args: ["x"] }, undefined, undefined, undefined as never);
		expect(requests[0]).toMatchObject({ args: ["-B", script, "x"], stdin: undefined });
	});

	it("uses bounded default and maximum wall-clock timeouts", async () => {
		const cwd = await createTempDirectory();
		const timeouts: number[] = [];
		const tool = createPythonToolDefinition(cwd, {
			resolveRuntime: readyRuntime,
			operations: operation(async (request) => {
				timeouts.push(request.timeoutMs);
				return { exitCode: 0, reason: "exited", signal: null };
			}),
			outputDirectory: cwd,
		});

		await tool.execute("default", { code: "pass", timeoutSeconds: 0 }, undefined, undefined, undefined as never);
		await tool.execute("maximum", { code: "pass", timeoutSeconds: 999 }, undefined, undefined, undefined as never);
		expect(timeouts).toEqual([30_000, 300_000]);
	});

	it("reports timeout, abort, and non-zero exits as real tool errors", async () => {
		const cwd = await createTempDirectory();
		for (const [reason, exitCode, expected] of [
			["timeout", null, /timed out after 30 seconds/],
			["aborted", null, /aborted/],
			["exited", 7, /exited with code 7/],
		] as const) {
			const tool = createPythonToolDefinition(cwd, {
				resolveRuntime: readyRuntime,
				operations: operation(async (request) => {
					request.onStderr(Buffer.from("failure detail\n"));
					return { exitCode, reason, signal: reason === "exited" ? null : "SIGTERM" };
				}),
				outputDirectory: cwd,
			});
			await expect(tool.execute(reason, { code: "pass" }, undefined, undefined, undefined as never)).rejects.toThrow(
				expected,
			);
		}
	});

	it("keeps output memory bounded and spills complete streams outside the project", async () => {
		const cwd = await createTempDirectory();
		const outputDirectory = await createTempDirectory();
		const tool = createPythonToolDefinition(cwd, {
			resolveRuntime: readyRuntime,
			operations: operation(async (request) => {
				for (let index = 0; index < 64; index += 1) request.onStdout(Buffer.alloc(4096, 0x61));
				return { exitCode: 0, reason: "exited", signal: null };
			}),
			outputDirectory,
		});

		const result = await tool.execute(
			"spill",
			{ code: "pass", maxOutputBytes: 1_000 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details.stdoutTruncation?.truncated).toBe(true);
		expect(result.details.stdoutOutputPath).toContain(outputDirectory);
		expect(result.details.stdoutOutputPath).not.toContain(cwd);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected Python text output");
		expect(Buffer.byteLength(content.text)).toBeLessThan(3_000);
	});

	it("fails with the runtime manager's actionable diagnostic", async () => {
		const cwd = await createTempDirectory();
		const tool = createPythonToolDefinition(cwd, {
			resolveRuntime: async () => ({ status: "uv-unavailable", reason: "uv unavailable in test" }),
			operations: operation(async () => {
				throw new Error("must not spawn");
			}),
		});
		await expect(tool.execute("runtime", { code: "pass" }, undefined, undefined, undefined as never)).rejects.toThrow(
			"uv unavailable in test",
		);
	});

	it("resolves path syntax using the target platform rules", () => {
		expect(resolvePythonToolPath("C:\\repo", "scripts\\edit.py", "win32")).toBe("C:\\repo\\scripts\\edit.py");
		expect(resolvePythonToolPath("/repo", "scripts/edit.py", "linux")).toBe("/repo/scripts/edit.py");
	});
});
