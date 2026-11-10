import { interfaceText } from "../../core/language/interface-text.ts";
import type { ThinkingLevel } from "../../kernel/index.ts";

/**
 * Provider-neutral descriptions shared by every interactive thinking-level selector. Each entry is read
 * when the level is drawn, so the keys stay the levels themselves and the words follow the language.
 */
export const THINKING_LEVEL_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
	get off() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.off;
	},
	get minimal() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.minimal;
	},
	get low() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.low;
	},
	get medium() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.medium;
	},
	get high() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.high;
	},
	get xhigh() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.xhigh;
	},
	get max() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.max;
	},
	get ultra() {
		return interfaceText().settingsScreen.dialogs.thinkingLevels.ultra;
	},
};
