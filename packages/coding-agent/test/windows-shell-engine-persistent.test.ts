import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposeShellExecutionSession } from "../src/core/tools/shell-execution-session.ts";
import { createWindowsShellEngineOperations } from "../src/core/tools/windows-shell-engine.ts";

const ENGINE_MAIN = join(__dirname, "..", "src", "bundled-resources", "runtimes", "pi-shell-engine", "main.py");

function resolvePython(): string | null {
	for (const candidate of [process.env.PI_TEST_PYTHON, "python3", "python"]) {
		if (!candidate) continue;
		if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
	}
	return null;
}

async function execute(
	ops: ReturnType<typeof createWindowsShellEngineOperations>,
	command: string,
): Promise<{ output: string; exitCode: number | null }> {
	const chunks: Buffer[] = [];
	const result = await ops.exec(command, tmpdir(), { onData: (data) => chunks.push(data), timeout: 10 });
	return { output: Buffer.concat(chunks).toString("utf8"), exitCode: result.exitCode };
}

describe("persistent Windows shell engine coordinator", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("requires a Python interpreter", () => {});
		return;
	}

	it("keeps one interpreter warm, preserves acknowledged state, and never exposes protocol stdin to commands", async () => {
		const sessionKey = "real-persistent-engine-session";
		let spawnCount = 0;
		let runtimeResolutionCount = 0;
		const ops = createWindowsShellEngineOperations(sessionKey, {
			resolveRuntime: async () => {
				runtimeResolutionCount += 1;
				return {
					status: "ready",
					uvPath: "/unused/uv",
					pythonPath: python,
					pythonInstalled: false,
				};
			},
			engineScriptPath: ENGINE_MAIN,
			spawn: (command: string, args: string[], options: SpawnOptions): ChildProcess => {
				spawnCount += 1;
				return spawn(command, args, options);
			},
		});

		try {
			expect(await execute(ops, "printf 'first\\n'")).toEqual({ output: "first\n", exitCode: 0 });
			expect(await execute(ops, "export FOO=warm")).toEqual({ output: "", exitCode: 0 });
			expect(await execute(ops, "printf '%s\\n' \"$FOO\"")).toEqual({ output: "warm\n", exitCode: 0 });
			expect(await execute(ops, "cat; printf 'stdin-eof\\n'")).toEqual({ output: "stdin-eof\n", exitCode: 0 });
			expect(await execute(ops, "exit 7")).toEqual({ output: "", exitCode: 7 });
			for (let index = 0; index < 20; index += 1) {
				expect(await execute(ops, "printf 'a\\nb\\n' | grep b")).toEqual({ output: "b\n", exitCode: 0 });
			}
			expect(spawnCount).toBe(1);
			expect(runtimeResolutionCount).toBe(1);
		} finally {
			disposeShellExecutionSession(sessionKey);
		}
	});
});
