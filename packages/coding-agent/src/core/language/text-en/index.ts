/**
 * The English catalogue: one object per area of the interface this build translates, composed into the single text the
 * render code reads.
 */

import { COMMANDS } from "./commands.ts";
import { FRAME } from "./frame.ts";
import { KEYS } from "./keys.ts";
import { SETTINGS } from "./settings.ts";
import { STATUS } from "./status.ts";

export const EN = {
	frame: FRAME,
	keys: KEYS,
	commands: COMMANDS,
	settings: SETTINGS,
	status: STATUS,
};
