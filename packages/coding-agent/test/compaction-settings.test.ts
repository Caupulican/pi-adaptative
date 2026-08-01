import { DEFAULT_COMPACTION_SETTINGS } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("compaction settings", () => {
	it("derives runtime defaults from the compaction owner", () => {
		const settings = SettingsManager.inMemory().getCompactionSettings();

		expect(settings).toEqual(DEFAULT_COMPACTION_SETTINGS);
		expect(settings.triggerPercent).toBe(0.6);
	});

	it("preserves an explicit user trigger override", () => {
		const settings = SettingsManager.inMemory({ compaction: { triggerPercent: 0.7 } }).getCompactionSettings();

		expect(settings.triggerPercent).toBe(0.7);
	});
});
