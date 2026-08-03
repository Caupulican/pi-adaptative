import { describe, expect, it } from "vitest";
import {
	getToolExecutionErrorGuidance,
	getToolExecutionErrorPolicy,
	REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE,
	TOOL_EXECUTION_ERROR_CATALOGUE,
} from "../src/utils/tool-repair/registry.ts";

describe("tool execution error catalogue", () => {
	it("has a trigger-class fixture for every catalogue entry", () => {
		const fixtures: Record<(typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"], string> = {
			commandNotFound: "spawn rg ENOENT",
			encodingCorruption: "PI_FILE_ENCODING_CORRUPTION: legacy.dat is not valid UTF-8 text",
			repeatedSuccessfulCall: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic,
			fileMutationIntentInvalid: "File mutation intent is invalid, expired, or belongs to another session",
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
			guidance: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.guidance,
		});
	});

	it("leaves uncatalogued errors unchanged", () => {
		expect(getToolExecutionErrorGuidance("the remote service returned 500")).toBeUndefined();
	});

	it("does not confuse an ordinary sentence containing time with a timeout", () => {
		expect(getToolExecutionErrorGuidance("The report includes timeout configuration examples")).toBeUndefined();
	});
});
