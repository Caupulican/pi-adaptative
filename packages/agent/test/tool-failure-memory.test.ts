import { describe, expect, it } from "vitest";
import {
	assessToolFailure,
	createToolFailureResult,
	sanitizeToolFailureContext,
	type ToolFailureMemoryRecord,
} from "../src/tool-failure-memory.ts";
import type { AgentMessage } from "../src/types.ts";

function record(
	state: ToolFailureMemoryRecord["state"],
	failureCode = state === "failed" ? "exit_1" : "invalid_arguments",
): ToolFailureMemoryRecord {
	return {
		version: 1,
		failureKey: "shell:failure",
		tool: "shell",
		operation: '{"command":"probe"}',
		occurrence: 1,
		state,
		failureCode,
		correction: "Use the contract guidance.",
	};
}

describe("tool failure memory", () => {
	it("retains the cause-bearing diagnostic instead of verbose execution output", () => {
		const assessment = assessToolFailure(
			`${"progress\n".repeat(10_000)}svn: invalid option: --stat\nCommand exited with code 1`,
			"failed",
			"Error",
		);

		expect(assessment).toEqual({
			failureCode: "exit_1",
			diagnostic: "svn: invalid option: --stat",
			guidance: "No safe repair inferred; use the diagnostic and tool contract for the next action.",
		});
	});

	it("states when execution supplied no diagnostic instead of fabricating a repair", () => {
		const assessment = assessToolFailure("Command exited with code 1", "failed", "Error");

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toBe(
			"No safe repair inferred because the tool returned no diagnostic; inspect its contract or request bounded diagnostics before retrying.",
		);
	});

	it("uses bounded stdout evidence when a structured process failure has empty stderr", () => {
		const assessment = assessToolFailure(
			["outcome: failed", "exitCode: 1", "stdout:", "configdelphi: unknown option --auto", "stderr: (empty)"].join(
				"\n",
			),
			"failed",
			"tool_result_error",
		);

		expect(assessment).toEqual({
			failureCode: "exit_1",
			diagnostic: "configdelphi: unknown option --auto",
			guidance: "No safe repair inferred; use the diagnostic and tool contract for the next action.",
		});
	});

	it("does not promote arbitrary legacy output to a diagnostic without an error boundary", () => {
		const assessment = assessToolFailure(`LEGACY_RAW_OUTPUT:${"x".repeat(10_000)}`, "failed");

		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("tool returned no diagnostic");
	});

	it("uses catalogued recovery guidance without retaining redundant raw errors", () => {
		const assessment = assessToolFailure("ENOENT: no such file or directory, open 'missing.txt'", "failed", "Error");

		expect(assessment.failureCode).toBe("enoent");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("list the parent directory or re-read the path");
	});

	it("labels rejected-argument guidance as repair and execution guidance as next_action", () => {
		const failedText = createToolFailureResult(record("failed")).content[0];
		const rejectedText = createToolFailureResult(record("rejected")).content[0];
		if (failedText?.type !== "text" || rejectedText?.type !== "text") throw new Error("expected text records");

		expect(failedText.text).toContain('"next_action":"Use the contract guidance."');
		expect(failedText.text).not.toContain('"repair":');
		expect(rejectedText.text).toContain('"repair":"Use the contract guidance."');
		expect(rejectedText.text).not.toContain('"next_action":');
	});

	it("does not mislabel policy rejection guidance as argument repair", () => {
		const blockedText = createToolFailureResult(record("rejected", "blocked")).content[0];
		if (blockedText?.type !== "text") throw new Error("expected text record");

		expect(blockedText.text).toContain('"next_action":"Use the contract guidance."');
		expect(blockedText.text).not.toContain('"repair":');
	});

	it("retires the legacy generic execution repair when reopening a persisted failure", () => {
		const legacyRecord = record("failed");
		legacyRecord.correction =
			"Change the arguments or approach before retrying; do not resend the unchanged operation.";
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "legacy-call",
						name: "shell",
						arguments: { command: "svn diff --stat" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "legacy-call",
				toolName: "shell",
				content: [
					{
						type: "text",
						text: '[harness] {"failure_code":"exit_1","repair":"Change the arguments or approach before retrying"}',
					},
				],
				isError: true,
				timestamp: 2,
				details: { piToolFailureMemory: legacyRecord },
			},
		];

		const sanitized = sanitizeToolFailureContext(messages, "base");

		expect(sanitized.messages).toEqual([]);
		expect(sanitized.systemPrompt).toContain('"next_action":');
		expect(sanitized.systemPrompt).toContain("tool returned no diagnostic");
		expect(sanitized.systemPrompt).not.toContain("Change the arguments or approach");
		expect(sanitized.systemPrompt).not.toContain('"repair":');
	});
});
