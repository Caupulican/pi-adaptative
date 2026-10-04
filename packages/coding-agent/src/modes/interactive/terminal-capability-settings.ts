import type { TerminalCapabilityOverrides } from "@caupulican/pi-tui";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface TerminalCapabilitySettingsSettingsSource {
	getTerminalHyperlinks(): boolean | undefined;
	getTerminalImages(): "kitty" | "iterm2" | "none" | null | undefined;
	getTerminalTrueColor(): boolean | undefined;
}

/**
 * Map the persisted terminal.hyperlinks/images/trueColor settings (P1g) onto the shape
 * `applyTerminalSettings` expects. Every field defaults to "auto" (undefined here), letting
 * PI_HYPERLINKS/PI_IMAGE_PROTOCOL/PI_TRUE_COLOR and then detection take over per field.
 */
export function terminalCapabilityOverridesFromSettings(
	settingsManager: TerminalCapabilitySettingsSettingsSource,
): TerminalCapabilityOverrides {
	return {
		hyperlinks: settingsManager.getTerminalHyperlinks(),
		images: settingsManager.getTerminalImages(),
		trueColor: settingsManager.getTerminalTrueColor(),
	};
}
