import { describe, expect, it } from "vitest";
import { BashExecutionController } from "../src/core/bash-execution-controller.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

function makeController(): BashExecutionController {
	return new BashExecutionController({
		getAgent: () => ({ state: { messages: [] } }) as never,
		getSessionManager: () => ({ getCwd: () => process.cwd(), appendMessage: () => undefined }) as never,
		getSettingsManager: () => ({ getShellCommandPrefix: () => undefined, getShellPath: () => undefined }) as never,
		isStreaming: () => false,
	});
}

describe("BashExecutionController", () => {
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
