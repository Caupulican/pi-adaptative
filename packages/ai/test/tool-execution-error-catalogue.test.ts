import { describe, expect, it } from "vitest";
import { getToolExecutionErrorGuidance, TOOL_EXECUTION_ERROR_CATALOGUE } from "../src/utils/tool-repair/registry.ts";

describe("tool execution error catalogue", () => {
	it("has a trigger-class fixture for every catalogue entry", () => {
		const fixtures: Record<(typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"], string> = {
			commandNotFound: "spawn rg ENOENT",
			fileNotFound: "ENOENT: no such file or directory, open 'missing.txt'",
			editOldTextNotFound: "oldText failed to match the current file contents",
			pathOutsideCwd: "Path is outside the current working directory",
		};

		for (const entry of TOOL_EXECUTION_ERROR_CATALOGUE) {
			expect(getToolExecutionErrorGuidance(fixtures[entry.name])).toBe(entry.guidance);
		}
	});

	it("leaves uncatalogued errors unchanged", () => {
		expect(getToolExecutionErrorGuidance("the remote service returned 500")).toBeUndefined();
	});
});
