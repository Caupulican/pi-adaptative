import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { ensureToolWithDiagnostics } from "../../utils/tools-manager.ts";
import { isMissingFileError } from "../util/atomic-file.ts";

export interface HerdrProvisionResult {
	path: string;
	globalPath: boolean;
}

/** Install exposure never overwrites another executable or edits an unrelated shell profile. */
export async function exposeHerdrOnPath(
	executable: string,
	options: { path?: string; homeDir?: string; platform?: NodeJS.Platform } = {},
): Promise<HerdrProvisionResult> {
	const platform = options.platform ?? process.platform;
	const homeDir = await realpath(options.homeDir ?? homedir());
	const binaryName = platform === "win32" ? "herdr.exe" : "herdr";
	const source = await realpath(executable);
	if (platform === "win32" && /[%"\r\n]/.test(source))
		throw new Error("Herdr install path cannot be represented by a safe command launcher.");
	const windowsLauncher = `@echo off\r\n@setlocal DisableDelayedExpansion\r\n"${source}" %*\r\n@exit /b %errorlevel%\r\n`;
	const dirs = (options.path ?? process.env.PATH ?? "")
		.split(platform === "win32" ? ";" : delimiter)
		.filter((dir) => isAbsolute(dir));
	for (const dir of dirs) {
		const candidate = join(dir, binaryName);
		try {
			if ((await realpath(candidate)) === source) return { path: candidate, globalPath: true };
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		if (platform === "win32" && (await readFile(join(dir, "herdr.cmd"), "utf8").catch(() => "")) === windowsLauncher)
			return { path: executable, globalPath: true };
	}
	for (const dir of dirs) {
		let actual: string;
		try {
			actual = await realpath(dir);
			const scope = relative(homeDir, actual);
			if (!scope || scope.startsWith("..") || isAbsolute(scope)) continue;
			const info = await stat(actual);
			if (
				!info.isDirectory() ||
				(platform !== "win32" && ((info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())))
			)
				continue;
			await access(actual, constants.W_OK);
		} catch {
			continue;
		}
		const destination = join(actual, platform === "win32" ? "herdr.cmd" : binaryName);
		try {
			await lstat(destination);
			throw new Error(`Refusing to overwrite an existing Herdr command: ${destination}`);
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		try {
			if (platform === "win32") await writeFile(destination, windowsLauncher, { flag: "wx", mode: 0o700 });
			else await symlink(resolve(source), destination, "file");
		} catch (error) {
			// A concurrent installer is acceptable only if it published this same managed target.
			if ((await realpath(destination).catch(() => "")) !== source) throw error;
		}
		return { path: platform === "win32" ? executable : destination, globalPath: true };
	}
	return { path: executable, globalPath: false };
}

export async function provisionHerdr(options: { silent?: boolean } = {}): Promise<HerdrProvisionResult> {
	const resolution = await ensureToolWithDiagnostics("herdr", options.silent ?? true);
	if (resolution.status !== "available")
		throw new Error(`Herdr provisioning failed (${resolution.failureCode}): ${resolution.message}`);
	return exposeHerdrOnPath(resolution.path);
}

/** Optional installer/doctor projection; runtime callers retain the strict provisionHerdr boundary. */
export async function checkHerdrInstallation(
	options: { silent?: boolean } = {},
	provision: typeof provisionHerdr = provisionHerdr,
): Promise<{ present: boolean; detail: string }> {
	try {
		const result = await provision(options);
		return {
			present: true,
			detail: `${result.path} (${result.globalPath ? "on PATH" : "managed binary; not exposed on PATH"})`,
		};
	} catch (error) {
		return {
			present: false,
			detail: `${error instanceof Error ? error.message : String(error)}; collaboration unavailable; Pi remains usable`,
		};
	}
}

/** Narrow post-install entry: never creates a session, starts Herdr, or provisions unrelated tools. */
export async function runHerdrProvisionCommand(): Promise<void> {
	console.log("Checking Herdr (optional collaboration)...");
	const result = await checkHerdrInstallation({ silent: false });
	console.log(`[${result.present ? "OK" : "WARN"}] Herdr -- ${result.detail}`);
}
