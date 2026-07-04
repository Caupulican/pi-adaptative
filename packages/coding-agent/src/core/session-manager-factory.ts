import { getAgentDir, getSessionsDir } from "../config.ts";
import {
	type NewSessionOptions,
	type SessionInfo,
	type SessionListProgress,
	SessionManager,
} from "./session-manager.ts";

/**
 * Host-layer defaulting for SessionManager.
 *
 * SessionManager itself is config-agnostic: its constructor and statics take the agent/sessions
 * directories explicitly (the kernel-promotion seam). These thin wrappers are the single visible,
 * host-owned place that closes over the app's config-resolved `getAgentDir()` / `getSessionsDir()`
 * and delegates to the explicit kernel API. Call sites that already hold their own agent dir (e.g.
 * the SDK, the session runtime) should call `SessionManager` directly with that dir instead of these.
 */

export function createSession(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
	return SessionManager.create(cwd, getAgentDir(), sessionDir, options);
}

export function openSession(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
	return SessionManager.open(path, getAgentDir(), sessionDir, cwdOverride);
}

export function continueRecentSession(cwd: string, sessionDir?: string): SessionManager {
	return SessionManager.continueRecent(cwd, getAgentDir(), sessionDir);
}

export function forkSession(
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	options?: NewSessionOptions,
): SessionManager {
	return SessionManager.forkFrom(sourcePath, targetCwd, getAgentDir(), sessionDir, options);
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
