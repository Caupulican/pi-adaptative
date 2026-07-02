import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./test-harness.ts";

describe("G13: dead tool grants are surfaced, never silent", () => {
	it("reports an explicit grant that binds to no registered tool", () => {
		const harness = createHarness();
		try {
			const session = harness.session as unknown as {
				settingsManager: SettingsManager;
				_toolProfileFilter: { allow: string[]; block: string[] };
				_refreshToolRegistry: () => void;
			};
			session._toolProfileFilter = { allow: ["read", "no_such_tool"], block: [] };
			session._refreshToolRegistry();
			const report = harness.session.getContextCompositionReport();
			expect(
				report.observations.some((line) => line.includes('tool grant "no_such_tool" binds to no registered tool')),
			).toBe(true);
			expect(report.observations.some((line) => line.includes('"read"'))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("G14: user disable beats profile grant, surfaced", () => {
	it("reports profile-granted entries the user's disable list overrides", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { skills: { allow: ["my-skill"] }, tools: { allow: ["read"] } } },
			activeResourceProfiles: ["scout"],
			disabledResources: { skills: ["my-skill"] },
		});
		expect(settingsManager.getProfileGrantsOverriddenByUserDisable("skills")).toEqual(["my-skill"]);
		expect(settingsManager.getProfileGrantsOverriddenByUserDisable("tools")).toEqual([]);
		// the merged filter proves the disable actually WINS
		expect(settingsManager.isResourceAllowedByProfile("skills", "my-skill")).toBe(false);
	});
});
