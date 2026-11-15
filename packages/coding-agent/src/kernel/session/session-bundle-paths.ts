import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { stateDir, stateFile } from "../storage/paths.ts";
import { requireBoundedTrimmedText } from "../utils/bounded-value.ts";

const orchestrationHomeBrand: unique symbol = Symbol("orchestration-home");

/**
 * The directory that holds the orchestration state of the sessions rooted in it: one bundle per
 * session under `sessions/`, and the deletion tombstones and lifetime leases under `deletions/`.
 * Every bundle path is built from a home, never from an agentDir, so the place a session's bundle
 * lives is decided once, where the session is composed. Only the constructors below make one.
 */
export interface OrchestrationHome {
	readonly root: string;
	/**
	 * Where the per-session state its sessions keep outside their bundles lives (the fleet's queue metadata): the owner's
	 * `<agentDir>/state`, and a bot's home orchestration directory itself.
	 */
	readonly stateDir: string;
	/**
	 * The home this state belongs to, where its sessions' agent definitions and instruction files live: the owner's agent
	 * directory, and a bot's home directory.
	 */
	readonly homeDir: string;
	readonly [orchestrationHomeBrand]: true;
}

function orchestrationHomeAt(root: string, stateDir: string, homeDir: string): OrchestrationHome {
	return Object.freeze({ root, stateDir, homeDir, [orchestrationHomeBrand]: true as const });
}

/** `<agentDir>/state/orchestration` -- the owner's orchestration home. */
export function ownerOrchestrationHome(agentDir: string): OrchestrationHome {
	return orchestrationHomeAt(stateFile(agentDir, "orchestration"), stateDir(agentDir), agentDir);
}

/** `<botHomeDir>/orchestration` -- the orchestration home of the bot whose home is `botHomeDir` (core/bots/bot-home.ts). */
export function botHomeOrchestrationHome(botHomeDir: string): OrchestrationHome {
	const root = join(botHomeDir, "orchestration");
	return orchestrationHomeAt(root, root, botHomeDir);
}

/** The same home with absolute paths, for state compared or recorded across working directories. */
export function resolvedOrchestrationHome(home: OrchestrationHome): OrchestrationHome {
	return orchestrationHomeAt(resolve(home.root), resolve(home.stateDir), resolve(home.homeDir));
}

/** Whether two homes are one directory, however their paths were spelled. */
export function sameOrchestrationHome(a: OrchestrationHome, b: OrchestrationHome): boolean {
	return resolve(a.root) === resolve(b.root);
}

/** Where a session's durable state lives: the agent directory and the orchestration home that holds its bundle. */
export interface SessionStorageRoots {
	readonly agentDir: string;
	readonly orchestrationHome: OrchestrationHome;
}

/** The roots of a session of the owner's home. */
export function ownerSessionStorageRoots(agentDir: string): SessionStorageRoots {
	return { agentDir, orchestrationHome: ownerOrchestrationHome(agentDir) };
}

function orchestrationSessionKey(parentSessionId: string): string {
	const normalized = requireBoundedTrimmedText(parentSessionId, 512, "Parent session id");
	const readable =
		encodeURIComponent(normalized)
			.replaceAll("%", "_")
			// encodeURIComponent deliberately leaves `*` unescaped, but Windows forbids it in paths.
			// Restrict the readable prefix to a portable ASCII subset; the digest retains exact identity.
			.replaceAll(/[^a-zA-Z0-9._~-]/g, "_")
			.slice(0, 80) || "session";
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return `${readable}-${digest}`;
}

/**
 * `<home>/sessions` -- the durable control-plane bundles of the sessions rooted in `home`. Event
 * state, worker mailboxes, mutation journals, and worker transcripts must stay beneath a session's
 * bundle so explicit session deletion can remove exactly its companion artifacts without scanning
 * global state.
 */
export function orchestrationSessionsDir(home: OrchestrationHome): string {
	return join(home.root, "sessions");
}

/**
 * `<home>/sessions/<session-key>` -- the one durable control-plane bundle owned by a foreground
 * session.
 */
export function orchestrationSessionDir(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionsDir(home), orchestrationSessionKey(parentSessionId));
}

/**
 * `<home>/deletions/<session-key>.json` -- outside the deleted bundle: a durable tombstone prevents
 * recreating deleted worker contexts.
 */
export function orchestrationSessionDeletionFile(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionDeletionsDir(home), `${orchestrationSessionKey(parentSessionId)}.json`);
}

/** `<home>/deletions` -- the home's session tombstones (`<session-key>.json`) and their lease registries. */
export function orchestrationSessionDeletionsDir(home: OrchestrationHome): string {
	return join(home.root, "deletions");
}

/** The session key whose tombstone file is named `name` in {@link orchestrationSessionDeletionsDir}; undefined for any other file. */
export function sessionKeyOfDeletionFile(name: string): string | undefined {
	if (!name.endsWith(".json") || name.endsWith(".leases.json")) return undefined;
	return name.slice(0, -".json".length);
}

/**
 * `<orchestrationSessionDir>/worker-conversations` -- durable Pi worker transcripts owned by one
 * foreground session. Worker conversations remain in SessionManager's established JSONL format,
 * but are intentionally outside the foreground session picker namespace.
 */
export function workerConversationSessionsDir(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionDir(home, parentSessionId), "worker-conversations");
}
