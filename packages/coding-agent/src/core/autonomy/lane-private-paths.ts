import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	AGENT_ROOT_DIRECTORY_NAMES,
	AGENT_ROOT_FILE_NAMES,
	channelsDir,
	configFile,
	getWorkRoot,
	okfMemoryDir,
	projectMemoryRoot,
	sessionsDir,
	stateDir,
} from "../agent-paths.ts";
import { getMachineCredentialBootstrapFiles } from "../secrets/credential-machine-session.ts";
import type { ProtectedWritePaths } from "./edge-policy.ts";

/** The project's own harness settings file: denied to a lane's file tools, but a file of the project, not harness storage. */
export function projectLaneSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

/**
 * The machine's standard credential stores, in their default locations on every platform: SSH and GPG keys, cloud
 * and cluster credentials, package-registry and git tokens, and the OS keychains. A lane never reads them; git, ssh and
 * the cloud clients a write worker runs still read them themselves (the boundary judges a command's own arguments).
 */
export function machineCredentialStorePaths(home: string = homedir()): string[] {
	return [
		path.join(home, ".ssh"),
		path.join(home, ".gnupg"),
		path.join(home, ".aws"),
		path.join(home, ".azure"),
		path.join(home, ".config", "gcloud"),
		path.join(home, ".kube"),
		path.join(home, ".docker"),
		path.join(home, ".netrc"),
		path.join(home, "_netrc"),
		path.join(home, ".npmrc"),
		path.join(home, ".git-credentials"),
		path.join(home, ".config", "git", "credentials"),
		path.join(home, ".config", "gh"),
		path.join(home, "Library", "Keychains"),
		path.join(home, ".local", "share", "keyrings"),
		path.join(home, "AppData", "Roaming", "Microsoft", "Credentials"),
		path.join(home, "AppData", "Local", "Microsoft", "Credentials"),
		path.join(home, "AppData", "Roaming", "Microsoft", "Protect"),
		path.join(home, "AppData", "Roaming", "GitHub CLI"),
	];
}

/**
 * Everything a lane (worker, research, managed or proactivity read authority) must never read: the harness's own
 * private storage, the owner's secret-manager bootstrap files and the machine's credential stores.
 */
export function getPrivateLaneDeniedPaths(cwd: string, agentDir: string): string[] {
	return [
		...machineCredentialStorePaths(),
		...getMachineCredentialBootstrapFiles(agentDir),
		configFile(agentDir, "auth.json"),
		configFile(agentDir, "MEMORY.md"),
		configFile(agentDir, "USER.md"),
		projectMemoryRoot(agentDir),
		okfMemoryDir(agentDir),
		configFile(agentDir, "settings.json"),
		configFile(agentDir, "models.json"),
		// Channel tokens and journals (the senders' words and the drafts answered to them).
		channelsDir(agentDir),
		sessionsDir(agentDir),
		stateDir(agentDir),
		getWorkRoot(agentDir),
		projectLaneSettingsPath(cwd),
	];
}

/** Nearest enclosing repository of `cwd`: its root plus the worktree git dir and the shared common git dir. */
function findRepositoryGitPaths(cwd: string): { root: string; gitDirs: string[] } | undefined {
	let dir = path.resolve(cwd);
	while (true) {
		const marker = path.join(dir, ".git");
		if (existsSync(marker)) {
			try {
				if (statSync(marker).isDirectory()) return { root: dir, gitDirs: [marker] };
				const pointer = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/im)?.[1];
				if (!pointer) return { root: dir, gitDirs: [] };
				const gitDir = path.resolve(dir, pointer);
				const commonFile = path.join(gitDir, "commondir");
				const commonDir = existsSync(commonFile)
					? path.resolve(gitDir, readFileSync(commonFile, "utf8").trim())
					: gitDir;
				return { root: dir, gitDirs: [...new Set([gitDir, commonDir])] };
			} catch {
				return { root: dir, gitDirs: [] };
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Harness resources a worker session may READ but never WRITE: every canonical agent-root entry
 * (derived from the single owner in agent-paths.ts, so a new root entry is protected the moment it
 * is declared) except `worktrees/`, where lane workers' working directories live, plus the
 * project files that execute or configure the harness or git on the next run. Write-only on purpose:
 * skills stay readable, and the lists the read boundary uses (private lane denials) are untouched.
 */
export function getHarnessWriteProtectedPaths(cwd: string, agentDir: string): string[] {
	const protectedPaths = [
		...AGENT_ROOT_FILE_NAMES.map((name) => configFile(agentDir, name)),
		...AGENT_ROOT_DIRECTORY_NAMES.filter((name) => name !== "worktrees").map((name) => path.join(agentDir, name)),
		path.join(cwd, ".pi", "extensions"),
		path.join(cwd, ".pi", "SYSTEM.md"),
		path.join(cwd, ".pi", "APPEND_SYSTEM.md"),
	];
	const repository = findRepositoryGitPaths(cwd);
	if (repository) {
		protectedPaths.push(path.join(repository.root, ".husky"));
		for (const gitDir of repository.gitDirs) {
			protectedPaths.push(path.join(gitDir, "config"), path.join(gitDir, "hooks"));
		}
	}
	return protectedPaths;
}

/**
 * What a run carrying a third party's words (or opened from an owner channel) writes only under a grant (the harness
 * write-protected set, plus the project's settings file, whose `edge` keys the merged settings read) or never (the
 * session store: the agent's sessions directory, the session's own directory and the directory of its file), for the
 * session gate and the worker gate alike.
 */
export function thirdPartyProtectedWritePaths(
	cwd: string,
	agentDir: string,
	session: { getSessionDir(): string; getSessionFile(): string | undefined },
): ProtectedWritePaths {
	const sessionFile = session.getSessionFile();
	return {
		harness: [...getHarnessWriteProtectedPaths(cwd, agentDir), projectLaneSettingsPath(cwd)],
		sessions: [sessionsDir(agentDir), session.getSessionDir(), ...(sessionFile ? [path.dirname(sessionFile)] : [])],
	};
}
