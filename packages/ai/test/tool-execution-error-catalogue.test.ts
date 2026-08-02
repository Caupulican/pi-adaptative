import { describe, expect, it } from "vitest";
import {
	getToolExecutionErrorGuidance,
	getToolExecutionErrorPolicy,
	TOOL_EXECUTION_ERROR_CATALOGUE,
} from "../src/utils/tool-repair/registry.ts";

describe("tool execution error catalogue", () => {
	it("has a trigger-class fixture for every catalogue entry", () => {
		const fixtures: Record<(typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"], string> = {
			commandNotFound: "spawn rg ENOENT",
			encodingCorruption: "PI_FILE_ENCODING_CORRUPTION: legacy.dat is not valid UTF-8 text",
			fileNotFound: "ENOENT: no such file or directory, open 'missing.txt'",
			editOldTextNotFound: "oldText failed to match the current file contents",
			pathOutsideCwd: "Path is outside the current working directory",
		};

		for (const entry of TOOL_EXECUTION_ERROR_CATALOGUE) {
			expect(getToolExecutionErrorGuidance(fixtures[entry.name])).toBe(entry.guidance);
		}
	});

	it("classifies encoding corruption as a change-approach failure without attempt memory", () => {
		expect(getToolExecutionErrorPolicy("PI_FILE_ENCODING_CORRUPTION: unsafe text bytes")).toEqual({
			name: "encodingCorruption",
			failureCode: "encoding_corruption",
			attemptMemory: "discard",
			guidance:
				"Change approach: exact UTF-8 text replacement is unsafe for this file. Use an encoding-aware or byte-safe tool/workflow instead; do not replay the text edit.",
		});
	});

	it("leaves uncatalogued errors unchanged", () => {
		expect(getToolExecutionErrorGuidance("the remote service returned 500")).toBeUndefined();
	});
});
