import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

const cleanupDirectories: string[] = [];

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function noisyTestOutput(failed: boolean): string {
	const passing = Array.from({ length: 100 }, (_, index) => `[PASS] unrelated case ${index}`).join("\n");
	const failure = failed
		? "\n[FAIL] focused case\nAssertionError: expected true but received false\n  at focused.test.ts:42"
		: "";
	return `${passing}${failure}\nTests Passed: 100, Failed: ${failed ? 1 : 0}, Skipped: 0\n`;
}

function operationsFor(rawOutput: string, exitCode: number): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(rawOutput, "utf-8"));
			return { exitCode };
		},
	};
}

describe("bash test-output projection", () => {
	it("returns a compact result and an immediately readable exact-output path", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-projection-"));
		cleanupDirectories.push(outputDirectory);
		const rawOutput = noisyTestOutput(false);
		const tool = createBashTool(process.cwd(), {
			operations: operationsFor(rawOutput, 0),
			outputDirectory,
		});

		const result = await tool.execute("test-projection-success", { command: "run-tests.cmd" });
		const text = getTextOutput(result, false);

		expect(text).toContain("Tests Passed: 100, Failed: 0, Skipped: 0");
		expect(text).toContain("[Test output filtered:");
		expect(text).not.toContain("unrelated case 42");
		expect(result.details?.outputProjection?.collapsedPassingLines).toBe(100);
		expect(result.details?.fullOutputPath).toBeDefined();
		expect(readFileSync(result.details?.fullOutputPath ?? "", "utf-8")).toBe(rawOutput);
	});

	it("preserves a verification failure's diagnostics, original exit code, and metadata", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-projection-"));
		cleanupDirectories.push(outputDirectory);
		const rawOutput = noisyTestOutput(true);
		const tool = createBashTool(process.cwd(), {
			operations: operationsFor(rawOutput, 9),
			outputDirectory,
		});

		const result = await tool.execute("test-projection-failure", { command: String.raw`.\BuildVersion.Tests.ps1` });
		const message = getTextOutput(result, false);

		expect(result).toMatchObject({ isError: true, errorKind: "operation_outcome" });
		expect(result.details?.piVerification).toMatchObject({ version: 1, status: "failed", id: expect.any(String) });
		expect(message).toContain("[FAIL] focused case");
		expect(message).toContain("AssertionError: expected true but received false");
		expect(message).not.toContain("unrelated case 42");
		expect(message).toContain("Command exited with code 9");
		const fullOutputPath = message.match(/Full output: ([^\]\n]+)/u)?.[1];
		expect(fullOutputPath).toBeDefined();
		expect(readFileSync(fullOutputPath ?? "", "utf-8")).toBe(rawOutput);
	});

	it("falls back to raw output if exact-output persistence fails", async () => {
		const parentDirectory = mkdtempSync(join(tmpdir(), "pi-bash-projection-"));
		cleanupDirectories.push(parentDirectory);
		const rawOutput = noisyTestOutput(false);
		const tool = createBashTool(process.cwd(), {
			operations: operationsFor(rawOutput, 0),
			outputDirectory: join(parentDirectory, "missing", "outputs"),
		});

		const result = await tool.execute("test-projection-persistence-fallback", { command: "npm test" });

		expect(getTextOutput(result, false)).toContain("unrelated case 42");
		expect(result.details?.outputProjection).toBeUndefined();
		expect(result.details?.fullOutputError).toBeDefined();
	});
});
