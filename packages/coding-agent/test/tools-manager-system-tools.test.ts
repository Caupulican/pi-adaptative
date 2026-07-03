import { describe, expect, it } from "vitest";
import { detectPython } from "../src/utils/tools-manager.ts";

/**
 * python3/python detection for the environment doctor (src/core/doctor.ts).
 * A SYSTEM tool: the doctor only ever reports on it (guide mode when
 * missing), never installs it.
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
