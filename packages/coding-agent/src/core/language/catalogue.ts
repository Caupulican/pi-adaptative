/**
 * The two catalogues, built from one list of areas: each area names its English file and its Brazilian Portuguese file
 * side by side, so an area cannot exist in one language and be missing from the other. The Portuguese catalogue is
 * typed as the English one, so a missing entry, an extra entry or a different argument list is a compile error rather
 * than a window that falls back to English.
 */

import type { InterfaceText } from "./interface-text.ts";
import { AGENTS_OVERLAY } from "./text-en/agents-overlay.ts";
import { AUTO_LEARN } from "./text-en/auto-learn.ts";
import { AUTONOMY_COMMANDS } from "./text-en/autonomy-commands.ts";
import { CHAT } from "./text-en/chat.ts";
import { COMMAND_CONTROLLER } from "./text-en/command-controller.ts";
import { COMMANDS } from "./text-en/commands.ts";
import { COMMON } from "./text-en/common.ts";
import { CONFIG_SCREEN } from "./text-en/config-screen.ts";
import { CONVERSATION } from "./text-en/conversation.ts";
import { DIALOGS } from "./text-en/dialogs.ts";
import { FRAME } from "./text-en/frame.ts";
import { GRAPH } from "./text-en/graph.ts";
import { INSPECTOR } from "./text-en/inspector.ts";
import { INTERACTIVE } from "./text-en/interactive.ts";
import { KEYS } from "./text-en/keys.ts";
import { KNOWLEDGE_COMMANDS } from "./text-en/knowledge-commands.ts";
import { LOCAL_MODELS } from "./text-en/local-models.ts";
import { MACHINES } from "./text-en/machines.ts";
import { NOTICES } from "./text-en/notices.ts";
import { PANES } from "./text-en/panes.ts";
import { PROFILES_SCREEN } from "./text-en/profiles-screen.ts";
import { QUEUE } from "./text-en/queue.ts";
import { REPORTS } from "./text-en/reports.ts";
import { RESOURCES } from "./text-en/resources.ts";
import { SECRETS_SCREEN } from "./text-en/secrets-screen.ts";
import { SELECTORS } from "./text-en/selectors.ts";
import { SESSIONS } from "./text-en/sessions.ts";
import { SETTINGS } from "./text-en/settings.ts";
import { SETTINGS_SCREEN } from "./text-en/settings-screen.ts";
import { SMALL_COMMANDS } from "./text-en/small-commands.ts";
import { STATUS } from "./text-en/status.ts";
import { AGENTS_OVERLAY as AGENTS_OVERLAY_PT_BR } from "./text-pt-br/agents-overlay.ts";
import { AUTO_LEARN as AUTO_LEARN_PT_BR } from "./text-pt-br/auto-learn.ts";
import { AUTONOMY_COMMANDS as AUTONOMY_COMMANDS_PT_BR } from "./text-pt-br/autonomy-commands.ts";
import { CHAT as CHAT_PT_BR } from "./text-pt-br/chat.ts";
import { COMMAND_CONTROLLER as COMMAND_CONTROLLER_PT_BR } from "./text-pt-br/command-controller.ts";
import { COMMANDS as COMMANDS_PT_BR } from "./text-pt-br/commands.ts";
import { COMMON as COMMON_PT_BR } from "./text-pt-br/common.ts";
import { CONFIG_SCREEN as CONFIG_SCREEN_PT_BR } from "./text-pt-br/config-screen.ts";
import { CONVERSATION as CONVERSATION_PT_BR } from "./text-pt-br/conversation.ts";
import { DIALOGS as DIALOGS_PT_BR } from "./text-pt-br/dialogs.ts";
import { FRAME as FRAME_PT_BR } from "./text-pt-br/frame.ts";
import { GRAPH as GRAPH_PT_BR } from "./text-pt-br/graph.ts";
import { INSPECTOR as INSPECTOR_PT_BR } from "./text-pt-br/inspector.ts";
import { INTERACTIVE as INTERACTIVE_PT_BR } from "./text-pt-br/interactive.ts";
import { KEYS as KEYS_PT_BR } from "./text-pt-br/keys.ts";
import { KNOWLEDGE_COMMANDS as KNOWLEDGE_COMMANDS_PT_BR } from "./text-pt-br/knowledge-commands.ts";
import { LOCAL_MODELS as LOCAL_MODELS_PT_BR } from "./text-pt-br/local-models.ts";
import { MACHINES as MACHINES_PT_BR } from "./text-pt-br/machines.ts";
import { NOTICES as NOTICES_PT_BR } from "./text-pt-br/notices.ts";
import { PANES as PANES_PT_BR } from "./text-pt-br/panes.ts";
import { PROFILES_SCREEN as PROFILES_SCREEN_PT_BR } from "./text-pt-br/profiles-screen.ts";
import { QUEUE as QUEUE_PT_BR } from "./text-pt-br/queue.ts";
import { REPORTS as REPORTS_PT_BR } from "./text-pt-br/reports.ts";
import { RESOURCES as RESOURCES_PT_BR } from "./text-pt-br/resources.ts";
import { SECRETS_SCREEN as SECRETS_SCREEN_PT_BR } from "./text-pt-br/secrets-screen.ts";
import { SELECTORS as SELECTORS_PT_BR } from "./text-pt-br/selectors.ts";
import { SESSIONS as SESSIONS_PT_BR } from "./text-pt-br/sessions.ts";
import { SETTINGS as SETTINGS_PT_BR } from "./text-pt-br/settings.ts";
import { SETTINGS_SCREEN as SETTINGS_SCREEN_PT_BR } from "./text-pt-br/settings-screen.ts";
import { SMALL_COMMANDS as SMALL_COMMANDS_PT_BR } from "./text-pt-br/small-commands.ts";
import { STATUS as STATUS_PT_BR } from "./text-pt-br/status.ts";

