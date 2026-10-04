import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_EXTENSION_NAME = "pi-chat";
export const CHAT_CUSTOM_MESSAGE_TYPE = "pi-chat";
export const CHAT_STATE_ROOT_ENV = "PI_CHAT_STATE_ROOT";
export const CHAT_AGENT_NAME_ENV = "PI_CHAT_AGENT_NAME";
/** The broker-issued session credential and the id it is bound to, exported to pi's own child processes. */
export const CHAT_CREDENTIAL_ENV = "PI_CHAT_CREDENTIAL";
export const CHAT_SESSION_ID_ENV = "PI_CHAT_SESSION_ID";
export const CHAT_CONFIG_VERSION = 1;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_METADATA_BYTES = 16 * 1024;
/** Longest id, name or address a peer may announce. */
export const MAX_PEER_FIELD_CHARS = 256;
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_SOCKET_BUFFER_BYTES = MAX_ENVELOPE_BYTES * 4;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
export const RECONNECT_INTERVAL_MS = 5_000;
export const BROKER_PROBE_TIMEOUT_MS = 1_500;
/** A reply chain between two agents stops here: the next hop needs the owner. */
export const MAX_REPLY_HOPS = 8;
/** An inbound message only counts toward a reply chain while it is this fresh. */
export const REPLY_CHAIN_WINDOW_MS = 10 * 60_000;
export const MAX_PENDING_VISIBLE_CARDS = 50;
/** A sender-supplied stable message id: retries of one send carry it so the receiver delivers it once. */
export const MAX_MESSAGE_ID_CHARS = 128;
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
/** Messages a receiver remembers (per sender and id) to deliver a retried send once; oldest forgotten first. */
export const MAX_REMEMBERED_MESSAGES = 256;
/** Reply chains and issued credentials the broker remembers; oldest forgotten first. */
export const MAX_BROKER_CHAINS = 1024;
export const MAX_BROKER_CREDENTIALS = 1024;

/** The user-global state root shared with every agent that joins the same mesh socket. */
export function defaultChatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CHAT_STATE_ROOT_ENV]?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "pi-chat");
}
