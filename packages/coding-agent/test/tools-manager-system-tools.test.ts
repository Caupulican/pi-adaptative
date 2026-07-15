import { describe, expect, it } from "vitest";
import { detectPython } from "../src/utils/tools-manager.ts";

/**
 * Low-level system-Python detection remains available for diagnostics and
 * compatibility. The native Python tool itself resolves through uv.
 */
describe("detectPython", () => {
	it("reports present with a version string when a real python command resolves", () => {
		const status = detectPython();
		// This dev/CI environment has python3 installed; assert against the
		// real command rather than mocking spawnSync, matching how
		// fff-search-parity.test.ts gates on the real getToolPath("rg")/("fd").
		expect(status.present).toBe(true);
		expect(status.command).toBeDefined();
		expect(status.version).toMatch(/Python \d+\.\d+/);
	});

	it("reports absent without throwing when no candidate command resolves", () => {
		const status = detectPython(["definitely-not-a-real-command-xyz"]);
		expect(status).toEqual({ present: false });
	});
});