/** Every area of the interface this build translates, its two languages in this order: English, then Portuguese. */
const AREAS = {
	agentsOverlay: [AGENTS_OVERLAY, AGENTS_OVERLAY_PT_BR],
	autoLearn: [AUTO_LEARN, AUTO_LEARN_PT_BR],
	autonomyCommands: [AUTONOMY_COMMANDS, AUTONOMY_COMMANDS_PT_BR],
	chat: [CHAT, CHAT_PT_BR],
	commandController: [COMMAND_CONTROLLER, COMMAND_CONTROLLER_PT_BR],
	commands: [COMMANDS, COMMANDS_PT_BR],
	common: [COMMON, COMMON_PT_BR],
	configScreen: [CONFIG_SCREEN, CONFIG_SCREEN_PT_BR],
	conversation: [CONVERSATION, CONVERSATION_PT_BR],
	dialogs: [DIALOGS, DIALOGS_PT_BR],
	frame: [FRAME, FRAME_PT_BR],
	graph: [GRAPH, GRAPH_PT_BR],
	inspector: [INSPECTOR, INSPECTOR_PT_BR],
	interactive: [INTERACTIVE, INTERACTIVE_PT_BR],
	keys: [KEYS, KEYS_PT_BR],
	knowledgeCommands: [KNOWLEDGE_COMMANDS, KNOWLEDGE_COMMANDS_PT_BR],
	localModels: [LOCAL_MODELS, LOCAL_MODELS_PT_BR],
	machines: [MACHINES, MACHINES_PT_BR],
	notices: [NOTICES, NOTICES_PT_BR],
	panes: [PANES, PANES_PT_BR],
	profilesScreen: [PROFILES_SCREEN, PROFILES_SCREEN_PT_BR],
	queue: [QUEUE, QUEUE_PT_BR],
	reports: [REPORTS, REPORTS_PT_BR],
	resources: [RESOURCES, RESOURCES_PT_BR],
	secretsScreen: [SECRETS_SCREEN, SECRETS_SCREEN_PT_BR],
	selectors: [SELECTORS, SELECTORS_PT_BR],
	sessions: [SESSIONS, SESSIONS_PT_BR],
	settings: [SETTINGS, SETTINGS_PT_BR],
	settingsScreen: [SETTINGS_SCREEN, SETTINGS_SCREEN_PT_BR],
	smallCommands: [SMALL_COMMANDS, SMALL_COMMANDS_PT_BR],
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
