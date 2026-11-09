/** Public record types of the session transcript: the header and entry file union, the context and tree views, session info, and persisted-entry events and listeners. */
import type { Message } from "@caupulican/pi-ai/types";
import type { CustomMessage } from "../messages.ts";
import type { AgentMessage, AgentMessageOrigin } from "../types.ts";
import type { SessionEntry } from "./session-entries.ts";
import type { SessionHeader } from "./session-header.ts";

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	/**
	 * The session's selected model: the latest `model_change` entry (session start, `/model`, a forced
	 * switch). Never the model that happened to answer last - a routed reply is written by the routed
	 * model, and a routed turn's model is the turn's, never the session's.
	 */
	model: { provider: string; modelId: string } | null;
}

/** One source-order item accepted by the atomic model-router/session append boundary. */
export type SessionMessageBatchEntry =
	| { kind: "message"; message: Message; origin?: AgentMessageOrigin }
	| { kind: "custom"; message: CustomMessage };

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

/**
 * A batch of entries that reached durable session storage. Emitted only after the physical write
 * returned; entries buffered before the first reply are announced together with the flush that
 * persisted them. `rewritten` marks a whole-file rewrite: earlier byte offsets are no longer valid.
 */
export interface SessionEntriesPersistedEvent {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly entryIds: readonly string[];
	readonly rewritten: boolean;
	/**
	 * Present only for an append whose entries each descend from the entry written just before it, the first from
	 * the entry that ended the file: the file's last-entry lineage grew at its leaf and nothing written earlier
	 * moved. `types` lists the entry type of each id in `entryIds`, in order.
	 */
	readonly leafAppend?: { readonly types: readonly SessionEntry["type"][] };
}

export type SessionEntriesPersistedListener = (event: SessionEntriesPersistedEvent) => void;

/** A persistence observer threw while a committed write was announced; the write stands and the observer is not retried. */
export type SessionObserverErrorListener = (observer: SessionEntriesPersistedListener, error: unknown) => void;
