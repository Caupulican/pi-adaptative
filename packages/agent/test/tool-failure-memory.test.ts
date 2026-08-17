import { describe, expect, it, vi } from "vitest";
import {
	assessToolFailure,
	createRepeatedToolFailureResult,
	createToolFailureOperationExhaustedResult,
	createToolFailureRecoveryExhaustedResult,
	createToolFailureResult,
	getToolExecutionKey,
	normalizeToolSignature,
	rememberToolFailure,
	sanitizeToolFailureContext,
	type ToolFailureMemoryRecord,
	transcriptHasClosedToolOperation,
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
	it("normalizes tool signatures deterministically regardless of argument key order", () => {
		const signature1 = normalizeToolSignature([["read", { path: "foo.txt", offset: 10, limit: 100 }]]);
		const signature2 = normalizeToolSignature([["read", { limit: 100, path: "foo.txt", offset: 10 }]]);
		expect(signature1).toBe(signature2);
	});

	it("treats resource-envelope fields as outside execution identity", () => {
		expect(getToolExecutionKey("bash", { command: "./test.sh foo.test.ts", timeout: 180 })).toBe(
			getToolExecutionKey("bash", { command: "./test.sh foo.test.ts", timeout: 240 }),
		);
		expect(getToolExecutionKey("bash", { command: "./test.sh foo.test.ts", timeout: 180 })).not.toBe(
			getToolExecutionKey("bash", { command: "./test.sh bar.test.ts", timeout: 180 }),
		);
		expect(normalizeToolSignature([["bash", { command: "./test.sh foo.test.ts", timeout: 30 }]])).toBe(
			normalizeToolSignature([["bash", { command: "./test.sh foo.test.ts", timeout: 90 }]]),
		);
		expect(getToolExecutionKey("python", { code: "print(1)", timeoutSeconds: 30 })).toBe(
			getToolExecutionKey("python", { code: "print(1)", timeoutSeconds: 90 }),
		);
		expect(getToolExecutionKey("python", { code: "print(1)", timeoutSeconds: 30 })).not.toBe(
			getToolExecutionKey("python", { code: "print(2)", timeoutSeconds: 30 }),
		);
	});

	it("deduplicates earlier successful tool calls for identical operations, retaining only the latest", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "data.json" } }],
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
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: '{"key": "value"}' }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "data.json" } }],
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
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "read",
				content: [{ type: "text", text: '{"key": "value"}' }],
				isError: false,
				timestamp: 4,
			},
		];

		const sanitized = sanitizeToolFailureContext(messages, "base");
		expect(sanitized.messages).toHaveLength(2);
		expect(sanitized.messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_2" }],
		});
		expect(sanitized.messages[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_2",
		});
	});

	it("deduplicates different tool calls returning identical text payload content", () => {
		const payload =
			"LOAD_BEARING_DATA_CONTENT_LINE_1\nLOAD_BEARING_DATA_CONTENT_LINE_2\nLOAD_BEARING_DATA_CONTENT_LINE_3";
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_read", name: "read_file", arguments: { path: "config.json" } }],
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
				toolCallId: "call_read",
				toolName: "read_file",
				content: [{ type: "text", text: payload }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_view",
						name: "view_file",
						arguments: { AbsolutePath: "/path/config.json" },
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
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call_view",
				toolName: "view_file",
				content: [{ type: "text", text: payload }],
				isError: false,
				timestamp: 4,
			},
		];

		const sanitized = sanitizeToolFailureContext(messages, "base");
		expect(sanitized.messages).toHaveLength(2);
		expect(sanitized.messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_view" }],
		});
		expect(sanitized.messages[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_view",
		});
	});

	it("tracks an incremental kind_mistakes counter specific to tool kind to aid self-calibration", () => {
		const tracker = new Map();
		const failure1 = rememberToolFailure(
			tracker,
			"bash",
			{ command: "npm test" },
			"failed",
			"exit_1",
			"Fix test failure",
		);
		expect(failure1.kindMistakes).toBe(1);

		const failure2 = rememberToolFailure(
			tracker,
			"bash",
			{ command: "npm build" },
			"failed",
			"exit_1",
			"Fix build failure",
		);
		expect(failure2.kindMistakes).toBe(2);

		const failureRead = rememberToolFailure(
			tracker,
			"read_file",
			{ path: "missing.txt" },
			"failed",
			"file_not_found",
			"Verify path",
		);
		expect(failureRead.kindMistakes).toBe(1);

		const result1 = createToolFailureResult(failure1);
		expect(result1.content[0].type === "text" && result1.content[0].text).toContain('"kind_mistakes":1');

		const sanitized = sanitizeToolFailureContext(
			[
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_err", name: "bash", arguments: { command: "npm test" } }],
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
					toolCallId: "call_err",
					toolName: "bash",
					content: result1.content,
					details: result1.details,
					isError: true,
					timestamp: 2,
				},
			],
			"base",
		);

		expect(sanitized.systemPrompt).toContain("ACTIVE TOOL FAILURES mistakes=bash:1");
		expect(sanitized.systemPrompt).toContain('"kind_mistakes":1');
		expect(sanitized.systemPrompt).toContain("matching backend authority, target kind, and exact scope");
		expect(sanitized.systemPrompt).not.toContain("<harness_tool_failures");
	});

	it("bounds tool-owned evidence and projects newest snapshots within one aggregate budget", () => {
		const tracker = new Map();
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 3; index++) {
			const marker = `CURRENT_SOURCE_${index}`;
			const failure = rememberToolFailure(
				tracker,
				"edit",
				{ path: `subject-${index}.ts`, edits: [{ oldText: `stale-${index}` }] },
				"failed",
				"edit_old_text_not_found",
				"Use the current source snapshot to construct changed exact anchors.",
				undefined,
				"execution",
				`${marker}\0\n${String(index).repeat(4_000)}`,
			);
			expect(failure.evidence?.length).toBeLessThanOrEqual(1_600);
			expect(failure.evidence).not.toContain("\0");
			const result = createToolFailureResult(failure);
			const callId = `edit-${index}`;
			messages.push(
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: callId,
							name: "edit",
							arguments: { path: `subject-${index}.ts`, edits: [{ oldText: `stale-${index}` }] },
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
					timestamp: index * 2 + 1,
				},
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: "edit",
					content: result.content,
					details: result.details,
					isError: true,
					timestamp: index * 2 + 2,
				},
			);
		}

		const nextRequest = sanitizeToolFailureContext(messages, "base");
		const projectedRecords = nextRequest.systemPrompt
			.split("\n")
			.filter((line) => line.startsWith("{") && line.includes('"failure_key"'))
			.map((line) => JSON.parse(line) as { evidence?: string });
		const projectedEvidence = projectedRecords.flatMap((record) =>
			record.evidence === undefined ? [] : [record.evidence],
		);
		expect(nextRequest.messages).toEqual([]);
		expect(projectedEvidence.reduce((total, evidence) => total + evidence.length, 0)).toBeLessThanOrEqual(2_400);
		expect(projectedEvidence.some((evidence) => evidence.startsWith("CURRENT_SOURCE_2"))).toBe(true);
		expect(projectedEvidence.some((evidence) => evidence.startsWith("CURRENT_SOURCE_0"))).toBe(false);
	});

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
			guidance: "Option rejected. Read command help; remove/replace option before retry.",
		});
	});

	it("states when execution supplied no diagnostic instead of fabricating a repair", () => {
		const assessment = assessToolFailure("Command exited with code 1", "failed", "Error");

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toBe(
			"No diagnostic output. Inspect tool contract or request bounded diagnostic before retry.",
		);
	});

	it("keeps an explicit process exit authoritative over identifier-like stdout", () => {
		const assessment = assessToolFailure(
			[
				"let label = generated::EXPORTED_ACTION_LABEL.0;",
				"// A stopped runtime cannot process background work.",
				"Command exited with code 2",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_2");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("No diagnostic output");
	});

	it("still classifies a standalone operating-system errno without an exit trailer", () => {
		const assessment = assessToolFailure("EPIPE: broken pipe", "failed", "Error");

		expect(assessment.failureCode).toBe("epipe");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBe("EPIPE: broken pipe");
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
			guidance: "Option rejected. Read command help; remove/replace option before retry.",
		});
	});

	it("does not promote arbitrary legacy output to a diagnostic without an error boundary", () => {
		const assessment = assessToolFailure(`LEGACY_RAW_OUTPUT:${"x".repeat(10_000)}`, "failed");

		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("No diagnostic output");
	});

	it("does not fabricate a diagnostic from weak stderr lines when a strong signal is required", () => {
		// assessToolFailure passes allowUnclassifiedFallback=false, requireStrongSignal=true here
		// (an authoritative exit code, no catalogued policy). The stderr fast path must honor that
		// same guarantee instead of always returning its last raw lines.
		const assessment = assessToolFailure(
			[
				"stdout:",
				"doing the thing",
				"stderr:",
				"no matches found",
				"retrying is not supported here",
				"Command exited with code 1",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("No diagnostic output");
	});

	it("still surfaces a strong stderr diagnostic when one is present", () => {
		const assessment = assessToolFailure(
			["stdout:", "doing the thing", "stderr:", "error: invalid configuration", "Command exited with code 1"].join(
				"\n",
			),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toBe("error: invalid configuration");
	});

	it("uses catalogued recovery guidance without retaining redundant raw errors", () => {
		const assessment = assessToolFailure("ENOENT: no such file or directory, open 'missing.txt'", "failed", "Error");

		expect(assessment.failureCode).toBe("file_not_found");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("List parent directory or re-read path");
	});

	it("preserves the original failure evidence across repeated blocked replays", () => {
		const original = {
			...record("failed", "invalid_option"),
			diagnostic: "svn: invalid option: --stat",
			correction: "Remove or replace the invalid option.",
		};

		const firstBlocked = createRepeatedToolFailureResult(original);
		const retainedAfterFirst = firstBlocked.details.piToolFailureMemory;
		const secondBlocked = createRepeatedToolFailureResult(retainedAfterFirst);
		const retainedAfterSecond = secondBlocked.details.piToolFailureMemory;
		const secondText = secondBlocked.content[0]?.type === "text" ? secondBlocked.content[0].text : "";

		expect(retainedAfterFirst).toMatchObject({
			failureCode: "invalid_option",
			diagnostic: original.diagnostic,
			correction: expect.stringContaining("SAME OPERATION BLOCKED"),
			occurrence: 2,
		});
		expect(retainedAfterSecond).toMatchObject({
			failureCode: "invalid_option",
			diagnostic: original.diagnostic,
			correction: expect.stringContaining("SAME OPERATION BLOCKED"),
			occurrence: 3,
		});
		expect(secondText).toContain('"failure_code":"repeated_failed_operation"');
		expect(secondText).toContain("Unchanged replay blocked after invalid_option");
		expect(secondText.match(/Unchanged replay blocked/g)).toHaveLength(1);
		expect(secondText.match(/The unchanged operation was not executed\./g)).toHaveLength(1);
	});

	it("replaces spent recovery permission with one retained caveman no-replay directive", () => {
		const original = {
			...record("failed", "exit_101"),
			diagnostic: "error[E0433]: cannot find `windows` in `os`",
			correction: "Loaded actions: edit repair. Exact matching repair evidence grants 1 probe.",
		};
		const blocked = createRepeatedToolFailureResult(original);
		const retained = blocked.details.piToolFailureMemory;
		const text = blocked.content[0]?.type === "text" ? blocked.content[0].text : "";

		expect(retained).toMatchObject({
			failureCode: "exit_101",
			diagnostic: original.diagnostic,
			correction: expect.stringContaining("CAVEMAN MODE - MANDATORY"),
		});
		expect(retained.correction).toContain("SAME OPERATION BLOCKED");
		expect(retained.correction).toContain("NEVER call it again with the same arguments in this run");
		expect(retained.correction).toContain("not a harness loop or failure");
		expect(retained.correction).not.toContain("grants 1 probe");
		expect(text).toContain(retained.correction);

		const nextRequest = sanitizeToolFailureContext(
			[
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "blocked-call", name: "shell", arguments: { command: "cargo test" } }],
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
					toolCallId: "blocked-call",
					toolName: "shell",
					content: blocked.content,
					details: blocked.details,
					isError: true,
					timestamp: 2,
				},
			],
			"base",
		);

		expect(nextRequest.systemPrompt).toContain(retained.correction);
		expect(nextRequest.systemPrompt).not.toContain("grants 1 probe");
	});

	it("keeps a local exhausted operation blocked while directing independent work", () => {
		const original = {
			...record("failed", "edit_old_text_not_found"),
			diagnostic: "The exact oldText anchor is absent.",
			evidence: "Current source sha256 abcdef123456, lines 8-9:\n8 | current anchor",
			correction: "Use current source to submit changed exact anchors.",
		};

		const exhausted = createToolFailureOperationExhaustedResult(
			original,
			"Operation recovery circuit opened after two blocked replays.",
		);
		const text = exhausted.content[0]?.type === "text" ? exhausted.content[0].text : "";

		expect(exhausted.terminate).toBe(false);
		expect(text).toContain('"failure_code":"operation_recovery_exhausted"');
		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain("OPERATION CLOSED");
		expect(text).toContain("NEVER call it again with the same arguments in this run");
		expect(text).toContain("The recovery guard prevented a loop; this is not harness failure");
		expect(text).toContain("Use a different operation/tool or continue independent work");
		expect(text).not.toContain("Stop retrying tools in this run");
		expect(text).toContain("Current source sha256 abcdef123456");
		expect(exhausted.details.piToolFailureMemory).toMatchObject({
			failureCode: "edit_old_text_not_found",
			diagnostic: original.diagnostic,
			evidence: original.evidence,
			correction: expect.stringContaining("OPERATION CLOSED"),
			occurrence: 2,
		});
	});

	it("terminates a run-wide exhausted recovery circuit without replacing its root evidence", () => {
		const original = {
			...record("failed", "file_not_found"),
			diagnostic: "ENOENT: missing.txt",
			correction: "Create or retarget the missing path.",
		};

		const exhausted = createToolFailureRecoveryExhaustedResult(
			original,
			"Recovery circuit opened after two blocked replays.",
		);
		const text = exhausted.content[0]?.type === "text" ? exhausted.content[0].text : "";

		expect(exhausted.terminate).toBe(true);
		expect(text).toContain('"failure_code":"recovery_exhausted"');
		expect(text).toContain("Stop retrying tools in this run");
		expect(exhausted.details.piToolFailureMemory).toMatchObject({
			failureCode: "file_not_found",
			diagnostic: original.diagnostic,
			correction: original.correction,
			occurrence: 2,
		});
	});

	it("detects a closed identical operation from persisted recovery_exhausted results", () => {
		const original = record("failed", "error");
		const exhausted = createToolFailureRecoveryExhaustedResult(original, "run circuit opened");
		const args = { action: "list_lists", envFile: "/tmp/trello.env" };
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "trello-1", name: "trello", arguments: args }],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
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
				toolCallId: "trello-1",
				toolName: "trello",
				content: exhausted.content,
				details: exhausted.details,
				isError: true,
				timestamp: 1,
			},
		];
		expect(transcriptHasClosedToolOperation(messages)).toBe(true);
		expect(transcriptHasClosedToolOperation(JSON.parse(JSON.stringify(messages)) as AgentMessage[])).toBe(true);
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
				"Change approach: exact UTF-8 replacement unsafe. Use encoding-aware/byte-safe tool; never replay text edit.",
			attemptMemory: "discard",
		});

		const tracker = new Map();
		const failure = rememberToolFailure(
			tracker,
			"edit",
			{ path: "corrupt.dat", edits: [{ oldText: "payload", newText: "next" }] },
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

	it("teaches a retained mutation retarget without preserving generated content", () => {
		const payloadRef = "file-mutation:123e4567-e89b-12d3-a456-426614174000";
		const assessment = assessToolFailure(
			`Write collision. PI_FILE_MUTATION_RETARGET: exact payload retained as payloadRef ${payloadRef}.`,
			"failed",
			"Error",
		);

		expect(assessment).toMatchObject({
			failureCode: "mutation_retarget_required",
			phase: "execution",
			attemptMemory: "discard",
			diagnostic: expect.stringContaining(payloadRef),
			guidance: expect.stringContaining("corrected target path"),
		});
		const tracker = new Map();
		const failure = rememberToolFailure(
			tracker,
			"write",
			{ path: "occupied.txt", content: "GENERATED_CONTENT_MUST_NOT_SURVIVE" },
			"failed",
			assessment.failureCode,
			assessment.guidance,
			assessment.diagnostic,
			assessment.phase,
		);
		expect(tracker.size).toBe(0);
		const result = createToolFailureResult(failure);
		expect(JSON.stringify(result)).toContain(payloadRef);
		expect(JSON.stringify(result)).not.toContain("GENERATED_CONTENT_MUST_NOT_SURVIVE");
		const nextRequest = sanitizeToolFailureContext(
			[
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "retarget-call",
							name: "write",
							arguments: { path: "occupied.txt", content: "GENERATED_CONTENT_MUST_NOT_SURVIVE" },
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
					toolCallId: "retarget-call",
					toolName: "write",
					content: result.content,
					details: result.details,
					isError: true,
					timestamp: 2,
				},
			],
			"base",
		);
		expect(nextRequest.messages).toEqual([]);
		expect(nextRequest.systemPrompt).toContain(payloadRef);
		expect(nextRequest.systemPrompt).not.toContain("GENERATED_CONTENT_MUST_NOT_SURVIVE");
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
		expect(sanitized.systemPrompt).toContain("No diagnostic output");
		expect(sanitized.systemPrompt).not.toContain("Change the arguments or approach");
		expect(sanitized.systemPrompt).not.toContain('"repair":');
	});
});
