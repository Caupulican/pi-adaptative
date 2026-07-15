import { describe, expect, it } from "vitest";
import { BashExecutionController } from "../src/core/bash-execution-controller.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { POWERSHELL_UTF8_PREFIX } from "../src/utils/shell.ts";

function makeController(): BashExecutionController {
	return new BashExecutionController({
		getAgent: () => ({ state: { messages: [] } }) as never,
		getSessionManager: () => ({ getCwd: () => process.cwd(), appendMessage: () => undefined }) as never,
		getSettingsManager: () => ({ getShellCommandPrefix: () => undefined, getShellPath: () => undefined }) as never,
		isStreaming: () => false,
	});
}

describe("BashExecutionController", () => {
	it("applies a bounded default and the same Windows shell contract as the agent tool", async () => {
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

		await controller.executeBash("node --version", undefined, { operations, platform: "win32" });
		expect(executedCommand).toContain(POWERSHELL_UTF8_PREFIX);
		expect(executedCommand).toContain("& 'node' '--version'");
		expect(executedTimeout).toBe(120);

		await expect(
			controller.executeBash("node --version | more", undefined, { operations, platform: "win32" }),
		).rejects.toThrow(/Unsupported Bash construct on Windows/i);
	});

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

		const first = controller.executeBash("first", undefined, { operations });
		const second = controller.executeBash("second", undefined, { operations });
		controller.abortBash();
		await Promise.all([first, second]);

		expect(aborted.sort()).toEqual(["first", "second"]);
		expect(controller.isBashRunning).toBe(false);
	});
});
