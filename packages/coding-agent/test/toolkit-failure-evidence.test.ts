import {
	MAX_TOOL_FAILURE_EVIDENCE_CHARS,
	sanitizeToolFailureEvidence,
} from "@caupulican/pi-agent-core/tool-failure-memory";
import { describe, expect, it } from "vitest";
import { createRunToolkitScriptToolDefinition } from "../src/core/tools/run-toolkit-script.ts";

const tool = createRunToolkitScriptToolDefinition({
	getScripts: () => [],
	execute: async () => {
		throw new Error("Evidence projection must never execute a script");
	},
});

describe("toolkit incomplete execution evidence", () => {
	it.each(["short", "long", "oversized_header"] as const)(
		"keeps bounded output and its artifact pointer: %s",
		(shape) => {
			const header = shape === "oversized_header" ? "X".repeat(5000) : "FAILED: fixture exited null";
			const stdout =
				shape === "short"
					? "actual stdout"
					: Array.from({ length: 300 }, (_, index) => `actual stdout ${index}: 漢字🙂`).join("\n");
			const notice = "[Full output: artifact tool-output:0123456789abcdef]";
			const message = `${header}\nstdout:\n${stdout}\nstderr:\nactual stderr\n${notice}`;
			const evidence = sanitizeToolFailureEvidence(
				tool.failureRecovery?.getFailureEvidence?.(
					{ script: "fixture" },
					{ failureCode: "toolkit_execution_incomplete", message },
				),
			);
			expect(evidence).toBeDefined();
			expect(evidence!.length).toBeLessThanOrEqual(MAX_TOOL_FAILURE_EVIDENCE_CHARS);
			expect(evidence).toContain("actual stderr");
			expect(evidence).toContain(notice);
			if (shape !== "oversized_header") expect(evidence).toContain("actual stdout");
			if (shape === "short") expect(evidence).toBe(message);
		},
	);

	it.each(["timeout", "aborted", "exit_1", "permission_denied"])(
		"does not reinterpret %s as incomplete execution",
		(failureCode) => {
			expect(
				tool.failureRecovery?.getFailureEvidence?.(
					{ script: "fixture" },
					{ failureCode, message: "stdout:\npartial output" },
				),
			).toBeUndefined();
		},
	);
});
