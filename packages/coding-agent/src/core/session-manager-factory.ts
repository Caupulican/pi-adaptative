import { dirname, resolve } from "node:path";
import { getAgentDir, getSessionsDir } from "../config.ts";
import {
	ownerOrchestrationHome,
	ownerSessionStorageRoots,
	type SessionStorageRoots,
	sameOrchestrationHome,
} from "../kernel/session/session-bundle-paths.ts";
import {
	type NewSessionOptions,
	type SessionInfo,
	type SessionListProgress,
	SessionManager,
} from "../kernel/session/session-manager.ts";
import { botHomeAt } from "./bots/bot-home.ts";
import { continueBotSession } from "./bots/bot-session-open.ts";
import { sessionStorageRootsOfDir, sessionStorageRootsOfFile } from "./orchestration-homes.ts";

/**
 * Host-layer defaulting for SessionManager.
 *
 * SessionManager itself is config-agnostic: its constructor and statics take the storage roots and sessions
 * directory explicitly (the kernel-promotion seam). These thin wrappers are the single visible, host-owned place
 * that closes over the app's config-resolved `getAgentDir()` / `getSessionsDir()` and delegates to the explicit
 * kernel API. A session's roots follow where its file lies (`sessionStorageRootsOfDir`): one in a bot's
 * `sessions/` is that bot's, any other the owner's. Call sites that already hold their own roots (e.g. the SDK, the
 * session runtime) should call `SessionManager` directly with them instead of these.
 */

/** The roots of the sessions written to `sessionDir`; the default sessions directory is the owner's. */
function rootsOfDir(sessionDir: string | undefined): SessionStorageRoots {
	const agentDir = getAgentDir();
	return sessionDir ? sessionStorageRootsOfDir(agentDir, sessionDir) : ownerSessionStorageRoots(agentDir);
}

export function createSession(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
	return SessionManager.create(cwd, rootsOfDir(sessionDir), sessionDir, options);
}

export function openSession(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
	return SessionManager.open(path, sessionStorageRootsOfFile(getAgentDir(), path), sessionDir, cwdOverride);
}

/**
 * Continues the most recent session of `sessionDir`; in a bot's `sessions/`, the session the bot keeps its
 * conversation in, as its home's pointer records it (`continueBotSession`), never the newest file by time.
 */
export function continueRecentSession(cwd: string, sessionDir?: string): SessionManager {
	const roots = rootsOfDir(sessionDir);
	if (
		sessionDir !== undefined &&
		!sameOrchestrationHome(roots.orchestrationHome, ownerOrchestrationHome(roots.agentDir))
	)
		return continueBotSession(roots.agentDir, botHomeAt(dirname(resolve(sessionDir))), cwd);
	return SessionManager.continueRecent(cwd, roots, sessionDir);
}

/** A session that writes no file, in the owner's roots: the session of a run that saves nothing. */
export function inMemorySession(cwd: string): SessionManager {
	return SessionManager.inMemory(ownerSessionStorageRoots(getAgentDir()), cwd);
}

export function forkSession(
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	options?: NewSessionOptions,
): SessionManager {
	return SessionManager.forkFrom(sourcePath, targetCwd, rootsOfDir(sessionDir), sessionDir, options);
}

export function listSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	return SessionManager.list(cwd, getAgentDir(), sessionDir, onProgress);
}

export function listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
export function listAllSessions(customSessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
export function listAllSessions(
	customSessionDirOrOnProgress?: string | SessionListProgress,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const customSessionDir = typeof customSessionDirOrOnProgress === "string" ? customSessionDirOrOnProgress : undefined;
	const progress = typeof customSessionDirOrOnProgress === "function" ? customSessionDirOrOnProgress : onProgress;
	return SessionManager.listAll(getSessionsDir(), customSessionDir, progress);
}
