import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, getBinDir, getPackageDependencyVersion } from "../config.ts";
import { hostTransitionsFile } from "../core/agent-paths.ts";
import { publishHostFile } from "./host-tree-publication.ts";

export const JSCPD_VERSION = getPackageDependencyVersion("jscpd");

type ModuleRequire = ((id: string) => unknown) & { resolve?(id: string): string };

export interface BundledJscpdSource {
	sourcePath: string;
	sourceVersion: string;
}

export interface InstallBundledJscpdBinaryOptions extends BundledJscpdSource {
	managedBinDir: string;
	targetPlatform: string;
	probeVersion?: (path: string) => string | undefined;
}

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
let cachedManagedPath: { path: string; mtimeMs: number } | undefined;

export function resolveJscpdPlatformPackage(
	targetPlatform: string,
	targetArchitecture: string,
	libc: "glibc" | "musl" = "glibc",
): string | undefined {
	if (targetPlatform === "darwin" && (targetArchitecture === "arm64" || targetArchitecture === "x64")) {
		return `jscpd-darwin-${targetArchitecture}`;
	}
	if (targetPlatform === "linux" && targetArchitecture === "x64") {
		return libc === "musl" ? "jscpd-linux-x64-musl" : "jscpd-linux-x64-gnu";
	}
	if (targetPlatform === "linux" && targetArchitecture === "arm64" && libc === "glibc") {
		return "jscpd-linux-arm64-gnu";
	}
	if (targetPlatform === "win32" && (targetArchitecture === "arm64" || targetArchitecture === "x64")) {
		// Upstream publishes x64 only. Windows on Arm supports x64 application emulation.
		return "jscpd-windows-x64-msvc";
	}
	return undefined;
}

function detectRuntimeLibc(): "glibc" | "musl" {
	if (platform() !== "linux") return "glibc";
	const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function binaryName(targetPlatform: string): string {
	return targetPlatform === "win32" ? "jscpd.exe" : "jscpd";
}

function readSourceFromPackage(
	packageName: string,
	requires: readonly ModuleRequire[],
): BundledJscpdSource | undefined {
	for (const requireFrom of requires) {
		try {
			const packageJsonPath = requireFrom.resolve?.(`${packageName}/package.json`);
			if (!packageJsonPath) continue;
			const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
			const sourcePath = join(dirname(packageJsonPath), "bin", binaryName(platform()));
			if (typeof manifest.version === "string" && existsSync(sourcePath)) {
				return { sourcePath, sourceVersion: manifest.version };
			}
		} catch {
			// Try the next package-resolution root.
		}
	}
	return undefined;
}

export function resolveBundledJscpdSource(
	targetPlatform: string = platform(),
	targetArchitecture: string = arch(),
	requires: readonly ModuleRequire[] = [moduleRequire, executableDirRequire],
): BundledJscpdSource | undefined {
	const standaloneBinary = join(dirname(process.execPath), "bundled-tools", binaryName(targetPlatform));
	const standaloneVersion = join(dirname(process.execPath), "bundled-tools", "jscpd.version");
	if (targetPlatform === platform() && existsSync(standaloneBinary) && existsSync(standaloneVersion)) {
		return {
			sourcePath: standaloneBinary,
			sourceVersion: readFileSync(standaloneVersion, "utf8").trim(),
		};
	}
	const packageName = resolveJscpdPlatformPackage(targetPlatform, targetArchitecture, detectRuntimeLibc());
	return packageName ? readSourceFromPackage(packageName, requires) : undefined;
}

export function probeJscpdVersion(path: string): string | undefined {
	try {
		const result = spawnSync(path, ["--version"], {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 5_000,
			windowsHide: true,
		});
		if (result.error || result.status !== 0) return undefined;
		return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || undefined;
	} catch {
		return undefined;
	}
}

function isExactVersion(output: string | undefined): boolean {
	return output?.split(/\s+/).includes(JSCPD_VERSION) === true;
}

export function installBundledJscpdBinary(options: InstallBundledJscpdBinaryOptions): string {
	if (options.sourceVersion !== JSCPD_VERSION) {
		throw new Error(`Pi requires bundled jscpd ${JSCPD_VERSION}; found ${options.sourceVersion || "unknown"}.`);
	}
	const targetPath = join(options.managedBinDir, binaryName(options.targetPlatform));
	const agentDir = getAgentDir();
	const stagingRoot = join(agentDir, "npm");
	mkdirSync(stagingRoot, { recursive: true });
	const temporaryDir = mkdtempSync(join(stagingRoot, "jscpd-stage-"));
	const temporaryPath = join(temporaryDir, binaryName(options.targetPlatform));
	const probeVersion = options.probeVersion ?? probeJscpdVersion;
	try {
		copyFileSync(options.sourcePath, temporaryPath);
		if (options.targetPlatform !== "win32") chmodSync(temporaryPath, 0o755);
		const version = probeVersion(temporaryPath);
		if (!isExactVersion(version)) {
			throw new Error(
				`Pi requires bundled jscpd ${JSCPD_VERSION}; installed binary reported ${version ?? "no version"}.`,
			);
		}
		const publication = publishHostFile(
			temporaryPath,
			targetPath,
			join(agentDir, "npm"),
			hostTransitionsFile(agentDir),
			{ replaceExisting: true },
		);
		if (publication.status === "failed") throw new Error(publication.reason);
		if (!publication.attributed) throw new Error("Published bundled jscpd could not be attributed.");
		return targetPath;
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

export function ensureManagedJscpd(managedBinDir: string = getBinDir()): string {
	const targetPath = join(managedBinDir, binaryName(platform()));
	if (cachedManagedPath?.path === targetPath) {
		try {
			if (statSync(cachedManagedPath.path).mtimeMs === cachedManagedPath.mtimeMs) return cachedManagedPath.path;
		} catch {
			cachedManagedPath = undefined;
		}
	}
	if (existsSync(targetPath) && isExactVersion(probeJscpdVersion(targetPath))) {
		cachedManagedPath = { path: targetPath, mtimeMs: statSync(targetPath).mtimeMs };
		return targetPath;
	}
	const source = resolveBundledJscpdSource();
	if (!source) {
		throw new Error(
			`Bundled jscpd ${JSCPD_VERSION} is unavailable for ${platform()}/${arch()}. Reinstall Pi for this platform.`,
		);
	}
	const installed = installBundledJscpdBinary({
		...source,
		managedBinDir,
		targetPlatform: platform(),
	});
	cachedManagedPath = { path: installed, mtimeMs: statSync(installed).mtimeMs };
	return installed;
}
