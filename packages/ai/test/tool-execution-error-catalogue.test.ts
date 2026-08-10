import { describe, expect, it } from "vitest";
import {
	getToolExecutionErrorGuidance,
	getToolExecutionErrorPolicy,
	getToolExecutionUnchangedRetryLimit,
	REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE,
	TOOL_EXECUTION_ERROR_CATALOGUE,
} from "../src/utils/tool-repair/registry.ts";

describe("tool execution error catalogue", () => {
	it("has a trigger-class fixture for every catalogue entry", () => {
		const fixtures: Record<(typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"], string> = {
			commandNotFound: "spawn rg ENOENT",
			bashNoOutput: "(no output)",
			bashPosixNotSupported: "POSIX shell scripts are not supported by the Windows shell contract router.",
			bashNestedShell:
				"Nested shell execution is not supported by the Windows shell contract router. Invoke the .ps1 path directly with its arguments, without powershell.exe -File or pwsh -File.",
			bashMissingCommandWord: "Missing command: a pipeline/list element has no command word.",
			bashEmptyRedirectTarget: "redirect target expanded to nothing",
			encodingCorruption: "PI_FILE_ENCODING_CORRUPTION: legacy.dat is not valid UTF-8 text",
			repeatedSuccessfulCall: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic,
			fileMutationRetarget:
				"PI_FILE_MUTATION_RETARGET: retained as payloadRef file-mutation:123e4567-e89b-12d3-a456-426614174000",
			fileNotFound: "ENOENT: no such file or directory, open 'missing.txt'",
			editOldTextNotFound: "oldText failed to match the current file contents",
			pathOutsideCwd: "Path is outside the current working directory",
			permissionDenied: "EACCES: permission denied, open 'locked.txt'",
			invalidOption: "svn: invalid option: --stat",
			invalidPattern: "regex parse error: unclosed group",
			outputLimit: "Tool output limit reached; result was truncated",
			timedOut: "Command timed out after 30000ms",
			cancelled: "Operation aborted",
			provisioningFailed: "PI_TOOL_PROVISIONING_FAILED: fd: SHA-256 verification failed",
		};

		for (const entry of TOOL_EXECUTION_ERROR_CATALOGUE) {
			expect(getToolExecutionErrorGuidance(fixtures[entry.name])).toBe(entry.guidance);
		}
	});

	it("assigns deterministic phases and bounded retry actions to common execution failures", () => {
		expect(getToolExecutionErrorPolicy("Command timed out after 30000ms")).toMatchObject({
			name: "timedOut",
			phase: "timeout",
		});
		expect(getToolExecutionErrorPolicy("Operation aborted")).toMatchObject({
			name: "cancelled",
			phase: "cancelled",
		});
		expect(getToolExecutionErrorPolicy("PI_TOOL_PROVISIONING_FAILED: rg: archive extraction failed")).toMatchObject({
			name: "provisioningFailed",
			phase: "provisioning",
			failureCode: "provisioning_failed",
		});
		expect(getToolExecutionErrorPolicy("EACCES: permission denied")).toMatchObject({
			name: "permissionDenied",
			phase: "policy",
		});
		expect(getToolExecutionErrorPolicy("oldText failed to match the current file contents")).toMatchObject({
			name: "editOldTextNotFound",
			failureCode: "edit_old_text_not_found",
			phase: "execution",
		});
		expect(getToolExecutionErrorPolicy("No such file or directory: missing.txt")).toMatchObject({
			name: "fileNotFound",
			failureCode: "file_not_found",
			phase: "execution",
		});
		expect(getToolExecutionErrorPolicy("Path not found: missing.txt")).toMatchObject({
			name: "fileNotFound",
			failureCode: "file_not_found",
			phase: "execution",
		});
	});

	it("keeps the provisioning boundary authoritative over a nested ENOENT diagnostic", () => {
		expect(
			getToolExecutionErrorPolicy(
				"PI_TOOL_PROVISIONING_FAILED [installation_failed] rg: Failed to download ripgrep: spawn uv ENOENT",
			),
		).toMatchObject({
			name: "provisioningFailed",
			phase: "provisioning",
			failureCode: "provisioning_failed",
		});
	});

	it("classifies encoding corruption as a change-approach failure without attempt memory", () => {
		expect(getToolExecutionErrorPolicy("PI_FILE_ENCODING_CORRUPTION: unsafe text bytes")).toEqual({
			name: "encodingCorruption",
			phase: "execution",
			failureCode: "encoding_corruption",
			attemptMemory: "discard",
			retainDiagnostic: false,
			unchangedRetryLimit: 0,
			guidance:
				"Change approach: exact UTF-8 text replacement is unsafe for this file. Use an encoding-aware or byte-safe tool/workflow instead; do not replay the text edit.",
		});
	});

	it("discards repeat-guard attempt memory while teaching the next action", () => {
		expect(getToolExecutionErrorPolicy(REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic)).toEqual({
			name: "repeatedSuccessfulCall",
			phase: "execution",
			failureCode: "repeated_successful_call",
			attemptMemory: "discard",
			retainDiagnostic: true,
			unchangedRetryLimit: 0,
			guidance: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.guidance,
		});
	});

	it("retains only the bounded retarget reference while discarding the original mutation attempt", () => {
		const diagnostic =
			"PI_FILE_MUTATION_RETARGET: retained as payloadRef file-mutation:123e4567-e89b-12d3-a456-426614174000";
		expect(getToolExecutionErrorPolicy(diagnostic)).toMatchObject({
			name: "fileMutationRetarget",
			failureCode: "mutation_retarget_required",
			attemptMemory: "discard",
			retainDiagnostic: true,
		});
	});

	it("allows one unchanged retry only for the timeout policy", () => {
		expect(getToolExecutionUnchangedRetryLimit("timeout")).toBe(1);
		expect(getToolExecutionUnchangedRetryLimit("file_not_found")).toBe(0);
		expect(getToolExecutionUnchangedRetryLimit("unknown_failure")).toBe(0);
	});

	it("leaves uncatalogued errors unchanged", () => {
		expect(getToolExecutionErrorGuidance("the remote service returned 500")).toBeUndefined();
	});

	it("does not confuse an ordinary sentence containing time with a timeout", () => {
		expect(getToolExecutionErrorGuidance("The report includes timeout configuration examples")).toBeUndefined();
	});
});
