import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Strict least-privilege profiles: an active profile set is the COMPLETE grant. Any
 * authority-bearing kind no active profile explicitly mentions is denied outright; grant-all must
 * be explicit via allow: ["*"]. Themes are exempt (cosmetic). No active profile = unchanged.
 */
describe("strict profile UAC", () => {
	it("denies every unmentioned authority kind under an empty-defaults profile", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { empty: {} },
			activeResourceProfiles: ["empty"],
		});

		for (const kind of ["extensions", "skills", "prompts", "tools", "agents"] as const) {
			expect(settingsManager.getResourceProfileFilter(kind)).toEqual({ allow: [], block: ["*"] });
			expect(settingsManager.isResourceAllowedByProfile(kind, "/anywhere/thing.ts")).toBe(false);
		}
	});

	it("keeps themes exempt from strict denial", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { empty: {} },
			activeResourceProfiles: ["empty"],
		});

		expect(settingsManager.getResourceProfileFilter("themes")).toEqual({ allow: [], block: [] });
		expect(settingsManager.isResourceAllowedByProfile("themes", "/themes/dark.json")).toBe(true);
	});

	it("honors an explicit allow-list for a mentioned kind while still denying the rest", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { tools: { allow: ["read", "grep"] } } },
			activeResourceProfiles: ["scout"],
		});

		const tools = settingsManager.getResourceProfileFilter("tools");
		expect(tools.allow).toEqual(["read", "grep"]);
		expect(settingsManager.isResourceAllowedByProfile("tools", "read")).toBe(true);
		expect(settingsManager.isResourceAllowedByProfile("tools", "bash")).toBe(false);

		expect(settingsManager.isResourceAllowedByProfile("extensions", "/ext/anything.ts")).toBe(false);
	});

	it("treats allow ['*'] as the explicit grant-everything", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { open: { extensions: { allow: ["*"] } } },
			activeResourceProfiles: ["open"],
		});

		expect(settingsManager.isResourceAllowedByProfile("extensions", "/ext/anything.ts")).toBe(true);
		// Other kinds stay denied — the wildcard grant is per-kind.
		expect(settingsManager.isResourceAllowedByProfile("skills", "/skills/anything.md")).toBe(false);
	});

	it("keeps explicit block framing meaning all-except-blocked for the mentioned kind", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { mostly: { extensions: { block: ["banned-ext"] } } },
			activeResourceProfiles: ["mostly"],
		});

		expect(settingsManager.isResourceAllowedByProfile("extensions", "/ext/banned-ext")).toBe(false);
		expect(settingsManager.isResourceAllowedByProfile("extensions", "/ext/fine-ext")).toBe(true);
		// Unmentioned kinds are still denied.
		expect(settingsManager.isResourceAllowedByProfile("tools", "bash")).toBe(false);
	});

	it("merges grants across multiple active profiles", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				reader: { tools: { allow: ["read"] } },
				runner: { tools: { allow: ["bash"] } },
			},
			activeResourceProfiles: ["reader", "runner"],
		});

		expect(settingsManager.isResourceAllowedByProfile("tools", "read")).toBe(true);
		expect(settingsManager.isResourceAllowedByProfile("tools", "bash")).toBe(true);
		expect(settingsManager.isResourceAllowedByProfile("tools", "write")).toBe(false);
	});

	it("changes nothing when no profile is active", () => {
		const settingsManager = SettingsManager.inMemory();

		for (const kind of ["extensions", "skills", "prompts", "tools", "agents", "themes"] as const) {
			expect(settingsManager.getResourceProfileFilter(kind)).toEqual({ allow: [], block: [] });
			expect(settingsManager.isResourceAllowedByProfile(kind, "/anywhere/thing.ts")).toBe(true);
		}
	});
});
