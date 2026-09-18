import { AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import { describeOperationOutcome } from "../../agent/src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../../agent/src/tool-failure-recovery-gate.ts";
import { createPythonTool, type PythonExecutionRequest, type PythonExecutionResult } from "../src/core/tools/python.ts";

function fixture(result: PythonExecutionResult, capture?: (request: PythonExecutionRequest) => void) {
	return createPythonTool("/fixture", {
		pathOptions: { flavor: "posix" },
		resolveRuntime: async () => ({
			status: "ready",
			uvPath: "/fixture/uv",
			pythonPath: "/fixture/python",
			pythonInstalled: false,
		}),
		outputReduction: { enabled: false },
		operations: {
			stat: async () => ({ isDirectory: () => true, isFile: () => true }),
			getEnvironment: async () => ({ variables: {}, caseSensitive: true }),
			readOutputRules: async () => [],
			exec: async (request) => {
				capture?.(request);
				return result;
			},
		},
	});
}

describe("Python timeout recovery authority", () => {
	it.each([
		[undefined, 30_000],
		[0, 30_000],
		[-1, 30_000],
		[Number.NaN, 30_000],
		[Infinity, 30_000],
		[0.1, 1000],
		[1.9, 1000],
		[60, 60_000],
		[600, 300_000],
	])("uses the executor bound for timeoutSeconds=%s", async (timeoutSeconds, milliseconds) => {
		let captured: number | undefined;
		const tool = fixture({ reason: "exited", exitCode: 0, signal: null }, (request) => {
			captured = request.timeoutMs;
		});
		const args = { code: "pass", timeoutSeconds };
		expect(tool.failureRecovery?.getTimeoutMs?.(args)).toBe(milliseconds);
		await tool.execute("projection", args);
		expect(captured).toBe(milliseconds);
	});

	it.each([
		{ reason: "timeout", exitCode: null, failureCode: "timeout", errorKind: "operation_outcome" },
		{ reason: "aborted", exitCode: null, failureCode: "aborted", errorKind: "tool_failure" },
		{ reason: "exited", exitCode: 7, failureCode: "exit_7", errorKind: "operation_outcome" },
	] as const)("retains structured %s outcome identity", async ({ reason, exitCode, failureCode, errorKind }) => {
		const tool = fixture({ reason, exitCode, signal: null });
		await expect(tool.execute("terminal", { code: "pass" })).rejects.toMatchObject({
			failureCode,
			errorKind,
			outputSignature: expect.any(String),
		});
	});

	it.each([
		{ before: undefined, after: 60, expected: "allowed" },
		{ before: 300, after: 600, expected: "blocked" },
		{ before: 0.1, after: 0.2, expected: "blocked" },
	])("only admits material executor growth: %j", async ({ before, after, expected }) => {
		const tool = fixture({ reason: "timeout", exitCode: null, signal: null });
		const args = { code: "pass", timeoutSeconds: before };
		let failure: AgentToolExecutionError | undefined;
		try {
			await tool.execute("timeout", args);
		} catch (error) {
			if (!(error instanceof AgentToolExecutionError)) throw error;
			failure = error;
		}
		if (!failure) throw new Error("Expected a structured Python timeout");
		const gate = new ToolFailureRecoveryGate();
		gate.apply({
			kind: "unproductive",
			tool,
			args,
			record: describeOperationOutcome(tool.name, args, failure.failureCode, failure.message),
		});
		expect(gate.admit(tool, args, undefined)).toEqual({ kind: "allowed" });
		expect(gate.admit(tool, { ...args, timeoutSeconds: after }, undefined)).toMatchObject({ kind: expected });
	});
});
