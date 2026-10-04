import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	AGENT_ROOT_DIRECTORY_NAMES,
	AGENT_ROOT_FILE_NAMES,
	configFile,
	getWorkRoot,
	okfMemoryDir,
	projectMemoryRoot,
	sessionsDir,
	stateDir,
} from "../agent-paths.ts";

export function getPrivateLaneDeniedPaths(cwd: string, agentDir: string): string[] {
	return [
		configFile(agentDir, "auth.json"),
		configFile(agentDir, "MEMORY.md"),
		configFile(agentDir, "USER.md"),
		projectMemoryRoot(agentDir),
		okfMemoryDir(agentDir),
		configFile(agentDir, "settings.json"),
		configFile(agentDir, "models.json"),
		sessionsDir(agentDir),
		stateDir(agentDir),
		getWorkRoot(agentDir),
		path.join(cwd, ".pi", "settings.json"),
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
