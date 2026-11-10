/**
 * The Brazilian Portuguese catalogue. It is typed as the English catalogue's shape, so a missing area, a missing entry,
 * an extra entry or a different argument list is a compile error rather than a window that falls back to English.
 */

import type { InterfaceText } from "../interface-text.ts";
import { COMMANDS } from "./commands.ts";
import { FRAME } from "./frame.ts";
import { KEYS } from "./keys.ts";
import { SETTINGS } from "./settings.ts";
import { STATUS } from "./status.ts";

export const PT_BR: InterfaceText = {
	frame: FRAME,
	keys: KEYS,
	commands: COMMANDS,
	settings: SETTINGS,
	status: STATUS,
};
