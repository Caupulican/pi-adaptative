/**
 * The default session directories of a working directory under `<agentDir>/sessions`: the current encoding of the
 * directory's path, then the legacy one when it differs. Computed without creating anything.
 */
import { join } from "node:path";
import { resolvePath } from "../utils/paths.ts";

/**
 * Compute the default session directory for a cwd without creating it.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/; persistence creates the
 * parent only when the first durable entry is written.
 */
function getEncodedSessionDirName(cwd: string): string {
	return `--${encodeURIComponent(resolvePath(cwd))}--`;
}

function getLegacySessionDirPath(cwd: string, agentDir: string): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

function getDefaultSessionDirPath(cwd: string, agentDir: string): string {
	const resolvedAgentDir = resolvePath(agentDir);
	return join(resolvedAgentDir, "sessions", getEncodedSessionDirName(cwd));
}

/** Current default session directory first, then the legacy-encoded one when it differs. */
export function getDefaultSessionDirCandidates(cwd: string, agentDir: string): string[] {
	const current = getDefaultSessionDirPath(cwd, agentDir);
	const legacy = getLegacySessionDirPath(cwd, agentDir);
	return current === legacy ? [current] : [current, legacy];
}

export function getDefaultSessionDir(cwd: string, agentDir: string): string {
	return getDefaultSessionDirPath(cwd, agentDir);
}
