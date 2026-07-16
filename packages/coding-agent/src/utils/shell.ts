import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export type PlatformShellToolName = "bash" | "powershell";

export interface ShellConfig {
	shell: string;
	args: string[];
}

export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];

export function getPlatformShellToolName(platform: NodeJS.Platform = process.platform): PlatformShellToolName {
	return platform === "win32" ? "powershell" : "bash";
}

export function prefixPowerShellCommand(command: string): string {
	return command.trimStart().startsWith(POWERSHELL_UTF8_PREFIX) ? command : `${POWERSHELL_UTF8_PREFIX}${command}`;
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
			spawnSync(executable, [...POWERSHELL_ARGS, "Write-Output ok"], {
				encoding: "utf-8",
				timeout: 5_000,
				windowsHide: true,
			}).status === 0
		);
	} catch {
		return false;
	}
}

function getPowerShellConfig(): ShellConfig {
	const pwshOnPath = findExecutableOnPath(process.platform === "win32" ? "pwsh.exe" : "pwsh");
	if (pwshOnPath && isPowerShellExecutableAvailable(pwshOnPath)) {
		return { shell: pwshOnPath, args: [...POWERSHELL_ARGS] };
	}

	const knownPaths: string[] = [];
	const programFiles = process.env.ProgramFiles;
	if (programFiles) knownPaths.push(`${programFiles}\\PowerShell\\7\\pwsh.exe`);
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) knownPaths.push(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
	for (const path of knownPaths) {
		if (existsSync(path) && isPowerShellExecutableAvailable(path)) {
			return { shell: path, args: [...POWERSHELL_ARGS] };
		}
	}

	const windowsPowerShellOnPath = findExecutableOnPath("powershell.exe");
	if (windowsPowerShellOnPath && isPowerShellExecutableAvailable(windowsPowerShellOnPath)) {
		return { shell: windowsPowerShellOnPath, args: [...POWERSHELL_ARGS] };
	}
	throw new Error(
		"No PowerShell executable found. Install PowerShell 7 (pwsh), restore Windows PowerShell, or set shellPath in settings.json.",
	);
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

/** Resolve the requested shell. Runtime callers omit shellName to select PowerShell on Windows and Bash elsewhere. */
export function getShellConfig(
	customShellPath?: string,
	shellName: PlatformShellToolName = getPlatformShellToolName(),
): ShellConfig {
	if (customShellPath) {
		if (!existsSync(customShellPath)) throw new Error(`Custom shell path not found: ${customShellPath}`);
		return {
			shell: customShellPath,
			args: shellName === "powershell" ? [...POWERSHELL_ARGS] : ["-c"],
		};
	}
	return shellName === "powershell" ? getPowerShellConfig() : getBashConfig();
}

export function getShellEnv(): NodeJS.ProcessEnv {
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
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
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
