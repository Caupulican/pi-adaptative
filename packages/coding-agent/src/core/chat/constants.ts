import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_EXTENSION_NAME = "pi-chat";
export const CHAT_CUSTOM_MESSAGE_TYPE = "pi-chat";
export const CHAT_STATE_ROOT_ENV = "PI_CHAT_STATE_ROOT";
export const CHAT_AGENT_NAME_ENV = "PI_CHAT_AGENT_NAME";
export const CHAT_CONFIG_VERSION = 1;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_METADATA_BYTES = 16 * 1024;
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_SOCKET_BUFFER_BYTES = MAX_ENVELOPE_BYTES * 4;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
export const RECONNECT_INTERVAL_MS = 5_000;
export const MAX_PENDING_VISIBLE_CARDS = 50;

/** The user-global state root shared with every agent that joins the same mesh socket. */
export function defaultChatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CHAT_STATE_ROOT_ENV]?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "pi-chat");
}
