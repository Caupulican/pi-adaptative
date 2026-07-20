import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BashExecutionController } from "../src/core/bash-execution-controller.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { POWERSHELL_UTF8_PREFIX } from "../src/utils/shell.ts";

// Same probe pattern as the engine tests: PI_TEST_PYTHON -> python3 -> python, else no interpreter.
function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function makeController(): BashExecutionController {
	return new BashExecutionController({
		getAgent: () => ({ state: { messages: [] } }) as never,
		getSessionManager: () => ({ getCwd: () => process.cwd(), appendMessage: () => undefined }) as never,
		getSettingsManager: () => ({ getShellCommandPrefix: () => undefined, getShellPath: () => undefined }) as never,
		isStreaming: () => false,
	});
}

describe("BashExecutionController", () => {
	it("applies a bounded default and the same Windows shell contract as the agent tool (engine disabled)", async () => {
		const controller = makeController();
		let executedCommand = "";
		let executedTimeout: number | undefined;
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				executedCommand = command;
				executedTimeout = options.timeout;
				return { stdout: "ok", stderr: "", exitCode: 0, killed: false };
			},
		};

		await controller.executeBash("node --version", undefined, { operations, platform: "win32", pythonEngine: false });
		expect(executedCommand).toContain(POWERSHELL_UTF8_PREFIX);
		expect(executedCommand).toContain("& 'node' '--version'");
		expect(executedTimeout).toBe(120);

		// Off-switch contract stays verbatim: with the engine explicitly disabled, a pipeline is
		// still an unsupported Bash construct on the PowerShell floor.
		await expect(
			controller.executeBash("node --version | more", undefined, {
				operations,
				platform: "win32",
				pythonEngine: false,
			}),
		).rejects.toThrow(/Unsupported Bash construct on Windows/i);
	});

	if (!resolvePython()) {
		// No interpreter available in this environment — the off-switch case above still covers
		// the contract everywhere; only this engine-ON case self-skips.
		it.skip("resolves a pipeline through the Python engine when the engine is enabled (default)", () => {});
	} else {
		it("resolves a pipeline through the Python engine when the engine is enabled (default)", async () => {
			const controller = makeController();
			const operations: BashOperations = {
				exec: async (_command, _cwd, _options) => {
					throw new Error("engine route must not fall through to the raw shell operations");
				},
			};

			const result = await controller.executeBash("node --version | more", undefined, {
				operations,
				platform: "win32",
				pythonEngine: true,
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toMatch(/^v?\d+\.\d+\.\d+/);
		});
	}

	it("aborts all overlapping bash executions", async () => {
		const controller = makeController();
		const aborted: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				await new Promise<void>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							aborted.push(command);
							resolve();
						},
						{ once: true },
					);
				});
				return { stdout: "", stderr: "", exitCode: 130, killed: true };
			},
		};

		const first = controller.executeBash("first", undefined, { operations, platform: "linux" });
		const second = controller.executeBash("second", undefined, { operations, platform: "linux" });
		controller.abortBash();
		await Promise.all([first, second]);

		expect(aborted.sort()).toEqual(["first", "second"]);
		expect(controller.isBashRunning).toBe(false);
	});
});
