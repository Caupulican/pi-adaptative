/**
 * The two catalogues, built from one list of areas: each area names its English file and its Brazilian Portuguese file
 * side by side, so an area cannot exist in one language and be missing from the other. The Portuguese catalogue is
 * typed as the English one, so a missing entry, an extra entry or a different argument list is a compile error rather
 * than a window that falls back to English.
 */

import type { InterfaceText } from "./interface-text.ts";
import { CHAT } from "./text-en/chat.ts";
import { COMMANDS } from "./text-en/commands.ts";
import { COMMON } from "./text-en/common.ts";
import { FRAME } from "./text-en/frame.ts";
import { GRAPH } from "./text-en/graph.ts";
import { INSPECTOR } from "./text-en/inspector.ts";
import { KEYS } from "./text-en/keys.ts";
import { PANES } from "./text-en/panes.ts";
import { SETTINGS } from "./text-en/settings.ts";
import { STATUS } from "./text-en/status.ts";
import { CHAT as CHAT_PT_BR } from "./text-pt-br/chat.ts";
import { COMMANDS as COMMANDS_PT_BR } from "./text-pt-br/commands.ts";
import { COMMON as COMMON_PT_BR } from "./text-pt-br/common.ts";
import { FRAME as FRAME_PT_BR } from "./text-pt-br/frame.ts";
import { GRAPH as GRAPH_PT_BR } from "./text-pt-br/graph.ts";
import { INSPECTOR as INSPECTOR_PT_BR } from "./text-pt-br/inspector.ts";
import { KEYS as KEYS_PT_BR } from "./text-pt-br/keys.ts";
import { PANES as PANES_PT_BR } from "./text-pt-br/panes.ts";
import { SETTINGS as SETTINGS_PT_BR } from "./text-pt-br/settings.ts";
import { STATUS as STATUS_PT_BR } from "./text-pt-br/status.ts";

/** Every area of the interface this build translates, its two languages in this order: English, then Portuguese. */
const AREAS = {
	chat: [CHAT, CHAT_PT_BR],
	commands: [COMMANDS, COMMANDS_PT_BR],
	common: [COMMON, COMMON_PT_BR],
	frame: [FRAME, FRAME_PT_BR],
	graph: [GRAPH, GRAPH_PT_BR],
	inspector: [INSPECTOR, INSPECTOR_PT_BR],
	keys: [KEYS, KEYS_PT_BR],
	panes: [PANES, PANES_PT_BR],
	settings: [SETTINGS, SETTINGS_PT_BR],
	status: [STATUS, STATUS_PT_BR],
} as const;

/** One language's catalogue, area by area. */
type Catalogue<Side extends 0 | 1> = { [Area in keyof typeof AREAS]: (typeof AREAS)[Area][Side] };

function catalogue<Side extends 0 | 1>(side: Side): Catalogue<Side> {
	const areas: Record<string, unknown> = {};
	for (const [name, pair] of Object.entries(AREAS)) areas[name] = pair[side];
	return areas as Catalogue<Side>;
}

export const EN: InterfaceText = catalogue(0);

/** The Portuguese catalogue: the same areas, the same entries, the same arguments. */
export const PT_BR: InterfaceText = catalogue(1);
