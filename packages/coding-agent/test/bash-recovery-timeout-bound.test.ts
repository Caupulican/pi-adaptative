import { afterEach, describe, expect, it } from "vitest";
import { describeOperationOutcome } from "../../agent/src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../../agent/src/tool-failure-recovery-gate.ts";
import { createBashTool, setCommandTimeoutMsForTests } from "../src/core/tools/bash.ts";

afterEach(() => setCommandTimeoutMsForTests(undefined));

describe("native shell recovery timeout authority", () => {
	it.each([
		{ timeout: undefined, milliseconds: 120_000 },
		{ timeout: 0, milliseconds: 120_000 },
		{ timeout: -1, milliseconds: 120_000 },
		{ timeout: 0.001, milliseconds: 100 },
		{ timeout: 240, milliseconds: 240_000 },
	])("projects the same effective bound passed to the adapter: %j", async ({ timeout, milliseconds }) => {
		let executionSeconds: number | undefined;
		const tool = createBashTool(process.cwd(), {
			platform: "linux",
			outputReduction: { enabled: false },
			operations: {
				async exec(_command, _cwd, options) {
					executionSeconds = options.timeout;
					return { exitCode: 0 };
				},
			},
		});
		const args = { command: "echo fixture", ...(timeout === undefined ? {} : { timeout }) };
		expect(tool.failureRecovery?.getTimeoutMs?.(args)).toBe(milliseconds);
		await tool.execute("timeout-projection", args);
		expect(executionSeconds).toBe(milliseconds / 1000);
	});

	it("shares the test default override with execution and recovery", () => {
		setCommandTimeoutMsForTests(500);
		const tool = createBashTool(process.cwd(), { outputReduction: { enabled: false } });
		expect(tool.failureRecovery?.getTimeoutMs?.({ command: "fixture" })).toBe(500);
		expect(tool.failureRecovery?.getTimeoutMs?.({ command: "fixture", timeout: 5 })).toBe(5000);
	});

	it("repairs an omitted timeout while ignoring an unrelated wait argument", () => {
		const tool = createBashTool(process.cwd(), { outputReduction: { enabled: false } });
		const gate = new ToolFailureRecoveryGate();
		const args = { command: "fixture", maxWaitMs: 10 };
		gate.apply({
			kind: "unproductive",
			tool,
			args,
			record: describeOperationOutcome("bash", args, "timeout", "Command timed out after 120 seconds"),
		});
		expect(gate.admit(tool, args, undefined)).toEqual({ kind: "allowed" });
		expect(gate.admit(tool, { ...args, maxWaitMs: 20 }, undefined)).toMatchObject({ kind: "blocked" });
		expect(gate.admit(tool, { ...args, timeout: 240 }, undefined)).toEqual({ kind: "allowed" });
	});
});
