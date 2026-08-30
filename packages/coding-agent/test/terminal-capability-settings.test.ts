import { applyTerminalSettings, resetCapabilitiesCache } from "@caupulican/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { terminalCapabilityOverridesFromSettings } from "../src/modes/interactive/terminal-capability-settings.ts";

describe("terminalCapabilityOverridesFromSettings (C3/P1g)", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("maps persisted terminal settings onto TerminalCapabilityOverrides", () => {
		const settingsManager = SettingsManager.inMemory({
			terminal: { hyperlinks: true, images: "kitty", trueColor: false },
		});

		expect(terminalCapabilityOverridesFromSettings(settingsManager)).toEqual({
			hyperlinks: true,
			images: "kitty",
			trueColor: false,
		});
	});

	it("defaults every field to undefined (auto) when unset, letting env/detection take over", () => {
		const settingsManager = SettingsManager.inMemory({});

		expect(terminalCapabilityOverridesFromSettings(settingsManager)).toEqual({
			hyperlinks: undefined,
			images: undefined,
			trueColor: undefined,
		});
	});

	it("feeds applyTerminalSettings so a persisted setting takes effect immediately (C3 wiring)", () => {
		const settingsManager = SettingsManager.inMemory({
			terminal: { hyperlinks: false, images: "none", trueColor: true },
		});

		const caps = applyTerminalSettings(terminalCapabilityOverridesFromSettings(settingsManager));

		expect(caps.hyperlinks).toBe(false);
		expect(caps.images).toBeNull();
		expect(caps.trueColor).toBe(true);
	});
});
