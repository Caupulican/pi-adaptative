import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";
import { spawnSync } from "child_process";
import { getBinDir } from "../config.ts";
import { ensureManagedJscpd } from "./bundled-jscpd.ts";
import { normalizePath } from "./paths.ts";
import {
	createPowerShellHostEnvironment,
	POWERSHELL_7_GUARD,
	POWERSHELL_ARGS,
	POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
} from "./powershell-session-protocol.ts";

export { POWERSHELL_STARTUP_PROBE_TIMEOUT_MS } from "./powershell-session-protocol.ts";

export type PlatformShellToolName = "bash" | "powershell";

export interface ShellConfig {
	shell: string;
	args: string[];
}

export function getPlatformShellToolName(platform: NodeJS.Platform = process.platform): PlatformShellToolName {
	return platform === "win32" ? "powershell" : "bash";
}

function findExecutableOnPath(executable: string): string | null {
	const locator = process.platform === "win32" ? "where" : "which";
	try {
		const result = spawnSync(locator, [executable], {
			encoding: "utf-8",
			timeout: 5_000,
			windowsHide: true,
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch && (process.platform !== "win32" || existsSync(firstMatch))) return firstMatch;
		}
	} catch {
		// Resolution falls through to known paths or the platform fallback.
	}
	return null;
}

function isPowerShellExecutableAvailable(executable: string): boolean {
	try {
		return (
			spawnSync(executable, [...POWERSHELL_ARGS, `${POWERSHELL_7_GUARD}Write-Output ok`], {
				encoding: "utf-8",
				env: createPowerShellHostEnvironment(process.env),
				timeout: POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
				windowsHide: true,
			}).status === 0
		);
	} catch {
		return false;
	}
}

function isPowerShell7Executable(executable: string): boolean {
	return /^pwsh(?:\.exe)?$/iu.test(basename(executable));
}

/**
 * Ordered PowerShell candidates without launching a disposable interpreter. Persistent sessions
 * validate these candidates with their real long-lived bootstrap, so the normal path pays for one
 * PowerShell process instead of probing one process and then spawning another.
 */
export function getPowerShellCandidateConfigs(): ShellConfig[] {
	const candidates: ShellConfig[] = [];
	const seen = new Set<string>();
	const addCandidate = (shell: string | null): void => {
		if (!shell || !isPowerShell7Executable(shell)) return;
		const identity = process.platform === "win32" ? shell.toLowerCase() : shell;
		if (seen.has(identity)) return;
		seen.add(identity);
		candidates.push({ shell, args: [...POWERSHELL_ARGS] });
	};

	const pwshOnPath = findExecutableOnPath(process.platform === "win32" ? "pwsh.exe" : "pwsh");
	addCandidate(pwshOnPath);

	const knownPaths: string[] = [];
	const programFiles = process.env.ProgramFiles;
	if (programFiles) knownPaths.push(`${programFiles}\\PowerShell\\7\\pwsh.exe`);
	for (const path of knownPaths) {
		if (existsSync(path)) addCandidate(path);
	}
	return candidates;
}

function getPowerShellConfig(): ShellConfig {
	for (const candidate of getPowerShellCandidateConfigs()) {
		if (isPowerShellExecutableAvailable(candidate.shell)) return candidate;
	}
	throw new Error("PowerShell 7 (pwsh) was not found. Install pwsh or set shellPath to a pwsh executable.");
}

function getBashConfig(): ShellConfig {
	if (process.platform === "win32") {
		const knownPaths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) knownPaths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) knownPaths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const path of knownPaths) {
			if (existsSync(path)) return { shell: path, args: ["-c"] };
		}
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
		throw new Error("No Bash executable found. Install Git Bash or set shellPath in settings.json.");
	}
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	const bashOnPath = findExecutableOnPath("bash");
	return bashOnPath ? { shell: bashOnPath, args: ["-c"] } : { shell: "sh", args: ["-c"] };
}

// Platform shell resolution spawns probe processes (`where`/`which`, plus a full PowerShell
// boot on Windows) and is a process-lifetime invariant, so successful resolutions are cached.
// Failures are not cached: the user can install a shell and retry without restarting.
const resolvedPlatformShellConfigs = new Map<PlatformShellToolName, ShellConfig>();
let managedJscpdProvisionAttempted = false;

/** Resolve the requested shell. Runtime callers omit shellName to select PowerShell on Windows and Bash elsewhere. */
export function getShellConfig(
	customShellPath?: string,
	shellName: PlatformShellToolName = getPlatformShellToolName(),
): ShellConfig {
	if (customShellPath) {
		const resolvedShellPath = normalizePath(customShellPath);
		if (shellName === "powershell" && !isPowerShell7Executable(resolvedShellPath)) {
			throw new Error(`Custom PowerShell host must be PowerShell 7 (pwsh): ${resolvedShellPath}`);
		}
		if (!existsSync(resolvedShellPath)) throw new Error(`Custom shell path not found: ${resolvedShellPath}`);
		return {
			shell: resolvedShellPath,
			args: shellName === "powershell" ? [...POWERSHELL_ARGS] : ["-c"],
		};
	}
	let resolved = resolvedPlatformShellConfigs.get(shellName);
	if (!resolved) {
		resolved = shellName === "powershell" ? getPowerShellConfig() : getBashConfig();
		resolvedPlatformShellConfigs.set(shellName, resolved);
	}
	return { shell: resolved.shell, args: [...resolved.args] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	if (!managedJscpdProvisionAttempted) {
		managedJscpdProvisionAttempted = true;
		try {
			ensureManagedJscpd();
		} catch {
			// The jscpd wrapper and doctor surface the exact packaging failure. Shell startup stays usable.
		}
	}
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform).
 *
 * Windows dispatches tree kill via synchronous `taskkill /F /T /PID <pid>`. Callers awaiting
 * full directory/handle release must still synchronize on the child process's terminal `close`
 * event to ensure Node and OS handles have completed teardown before directory removal.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree synchronously.
		try {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
