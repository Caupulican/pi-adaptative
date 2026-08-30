import { describe, expect, it, vi } from "vitest";
import {
	assessToolFailure,
	createRepeatedToolFailureResult,
	createToolFailureResult,
	getToolExecutionKey,
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

		expect(sanitized.ledger).toContain("ACTIVE TOOL FAILURES mistakes=bash:1");
		expect(sanitized.ledger).toContain('"kind_mistakes":1');
		expect(sanitized.ledger).toContain("Retry unchanged only after any other tool succeeds or a new user turn.");
		expect(sanitized.ledger).not.toContain("<harness_tool_failures");
	});

	it("bounds tool-owned evidence per record and keeps it in the transcript instead of the ledger", () => {
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
		const projectedRecords = (nextRequest.ledger ?? "")
			.split("\n")
			.filter((line) => line.startsWith("{") && line.includes('"failure_key"'))
			.map((line) => JSON.parse(line) as { evidence?: string });
		// Every call the agent made, and the bounded record it got back, stay exactly where they happened.
		expect(nextRequest.messages).toEqual(messages);
		expect(projectedRecords).toHaveLength(3);
		// The ledger names what is unresolved; it never re-sends evidence already sitting in the transcript.
		expect(projectedRecords.every((record) => record.evidence === undefined)).toBe(true);
		expect(nextRequest.ledger).not.toContain("CURRENT_SOURCE_");
		const transcriptEvidence = messages.flatMap((message) =>
			message.role === "toolResult" && message.content[0]?.type === "text" ? [message.content[0].text] : [],
		);
		expect(transcriptEvidence).toHaveLength(3);
		for (const [index, text] of transcriptEvidence.entries()) {
			expect(text).toContain(`CURRENT_SOURCE_${index}`);
			expect(text.length).toBeLessThanOrEqual(2_400);
		}
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

		expect(assessment).toMatchObject({
			failureCode: "invalid_option",
			phase: "execution",
			diagnostic: "svn: invalid option: --stat",
			guidance: "Option rejected. Read command help; remove/replace option before retry.",
			policyGuidance: "Option rejected. Read command help; remove/replace option before retry.",
		});
		expect(assessment.evidence?.length).toBeLessThanOrEqual(1_600);
		expect(assessment.evidence?.endsWith("svn: invalid option: --stat")).toBe(true);
	});

	it("states when execution supplied no diagnostic instead of fabricating a repair", () => {
		const assessment = assessToolFailure("Command exited with code 1", "failed", "Error");

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.evidence).toBeUndefined();
		expect(assessment.policyGuidance).toBeUndefined();
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
			evidence: "configdelphi: unknown option --auto",
			guidance: "Option rejected. Read command help; remove/replace option before retry.",
			policyGuidance: "Option rejected. Read command help; remove/replace option before retry.",
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
		expect(assessment.evidence).toBe(
			["doing the thing", "no matches found", "retrying is not supported here"].join("\n"),
		);
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
		expect(assessment.evidence).toBe(["doing the thing", "error: invalid configuration"].join("\n"));
	});

	it("keeps the raw output tail as evidence when an exit failure has no classifiable diagnostic", () => {
		const grepHits = [
			"packages/first/src/registry.ts:42:const entry = catalogue.find((candidate) => candidate.matches(text));",
			"packages/second/src/loop.ts:120:const outcome = await runStep(call);",
		];
		const assessment = assessToolFailure([...grepHits, "Command exited with code 2"].join("\n"), "failed", "Error");

		expect(assessment.failureCode).toBe("exit_2");
		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.evidence).toBe(grepHits.join("\n"));
	});

	it("bounds exit-failure evidence and strips binary bytes while excluding status markers", () => {
		const bulk = Array.from({ length: 200 }, (_, index) => `chunk-${index} ${"x".repeat(20)}`);
		const assessment = assessToolFailure(
			[
				"outcome: failed",
				...bulk,
				"payload\0tail",
				"stderr: (empty)",
				"Command exited with code 1",
				"exitCode: 1",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.evidence?.length).toBeLessThanOrEqual(1_600);
		expect(assessment.evidence).not.toContain("\0");
		expect(assessment.evidence).toContain("payload");
		expect(assessment.evidence).not.toMatch(/^outcome:/im);
		expect(assessment.evidence).not.toMatch(/^exitcode:/im);
		expect(assessment.evidence).not.toMatch(/^stderr:/im);
		expect(assessment.evidence).not.toMatch(/^command exited/im);
	});

	it("keeps the tail rather than the head of one oversized process-output line", () => {
		const assessment = assessToolFailure(
			`HEAD_MARKER_${"x".repeat(2_000)}_TAIL_MARKER\nCommand exited with code 9`,
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_9");
		expect(assessment.evidence?.length).toBeLessThanOrEqual(1_600);
		expect(assessment.evidence).not.toContain("HEAD_MARKER");
		expect(assessment.evidence).toContain("TAIL_MARKER");
	});

	it("retains the catalogued missing-path diagnostic naming the exact path", () => {
		const assessment = assessToolFailure(
			"ENOENT: no such file or directory, open '/repo/docs/missing.txt'",
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("file_not_found");
		expect(assessment.phase).toBe("execution");
		expect(assessment.diagnostic).toContain("/repo/docs/missing.txt");
		expect(assessment.evidence).toBeUndefined();
		expect(assessment.guidance).toContain("List parent directory or re-read path");
		expect(assessment.policyGuidance).toBe("Path not found. List parent directory or re-read path before retry.");
	});

	it("promotes the wrapped payload instead of the untrusted-content envelope tag", () => {
		const assessment = assessToolFailure(
			[
				'<untrusted_content id="4f2a" source="tool:delegate">',
				"delegate cancel requires agentId; agentIds is not accepted",
				"</untrusted_content>",
			].join("\n"),
			"failed",
			"tool_result_error",
		);

		expect(assessment.diagnostic).toBe("delegate cancel requires agentId; agentIds is not accepted");
		expect(assessment.diagnostic).not.toContain("untrusted_content");
	});

	it("keeps the wrapped payload in exit evidence and never the envelope tag", () => {
		const assessment = assessToolFailure(
			[
				'<untrusted_content id="4f2a" source="tool:delegate">',
				"error: worker worker-10 refused the cancel request",
				"</untrusted_content>",
				"Command exited with code 1",
			].join("\n"),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toBe("error: worker worker-10 refused the cancel request");
		expect(assessment.evidence).toBe("error: worker worker-10 refused the cancel request");
		expect(assessment.evidence).not.toContain("untrusted_content");
	});

	it("strips the envelope from the stderr last-lines fallback diagnostic", () => {
		const assessment = assessToolFailure(
			[
				"stdout:",
				"dispatching cancel",
				"stderr:",
				'<untrusted_content id="9c1b" source="tool:delegate">',
				"delegate cancel requires agentId",
				"</untrusted_content>",
			].join("\n"),
			"failed",
			"tool_result_error",
		);

		expect(assessment.diagnostic).toBe("delegate cancel requires agentId");
		expect(assessment.diagnostic).not.toContain("untrusted_content");
	});

	it("leaves an unwrapped failure diagnostic and evidence unchanged", () => {
		const assessment = assessToolFailure(
			["stdout:", "doing the thing", "stderr:", "error: invalid configuration", "Command exited with code 1"].join(
				"\n",
			),
			"failed",
			"Error",
		);

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toBe("error: invalid configuration");
		expect(assessment.evidence).toBe(["doing the thing", "error: invalid configuration"].join("\n"));
	});

	it("reports no diagnostic when the payload inside the envelope is empty", () => {
		const assessment = assessToolFailure(
			['<untrusted_content id="0d33" source="tool:delegate">', "", "</untrusted_content>"].join("\n"),
			"failed",
			"tool_result_error",
		);

		expect(assessment.diagnostic).toBeUndefined();
		expect(assessment.guidance).toContain("No diagnostic output");
	});

	it("caps remembered corrections at 480 characters", () => {
		const tracker = new Map();
		const overlong = rememberToolFailure(tracker, "bash", { command: "long" }, "failed", "exit_1", "g".repeat(481));
		expect(overlong.correction.length).toBe(480);
		expect(overlong.correction.endsWith("…")).toBe(true);

		const exact = "g".repeat(480);
		const kept = rememberToolFailure(tracker, "bash", { command: "exact" }, "failed", "exit_1", exact);
		expect(kept.correction).toBe(exact);
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
			correction: original.correction,
			occurrence: 2,
		});
		expect(retainedAfterSecond).toMatchObject({
			failureCode: "invalid_option",
			diagnostic: original.diagnostic,
			correction: original.correction,
			occurrence: 3,
		});
		expect(secondText).toContain('"failure_code":"repeated_failed_operation"');
		expect(secondText).toContain('"diagnostic":"svn: invalid option: --stat"');
		expect(secondText).toContain(
			'"note":"Not executed: unchanged. The operation is readmitted after another tool succeeds or a new user turn."',
		);
		expect(secondText.match(/Not executed: unchanged/g)).toHaveLength(1);
	});

	it("leads a blocked replay with the retained root-cause diagnostic and keeps the replay notice as a note", () => {
		const original = {
			...record("failed", "file_not_found"),
			diagnostic: "ENOENT: no such file or directory, open '/repo/docs/missing.txt'",
			correction: "Path not found. List parent directory or re-read path before retry.",
		};

		const blocked = createRepeatedToolFailureResult(original);
		const text = blocked.content[0]?.type === "text" ? blocked.content[0].text : "";

		expect(text).toContain('"failure_code":"repeated_failed_operation"');
		expect(text).toContain("ENOENT: no such file or directory, open '/repo/docs/missing.txt'");
		expect(text).toContain(
			'"note":"Not executed: unchanged. The operation is readmitted after another tool succeeds or a new user turn."',
		);
		expect(text).toContain('"next_action":"Path not found. List parent directory or re-read path before retry."');
		expect(text).not.toContain("CAVEMAN");
		expect(blocked.details.piToolFailureMemory).toMatchObject({
			failureCode: "file_not_found",
			diagnostic: original.diagnostic,
			correction: original.correction,
			occurrence: 2,
		});
	});

	it("keeps the replay notice as the diagnostic when no root-cause diagnostic was retained", () => {
		const blocked = createRepeatedToolFailureResult(record("failed"));
		const text = blocked.content[0]?.type === "text" ? blocked.content[0].text : "";

		expect(text).toContain(
			'"diagnostic":"Not executed: unchanged. The operation is readmitted after another tool succeeds or a new user turn."',
		);
		expect(text).not.toContain('"note":');
		expect(text).toContain(
			'"next_action":"Not executed: its last result is already above. Do corrective work or use a different operation. The operation is readmitted after another tool succeeds or a new user turn."',
		);
		expect(blocked.details.piToolFailureMemory.correction).toBe("Use the contract guidance.");
	});

	it("keeps the retained policy correction and root diagnostic across a blocked replay", () => {
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
			correction: original.correction,
		});
		expect(text).toContain('"diagnostic":"error[E0433]: cannot find `windows` in `os`"');
		expect(text).toContain(
			'"note":"Not executed: unchanged. The operation is readmitted after another tool succeeds or a new user turn."',
		);
		expect(text).toContain(retained.correction);
		expect(text).not.toContain("CAVEMAN");

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

		expect(nextRequest.ledger).toContain(retained.correction);
		expect(nextRequest.ledger).toContain("error[E0433]: cannot find `windows` in `os`");
	});

	it("refuses an unchanged replay without terminating, and without paying for the same evidence twice", () => {
		const original = {
			...record("failed", "edit_old_text_not_found"),
			diagnostic: "The exact oldText anchor is absent.",
			evidence: "Current source sha256 abcdef123456, lines 8-9:\n8 | current anchor",
			correction: "Use current source to submit changed exact anchors.",
		};

		const blocked = createRepeatedToolFailureResult(original);
		const text = blocked.content[0]?.type === "text" ? blocked.content[0].text : "";

		// Refusing one replay never ends anything: no terminate flag, and no instruction to stop.
		expect(blocked.terminate).toBeUndefined();
		expect(text).toContain('"failure_code":"repeated_failed_operation"');
		expect(text).toContain('"diagnostic":"The exact oldText anchor is absent."');
		expect(text).toContain("Not executed: unchanged");
		expect(text).toContain("The operation is readmitted after another tool succeeds or a new user turn");
		// The retained root-cause correction stays the actionable next_action.
		expect(text).toContain('"next_action":"Use current source to submit changed exact anchors."');
		expect(text).not.toContain("Stop retrying tools in this run");
		expect(text).not.toContain("will not run again this session");
		// Nothing executed, so this result restates no evidence; the prior run's copy still stands in
		// the transcript, and retained memory keeps it for the next block.
		expect(text).not.toContain("Current source sha256 abcdef123456");
		expect(blocked.details.piToolFailureMemory).toMatchObject({
			failureCode: "edit_old_text_not_found",
			diagnostic: original.diagnostic,
			evidence: original.evidence,
			occurrence: 2,
		});
	});

	it("clears an earlier failure once the same operation runs and reports its own status", () => {
		const tracker = new Map();
		const args = { command: "python3 -m unittest tests.test_head_aim" };
		const failed = rememberToolFailure(
			tracker,
			"bash",
			args,
			"failed",
			"command_not_found",
			"Install python3 before retrying.",
			"python3: command not found",
		);
		const assistant = (id: string): AgentMessage => ({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: args }],
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
		});
		// A pre-fix transcript: the tool genuinely could not run, recorded as a harness failure. Then,
		// after this change, the same operation runs to completion and reports a non-zero exit.
		const messages: AgentMessage[] = [
			assistant("bash-1"),
			{
				role: "toolResult",
				toolCallId: "bash-1",
				toolName: "bash",
				content: createToolFailureResult(failed).content,
				details: createToolFailureResult(failed).details,
				isError: true,
				timestamp: 2,
			},
			assistant("bash-2"),
			{
				role: "toolResult",
				toolCallId: "bash-2",
				toolName: "bash",
				content: [{ type: "text", text: "FAILED (errors=2)\n\nCommand exited with code 1" }],
				isError: true,
				errorKind: "operation_outcome",
				timestamp: 3,
			},
		];

		const sanitized = sanitizeToolFailureContext(messages, "base");
		expect(sanitized.systemPrompt).toBe("base");
		expect(sanitized.ledger).toBeUndefined();
		expect(sanitized.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
		expect(sanitized.systemPrompt).not.toContain("command_not_found");
		expect(sanitized.messages).toEqual(messages);
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
			policyGuidance:
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
		expect(nextRequest.ledger).toContain("Change approach");
		expect(nextRequest.ledger).not.toContain("payload");
		expect(nextRequest.ledger).not.toContain("corrupt.dat");

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
		expect(afterAgentChangedApproach.ledger).toBeUndefined();
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
		// A discard-attempt directive hands the agent a payloadRef, so the original call comes out.
		expect(nextRequest.messages).toEqual([]);
		expect(nextRequest.ledger).toContain(payloadRef);
		expect(nextRequest.ledger).not.toContain("GENERATED_CONTENT_MUST_NOT_SURVIVE");
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

		expect(sanitized.messages).toEqual(messages);
		expect(sanitized.ledger).toContain('"next_action":');
		expect(sanitized.ledger).toContain("No diagnostic output");
		expect(sanitized.ledger).not.toContain("Change the arguments or approach");
		expect(sanitized.ledger).not.toContain('"repair":');
	});
});
