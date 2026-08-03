import { describe, expect, it, vi } from "vitest";
import {
	assessToolFailure,
	createToolFailureResult,
	normalizeToolSignature,
	rememberToolFailure,
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
		phase: state === "failed" ? "execution" : "validation",
		failureCode,
		correction: "Use the contract guidance.",
	};
}

describe("tool failure memory", () => {
	it("fingerprints large operations without retaining or serializing their payload", () => {
		const largeTail = "x".repeat(1024 * 1024);
		const firstArgs = {
			path: "large.txt",
			startedAt: 1_723_000_000_000,
			content: `nonce 123e4567-e89b-12d3-a456-426614174000 ${largeTail}`,
		};
		const secondArgs = {
			path: "large.txt",
			startedAt: 1_724_000_000_000,
			content: `nonce 123e4567-e89b-12d3-a456-426614174111 ${largeTail}`,
		};
		const firstPairs: Array<[string, unknown]> = [["write", firstArgs]];
		const secondPairs: Array<[string, unknown]> = [["write", secondArgs]];
		const stringify = vi.spyOn(JSON, "stringify");

		const firstSignature = normalizeToolSignature(firstPairs);
		const secondSignature = normalizeToolSignature(secondPairs);
		expect(firstSignature).toBe(secondSignature);
		expect(firstSignature).toMatch(/^[0-9a-f]{32}$/);
		expect(stringify.mock.calls.some(([value]) => value === firstPairs || value === secondPairs)).toBe(false);

		const tracker = new Map();
		const failure = rememberToolFailure(
			tracker,
			"write",
			firstArgs,
			"failed",
			"tool_error",
			"Choose another destination.",
		);
		expect(failure.operation.length).toBeLessThanOrEqual(240);
		expect(failure.operation).not.toContain(largeTail.slice(0, 1_000));
		expect(stringify.mock.calls.some(([value]) => value === firstArgs)).toBe(false);
	});

	it("retains the cause-bearing diagnostic instead of verbose execution output", () => {
		const assessment = assessToolFailure(
			`${"progress\n".repeat(10_000)}svn: invalid option: --stat\nCommand exited with code 1`,
			"failed",
			"Error",
		);

		expect(assessment).toEqual({
			failureCode: "invalid_option",
			phase: "execution",
			diagnostic: "svn: invalid option: --stat",
			guidance: "Option rejected; re-read command help and remove or replace it before retrying.",
		});
	});

	it("states when execution supplied no diagnostic instead of fabricating a repair", () => {
		const assessment = assessToolFailure("Command exited with code 1", "failed", "Error");

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.phase).toBe("execution");
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
			failureCode: "invalid_option",
			phase: "execution",
			diagnostic: "configdelphi: unknown option --auto",
			guidance: "Option rejected; re-read command help and remove or replace it before retrying.",
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
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("list the parent directory or re-read the path");
	});

	it("forgets an encoding-corrupt attempt after one change-approach directive", () => {
		const assessment = assessToolFailure(
			"PI_FILE_ENCODING_CORRUPTION: corrupt.dat is not valid UTF-8 text",
			"failed",
			"Error",
		);
		expect(assessment).toEqual({
			failureCode: "encoding_corruption",
			phase: "execution",
			guidance:
				"Change approach: exact UTF-8 text replacement is unsafe for this file. Use an encoding-aware or byte-safe tool/workflow instead; do not replay the text edit.",
			attemptMemory: "discard",
		});

		const tracker = new Map();
		const failure = rememberToolFailure(
			tracker,
			"edit",
			{ path: "corrupt.dat", intentId: "secret-attempt", edits: [{ oldText: "payload", newText: "next" }] },
			"failed",
			assessment.failureCode,
			assessment.guidance,
		);
		expect(tracker.size).toBe(0);
		const result = createToolFailureResult(failure);
		expect(result.details).toHaveProperty("piToolFailureDirective");
		expect(result.details).not.toHaveProperty("piToolFailureMemory");

		const failedTurn: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "encoding-call",
						name: "edit",
						arguments: {
							path: "corrupt.dat",
							intentId: "secret-attempt",
							edits: [{ oldText: "payload", newText: "next" }],
						},
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
				toolCallId: "encoding-call",
				toolName: "edit",
				content: result.content,
				isError: true,
				timestamp: 2,
				details: result.details,
			},
		];
		const nextRequest = sanitizeToolFailureContext(failedTurn, "base");
		expect(nextRequest.messages).toEqual([]);
		expect(nextRequest.systemPrompt).toContain("Change approach");
		expect(nextRequest.systemPrompt).not.toContain("secret-attempt");
		expect(nextRequest.systemPrompt).not.toContain("payload");
		expect(nextRequest.systemPrompt).not.toContain("corrupt.dat");

		const afterAgentChangedApproach = sanitizeToolFailureContext(
			[
				...failedTurn,
				{
					role: "assistant",
					content: [{ type: "text", text: "I will use a byte-safe workflow." }],
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
					stopReason: "stop",
					timestamp: 3,
				},
			],
			"base",
		);
		expect(afterAgentChangedApproach.systemPrompt).toBe("base");
	});

	it("labels rejected-argument guidance as repair and execution guidance as next_action", () => {
		const failedText = createToolFailureResult(record("failed")).content[0];
		const rejectedText = createToolFailureResult(record("rejected")).content[0];
		if (failedText?.type !== "text" || rejectedText?.type !== "text") throw new Error("expected text records");

		expect(failedText.text).toContain('"next_action":"Use the contract guidance."');
		expect(failedText.text).toContain('"phase":"execution"');
		expect(failedText.text).not.toContain('"repair":');
		expect(rejectedText.text).toContain('"repair":"Use the contract guidance."');
		expect(rejectedText.text).toContain('"phase":"validation"');
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
