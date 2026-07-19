import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("worktree-sync settings", () => {
	it("resolves enabled true by default, with the documented policy/gate defaults", () => {
		const settingsManager = SettingsManager.inMemory();

		const resolved = settingsManager.getWorktreeSyncSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.syncPolicy).toBe("on_land_mandatory");
		expect(resolved.gate).toBe("on");
	});

	it("honors an explicit disable as the hard off-switch", () => {
		const settingsManager = SettingsManager.inMemory({ worktreeSync: { enabled: false } });

		expect(settingsManager.getWorktreeSyncSettings().enabled).toBe(false);
	});
});
