import type { TerminalCapabilityOverrides } from "@caupulican/pi-tui";
import type { SettingsManager } from "../../core/settings-manager.ts";

/**
 * Map the persisted terminal.hyperlinks/images/trueColor settings (P1g) onto the shape
 * `applyTerminalSettings` expects. Every field defaults to "auto" (undefined here), letting
 * PI_HYPERLINKS/PI_IMAGE_PROTOCOL/PI_TRUE_COLOR and then detection take over per field.
 */
export function terminalCapabilityOverridesFromSettings(settingsManager: SettingsManager): TerminalCapabilityOverrides {
	return {
		hyperlinks: settingsManager.getTerminalHyperlinks(),
		images: settingsManager.getTerminalImages(),
		trueColor: settingsManager.getTerminalTrueColor(),
	};
}
