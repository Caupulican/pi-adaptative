import { createHash } from "node:crypto";
import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import {
	accessSync,
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { arch, platform } from "os";
import { dirname, isAbsolute, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getAgentDir, getBinDir } from "../config.ts";
import { cacheDir as agentCacheDir, cacheFile, hostTransitionsFile } from "../core/agent-paths.ts";
import { ensureManagedJscpd, JSCPD_VERSION } from "./bundled-jscpd.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "./child-process.ts";
import { publishHostFile, publishHostTree } from "./host-tree-publication.ts";
import {
	MANAGED_TOOL_INSTALL_TIMEOUT_MS as ARCHIVE_EXTRACTION_TIMEOUT_MS,
	isOfflineModeEnabled,
} from "./managed-tool-policy.ts";
import { getProcessWorkRun } from "./work-directory.ts";
import { extractZipFile } from "./zip-extractor.ts";

/** Read per call: the agent directory can differ between callers in one process (tests, SDK hosts). */
function managedToolsDir(): string {
	return getBinDir();
}
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_PROBE_TIMEOUT_MS = 5_000;
export const BITWARDEN_CLI_VERSION = "2026.8.0";
export const BITWARDEN_SECRETS_MANAGER_CLI_VERSION = "2.1.0";
export const FD_VERSION = "10.5.0";
export const RG_VERSION = "15.2.0";
export const JQ_VERSION = "1.8.2";
export const UV_VERSION = "0.12.9";
export const HERDR_VERSION = "0.8.2";

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	verifyCachedCommand?: boolean; // Credential wrappers can outlive their external runtime target.
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
	downloadKind?: "archive" | "binary" | ((plat: string) => "archive" | "binary");
	installLayout?: (plat: string) => "binary" | "directory";
	pinnedVersion: string;
	sha256ByAsset?: Readonly<Record<string, string>>;
}

const TOOLS: Record<"bw" | "bws" | "fd" | "herdr" | "jq" | "jscpd" | "rg" | "uv", ToolConfig> = {
	herdr: {
		name: "Herdr",
		repo: "herdrdev/herdr",
		binaryName: "herdr",
		tagPrefix: "v",
		pinnedVersion: HERDR_VERSION,
		downloadKind: (plat) => (plat === "win32" ? "archive" : "binary"),
		installLayout: (plat) => (plat === "win32" ? "directory" : "binary"),
		getAssetName: (_version, plat, architecture) => {
			if (architecture !== "arm64" && architecture !== "x64") return null;
			if (plat === "win32") return architecture === "x64" ? "herdr-windows-x86_64.zip" : null;
			if (plat !== "linux" && plat !== "darwin") return null;
			return `herdr-${plat === "darwin" ? "macos" : "linux"}-${architecture === "arm64" ? "aarch64" : "x86_64"}`;
		},
		sha256ByAsset: {
			"herdr-linux-aarch64": "f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d",
			"herdr-linux-x86_64": "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4",
			"herdr-macos-aarch64": "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574",
			"herdr-macos-x86_64": "ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1",
			"herdr-windows-x86_64.zip": "0ab3d0fe1434d55757997542b978c771d642987bb15a7130f4160f0db38821d5",
		},
	},
	bw: {
		name: "Bitwarden CLI",
		verifyCachedCommand: true,
		repo: "bitwarden/clients",
		binaryName: "bw",
		systemBinaryNames: ["bw"],
		tagPrefix: "cli-v",
		pinnedVersion: BITWARDEN_CLI_VERSION,
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin" && architecture === "arm64") return `bw-macos-arm64-${version}.zip`;
			if (plat === "darwin" && architecture === "x64") return `bw-macos-${version}.zip`;
			if (plat === "linux" && architecture === "arm64") return `bw-linux-arm64-${version}.zip`;
			if (plat === "linux" && architecture === "x64") return `bw-linux-${version}.zip`;
			if (plat === "win32" && architecture === "x64") return `bw-windows-${version}.zip`;
			return null;
		},
		sha256ByAsset: {
			"bw-linux-2026.8.0.zip": "367f618e9fcccaac4980ec12c7bafd01df739b5f3cb1af31bc9045cf75eea1d6",
			"bw-linux-arm64-2026.8.0.zip": "74d822a5dceda5896ed8fc07bc61925b29afd98d96a6a3e9e525ae556c3083a8",
			"bw-macos-2026.8.0.zip": "c5d57f70d5394f8c348f6c3bf53683ad6d15e6acfe55e7c1e0a8f376482d8e71",
			"bw-macos-arm64-2026.8.0.zip": "73414942357644605eefd3f4afaf0b41b71772ad6574e8e3c72e0b6d237104c8",
			"bw-windows-2026.8.0.zip": "26a6bb9a88ca9eeaad9e59db1816dcceb3ce6cc80a30b33e1324b0642f4a0f32",
		},
	},
	bws: {
		name: "Bitwarden Secrets Manager CLI",
		verifyCachedCommand: true,
		repo: "bitwarden/sdk-sm",
		binaryName: "bws",
		systemBinaryNames: ["bws"],
		tagPrefix: "bws-v",
		pinnedVersion: BITWARDEN_SECRETS_MANAGER_CLI_VERSION,
		getAssetName: (version, plat, architecture) => {
			if (architecture !== "arm64" && architecture !== "x64") return null;
			const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
			if (plat === "darwin") return `bws-${archStr}-apple-darwin-${version}.zip`;
			if (plat === "linux") return `bws-${archStr}-unknown-linux-musl-${version}.zip`;
			if (plat === "win32") return `bws-${archStr}-pc-windows-msvc-${version}.zip`;
			return null;
		},
		sha256ByAsset: {
			"bws-aarch64-apple-darwin-2.1.0.zip": "9cb1c1c6e6164d83b2e339883ba02b4cbb37188ce9a484b1ce8249443163e066",
			"bws-aarch64-pc-windows-msvc-2.1.0.zip": "ba18adeb5d123481211c47c4e4d0ad6d81a6b0139150704785542fdee542e583",
			"bws-aarch64-unknown-linux-musl-2.1.0.zip": "eb0f1ae61d1c3b74244d2841233276e05c77e8be4da197ed90fc6248387005e1",
			"bws-x86_64-apple-darwin-2.1.0.zip": "6f626b3971368902af1b9847c02791a1b4666969d7561e2047681cded7997537",
			"bws-x86_64-pc-windows-msvc-2.1.0.zip": "8d6f2b51beb6f992b5b1de8b85a98bdf18de74096b724d17fa06219fc23f2bd5",
			"bws-x86_64-unknown-linux-musl-2.1.0.zip": "f59ee150e42b82128d437087e9bac920053c6bfddcb960d20ce9386e5ac9bba6",
		},
	},
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		pinnedVersion: FD_VERSION,
		getAssetName: (version, plat, architecture) => {
			if (architecture !== "arm64" && architecture !== "x64") return null;
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
		sha256ByAsset: {
			"fd-v10.5.0-x86_64-apple-darwin.tar.gz": "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
			"fd-v10.5.0-aarch64-apple-darwin.tar.gz": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
			"fd-v10.5.0-aarch64-pc-windows-msvc.zip": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
			"fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz":
				"c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c",
			"fd-v10.5.0-x86_64-pc-windows-msvc.zip": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
			"fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz":
				"a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95",
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		pinnedVersion: RG_VERSION,
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
		sha256ByAsset: {
			"ripgrep-15.2.0-aarch64-apple-darwin.tar.gz":
				"3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
			"ripgrep-15.2.0-aarch64-pc-windows-msvc.zip":
				"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
			"ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz":
				"a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
			"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz":
				"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
			"ripgrep-15.2.0-x86_64-pc-windows-msvc.zip":
				"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
			"ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz":
				"33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
		},
	},
	jq: {
		name: "jq",
		repo: "jqlang/jq",
		binaryName: "jq",
		systemBinaryNames: ["jq"],
		tagPrefix: "jq-",
		downloadKind: "binary",
		pinnedVersion: JQ_VERSION,
		getAssetName: (_version, plat, architecture) => {
			if (architecture !== "arm64" && architecture !== "x64") return null;
			const archStr = architecture === "arm64" ? "arm64" : "amd64";
			if (plat === "darwin") return `jq-macos-${archStr}`;
			if (plat === "linux") return `jq-linux-${archStr}`;
			if (plat === "win32") return `jq-windows-${archStr}.exe`;
			return null;
		},
		sha256ByAsset: {
			"jq-linux-amd64": "b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f",
			"jq-linux-arm64": "8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309",
			"jq-macos-amd64": "e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0",
			"jq-macos-arm64": "2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e",
			"jq-windows-amd64.exe": "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
			"jq-windows-arm64.exe": "083b5377392bc57cf27052b6d20a2d927770683bca844632901ff38b4b7b0ac7",
		},
	},
	jscpd: {
		name: "jscpd",
		repo: "",
		binaryName: "jscpd",
		systemBinaryNames: [],
		tagPrefix: "",
		pinnedVersion: JSCPD_VERSION,
		getAssetName: () => null,
	},
	uv: {
		name: "uv",
		repo: "astral-sh/uv",
		binaryName: "uv",
		systemBinaryNames: ["uv"],
		tagPrefix: "",
		pinnedVersion: UV_VERSION,
		getAssetName: (_version, plat, architecture) => {
			if (architecture !== "arm64" && architecture !== "x64") return null;
			const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
			if (plat === "darwin") return `uv-${archStr}-apple-darwin.tar.gz`;
			if (plat === "linux") return `uv-${archStr}-unknown-linux-musl.tar.gz`;
			if (plat === "win32") return `uv-${archStr}-pc-windows-msvc.zip`;
			return null;
		},
		sha256ByAsset: {
			"uv-aarch64-apple-darwin.tar.gz": "301f72afaf54060f92da7016cb0115bd077f43a9c8e39c1d8170a0bac80fd398",
			"uv-aarch64-pc-windows-msvc.zip": "d3360363a3cb671f2c854f4ef48cf4a57fe8664f8ec6a248076d68b797a8acc0",
			"uv-aarch64-unknown-linux-musl.tar.gz": "7eb9bf48516448c9db6a9e436d8e747ac9c8a9cac74717160a29918249b080a6",
			"uv-x86_64-apple-darwin.tar.gz": "e1ca175824f1056589ce9908f7631879ebc3c36535b5e63dc06510beb370b4c1",
			"uv-x86_64-pc-windows-msvc.zip": "ddbfcee1ac615a0499f6aa97b5ec8ebdf3ee4a7714a48055ec2ba0030e3cf810",
			"uv-x86_64-unknown-linux-musl.tar.gz": "aa4b1f8770910f7c7c543c7acc980e4270e52e70750c996acef813ea1c7c2912",
		},
	},
};

export type ManagedToolName = keyof typeof TOOLS;

export function getToolDownloadKind(tool: ManagedToolName, targetPlatform: string = platform()): "archive" | "binary" {
	const kind = TOOLS[tool].downloadKind;
	return typeof kind === "function" ? kind(targetPlatform) : (kind ?? "archive");
}

/** Directory layouts retain app-local runtimes alongside the executable instead of discarding them. */
export function getManagedToolBinaryPath(
	tool: ManagedToolName,
	targetPlatform: string = platform(),
	toolsDir: string = managedToolsDir(),
): string {
	const config = TOOLS[tool];
	const root =
		config.installLayout?.(targetPlatform) === "directory"
			? join(toolsDir, `${config.binaryName}-${config.pinnedVersion}`)
			: toolsDir;
	return join(root, config.binaryName + (targetPlatform === "win32" ? ".exe" : ""));
}

export type ManagedToolProvisionFailureCode =
	| "offline"
	| "unsupported_platform"
	| "installation_failed"
	| "not_found_after_install"
	| "unknown_tool";

export type ManagedToolResolution =
	| { status: "available"; path: string }
	| { status: "unavailable"; failureCode: ManagedToolProvisionFailureCode; message: string };

export type ManagedToolResolver = (tool: ManagedToolName, silent?: boolean) => Promise<ManagedToolResolution>;

export function formatManagedToolProvisioningFailure(
	tool: ManagedToolName,
	resolution: Extract<ManagedToolResolution, { status: "unavailable" }>,
): string {
	return `PI_TOOL_PROVISIONING_FAILED [${resolution.failureCode}] ${tool}: ${resolution.message}`;
}

export interface PinnedToolAsset {
	version: string;
	assetName: string;
	expectedSha256: string;
}

export function getPinnedToolAsset(
	tool: ManagedToolName,
	targetPlatform: string = platform(),
	targetArchitecture: string = arch(),
): PinnedToolAsset | null {
	const config: ToolConfig = TOOLS[tool];
	const version = config.pinnedVersion;
	if (!config.sha256ByAsset) return null;
	const assetName = config.getAssetName(version, targetPlatform, targetArchitecture);
	if (!assetName) return null;
	const expectedSha256 = config.sha256ByAsset[assetName];
	return expectedSha256 ? { version, assetName, expectedSha256 } : null;
}

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe", timeout: COMMAND_PROBE_TIMEOUT_MS });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

interface CachedToolPath {
	path: string;
	mtimeMs: number;
}

function isCachedToolPath(value: unknown): value is CachedToolPath {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.path === "string" && typeof candidate.mtimeMs === "number";
}

function getToolPathCacheFile(): string {
	return cacheFile(getAgentDir(), "tool-paths.json");
}

/** Read the persisted cross-run tool-path cache. Missing/corrupt/foreign entries are dropped silently -- a cold cache just means the next resolve re-probes and repopulates it. */
function readToolPathCache(): Partial<Record<ManagedToolName, CachedToolPath>> {
	try {
		const raw = readFileSync(getToolPathCacheFile(), "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const cache: Partial<Record<ManagedToolName, CachedToolPath>> = {};
		for (const tool of Object.keys(TOOLS) as ManagedToolName[]) {
			const entry = parsed[tool];
			if (isCachedToolPath(entry)) cache[tool] = entry;
		}
		return cache;
	} catch {
		return {};
	}
}

function writeToolPathCacheEntry(tool: ManagedToolName, entry: CachedToolPath): void {
	try {
		const cacheDir = agentCacheDir(getAgentDir());
		mkdirSync(cacheDir, { recursive: true });
		const cache = readToolPathCache();
		cache[tool] = entry;
		writeFileSync(join(cacheDir, "tool-paths.json"), JSON.stringify(cache));
	} catch {
		// Best-effort: a failed cache write only costs the next run its probe, same as a cold cache.
	}
}

/** A cached entry is fresh only while its file still exists at the same path with the same mtime -- a deleted/moved/replaced binary invalidates it and forces a re-probe below. */
function isCachedToolPathFresh(entry: CachedToolPath): boolean {
	try {
		return statSync(entry.path).mtimeMs === entry.mtimeMs;
	} catch {
		return false;
	}
}

function getPathExtensionCandidates(): readonly string[] {
	if (platform() !== "win32") return [""];
	const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
	return ["", ...pathExt.split(";").filter(Boolean)];
}

/**
 * Manually walk PATH to turn a bare command name that commandExists() already confirmed is
 * runnable into an absolute, stat-checkable path. This never decides presence itself (that stays
 * commandExists's job via spawnSync, unchanged) -- it only supplies the path the cross-run cache
 * needs for its mtime staleness check, using stat calls instead of another spawn.
 */
function resolveOnSystemPath(binaryName: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(platform() === "win32" ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		for (const ext of getPathExtensionCandidates()) {
			const candidate = join(dir, binaryName + ext);
			if (!existsSync(candidate)) continue;
			try {
				if (statSync(candidate).isDirectory()) continue;
				if (platform() !== "win32") accessSync(candidate, fsConstants.X_OK);
			} catch {
				continue;
			}
			return candidate;
		}
	}
	return null;
}

function cacheResolvedSystemPath(tool: ManagedToolName, resolvedPath: string): void {
	try {
		writeToolPathCacheEntry(tool, { path: resolvedPath, mtimeMs: statSync(resolvedPath).mtimeMs });
	} catch {
		// Stat raced with a delete between resolve and here: nothing to cache, still return the path below.
	}
}

/** Maximum filesystem inspections made by installed-only discovery. No process or cache writes. */
export const INSTALLED_TOOL_METADATA_BOUND = 512;

export function resolveInstalledExecutable(names: readonly string[], preferred: readonly string[] = []): string | null {
	const pathValue = process.env.PATH ?? "";
	if (pathValue.length > 65_536 || names.length > 8 || preferred.length > 8) return null;
	const directories = pathValue.split(platform() === "win32" ? ";" : ":").filter(isAbsolute);
	const extensions = platform() === "win32" ? [".exe", ".com", ""] : [""];
	let candidates = 0;
	const inspect = (candidate: string): boolean => {
		if (++candidates > INSTALLED_TOOL_METADATA_BOUND / 2) return false;
		try {
			if (!statSync(candidate).isFile()) return false;
			if (platform() !== "win32") accessSync(candidate, fsConstants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	for (const candidate of preferred) if (inspect(candidate)) return candidate;
	for (const directory of directories) {
		for (const name of names) {
			for (const extension of extensions) {
				if (candidates >= INSTALLED_TOOL_METADATA_BOUND / 2) return null;
				const candidate = join(directory, name + extension);
				if (inspect(candidate)) return candidate;
			}
		}
	}
	return null;
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ManagedToolName, options?: { installedOnly: boolean }): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = getManagedToolBinaryPath(tool);
	if (options?.installedOnly) {
		return resolveInstalledExecutable(config.systemBinaryNames ?? [config.binaryName], [localPath]);
	}
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];

	// A system-PATH resolution normally requires commandExists's synchronous
	// spawnSync(`<name> --version`) probe below, which is expensive to pay on every process
	// startup (this runs once per tool at interactive-mode init, plus again on the first
	// find/grep tool call). Persist the resolved absolute path + mtime across runs
	// (<agentDir>/cache/tool-paths.json) so a warm run can skip the probe entirely and just
	// stat the cached path instead. KNOWN LIMITATION: if a *different* binary of the same name
	// starts shadowing the cached one earlier on PATH (e.g. a new install) while the
	// originally-cached file itself is untouched, this cache keeps returning the old path until
	// that file is deleted/modified -- an intentional narrow staleness window (the returned tool
	// still exists and runs; it just isn't the newly-shadowing one), not a correctness bug.
	const cached = readToolPathCache()[tool];
	if (cached && isCachedToolPathFresh(cached) && (!config.verifyCachedCommand || commandExists(cached.path))) {
		return cached.path;
	}

	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			const resolved = resolveOnSystemPath(systemBinaryName);
			if (resolved) {
				cacheResolvedSystemPath(tool, resolved);
				return resolved;
			}
			// Could not resolve an absolute path to cache (e.g. PATH env raced between the two
			// lookups); still return the bare name so the caller keeps working, uncached.
			return systemBinaryName;
		}
	}

	return null;
}

/** Presence check for a SYSTEM tool the doctor only ever reports on -- never installs. */
export interface SystemToolStatus {
	present: boolean;
	command?: string;
	version?: string;
}

const PYTHON_COMMANDS = ["python3", "python"];

/**
 * Detect a usable Python interpreter. SYSTEM tool (see src/core/doctor.ts):
 * the doctor reports presence/version, it never installs this itself.
 *
 * @param commands Override the candidate command names, for tests.
 */
export function detectPython(commands: readonly string[] = PYTHON_COMMANDS): SystemToolStatus {
	for (const command of commands) {
		try {
			const result = spawnSync(command, ["--version"], { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
			if (result.error || result.status !== 0) continue;
			// Python 2 prints its version to stderr; Python 3 prints to stdout. Some
			// platforms' `python` alias is one or the other, so check both.
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			const version = output.match(/(?:^|\r?\n)(Python \d+\.\d+(?:\.\d+)?[^\r\n]*)(?:\r?\n|$)/)?.[1]?.trim();
			if (!version) continue;
			return { present: true, command, version };
		} catch {
			// Try the next candidate.
		}
	}
	return { present: false };
}

/**
 * Runs `<command> --version` (or `versionArgs`) and returns its trimmed
 * combined stdout+stderr, or undefined if the command can't be run. Used by
 * the doctor (src/core/doctor.ts) to show a version alongside a tool it has
 * already located by some other means (e.g. getToolPath("rg"), or the binary
 * path OllamaRuntime.detect() reports) -- callers that only need a yes/no
 * presence check should use commandExists/getToolPath/detectPython instead.
 */
export function probeVersion(command: string, versionArgs: readonly string[] = ["--version"]): string | undefined {
	try {
		const result = spawnSync(command, versionArgs, { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
		if (result.error) return undefined;
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", reject);
		stream.once("end", resolve);
	});
	return hash.digest("hex") === expectedSha256.toLowerCase();
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe", timeout: ARCHIVE_EXTRACTION_TIMEOUT_MS });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

async function extractZipArchive(archivePath: string, extractDir: string, assetName: string): Promise<void> {
	try {
		await extractZipFile(archivePath, extractDir);
	} catch (error) {
		throw new Error(`Failed to extract ${assetName}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Move a verified upstream standalone executable into Pi's managed bin directory. */
export function installStandaloneBinaryAsset(
	downloadedPath: string,
	binaryPath: string,
	targetPlatform: string = platform(),
): void {
	if (targetPlatform !== "win32") chmodSync(downloadedPath, 0o755);
	const agentDir = getAgentDir();
	const publication = publishHostFile(
		downloadedPath,
		binaryPath,
		join(agentDir, "npm"),
		hostTransitionsFile(agentDir),
		{
			replaceExisting: true,
		},
	);
	if (publication.status === "failed") throw new Error(`Failed to publish managed binary: ${publication.reason}`);
}

/** Publish the verified archive's application directory together, without overwriting a live generation. */
export function installToolArchiveDirectory(extractedBinary: string, binaryPath: string): void {
	if (!statSync(extractedBinary).isFile()) throw new Error("Managed archive executable is not a regular file.");
	const agentDir = getAgentDir();
	const publication = publishHostTree(
		dirname(extractedBinary),
		dirname(binaryPath),
		hostTransitionsFile(agentDir),
		join(agentDir, "npm"),
	);
	if (publication.status === "failed") throw new Error(`Failed to publish managed archive: ${publication.reason}`);
	if (!publication.attributed) throw new Error("Managed archive publication could not be attributed.");
}

// Download and install a tool
const toolDownloadPromises = new Map<ManagedToolName, Promise<string | undefined>>();

export function runExclusiveToolDownload(
	tool: ManagedToolName,
	installer: () => Promise<string | undefined>,
): Promise<string | undefined> {
	const existing = toolDownloadPromises.get(tool);
	if (existing) return existing;
	const promise = installer().finally(() => {
		if (toolDownloadPromises.get(tool) === promise) {
			toolDownloadPromises.delete(tool);
		}
	});
	toolDownloadPromises.set(tool, promise);
	return promise;
}

async function downloadTool(tool: ManagedToolName): Promise<string> {
	const config: ToolConfig = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Pinned tools are reproducible and verified before installation.
	const version = config.pinnedVersion;

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const downloadWorkDir = getProcessWorkRun(getAgentDir(), "downloads", "tools").path;
	const archivePath = join(downloadWorkDir, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = getManagedToolBinaryPath(tool, plat);

	// Download and verify pinned artifacts before extraction.
	await downloadFile(downloadUrl, archivePath);
	const expectedSha256 = config.sha256ByAsset?.[assetName];
	if (config.sha256ByAsset && !expectedSha256) {
		throw new Error(`No pinned SHA-256 is registered for ${assetName}`);
	}
	if (expectedSha256 && !(await verifyFileSha256(archivePath, expectedSha256))) {
		throw new Error(`SHA-256 verification failed for ${assetName}`);
	}

	if (getToolDownloadKind(tool, plat) === "binary") {
		try {
			installStandaloneBinaryAsset(archivePath, binaryPath, plat);
		} finally {
			rmSync(archivePath, { force: true });
		}
		return binaryPath;
	}

	// Extract into a unique temp directory. Tool downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		downloadWorkDir,
		`extract-${config.binaryName}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			await extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			if (plat !== "win32") chmodSync(extractedBinary, 0o755);
			if (config.installLayout?.(plat) === "directory") installToolArchiveDirectory(extractedBinary, binaryPath);
			else {
				const agentDir = getAgentDir();
				const publication = publishHostFile(
					extractedBinary,
					binaryPath,
					join(agentDir, "npm"),
					hostTransitionsFile(agentDir),
					{ replaceExisting: true },
				);
				if (publication.status === "failed")
					throw new Error(`Failed to publish managed binary: ${publication.reason}`);
			}
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Partial<Record<ManagedToolName, string>> = {
	fd: "fd",
	jscpd: "jscpd",
	jq: "jq",
	rg: "ripgrep",
	uv: "uv",
};

async function installTermuxManagedTool(tool: ManagedToolName, silent: boolean): Promise<string | undefined> {
	const packageName = TERMUX_PACKAGES[tool];
	if (!packageName) throw new Error(`${TOOLS[tool].name} has no supported Termux package`);
	if (!silent) console.log(chalk.dim(`${TOOLS[tool].name} not found. Installing with Termux pkg...`));
	const child = spawnProcess("pkg", ["install", "-y", packageName], {
		env: process.env,
		stdio: silent ? "ignore" : "inherit",
	});
	const terminal = await waitForChildProcessWithTermination(child, { timeoutMs: 300_000, killGraceMs: 5_000 });
	if (terminal.reason !== "exited" || terminal.code !== 0) {
		throw new Error(
			`pkg install ${packageName} ${terminal.reason === "timeout" ? "timed out" : `exited with code ${terminal.code ?? 1}`}`,
		);
	}
	return getToolPath(tool) ?? undefined;
}

/** Ensure a tool is available while retaining the exact bounded provisioning outcome for callers. */
export async function ensureToolWithDiagnostics(
	tool: ManagedToolName,
	silent: boolean = false,
): Promise<ManagedToolResolution> {
	if (tool === "jscpd") {
		try {
			return { status: "available", path: ensureManagedJscpd() };
		} catch (error) {
			const message = `Failed to provision jscpd: ${error instanceof Error ? error.message : String(error)}`;
			if (!silent) {
				console.log(chalk.yellow(message));
			}
			return { status: "unavailable", failureCode: "installation_failed", message };
		}
	}
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return { status: "available", path: existingPath };
	}

	const config = TOOLS[tool];
	if (!config) {
		return { status: "unavailable", failureCode: "unknown_tool", message: `Unknown managed tool: ${tool}` };
	}

	if (isOfflineModeEnabled()) {
		const message = `${config.name} not found. Offline mode enabled, skipping download.`;
		if (!silent) {
			console.log(chalk.yellow(message));
		}
		return { status: "unavailable", failureCode: "offline", message };
	}

	// On Android/Termux, upstream Linux archives target glibc/musl rather than Bionic.
	// uv is a required managed runtime and the user explicitly authorized provisioning it;
	// preserve guide-only behavior for optional search tools.
	if (platform() === "android") {
		if (tool !== "uv") {
			const packageName = TERMUX_PACKAGES[tool];
			const message = packageName
				? `${config.name} not found. Install with: pkg install ${packageName}`
				: `${config.name} is not available as a supported managed tool on Android.`;
			if (!silent) console.log(chalk.yellow(message));
			return { status: "unavailable", failureCode: "unsupported_platform", message };
		}
		try {
			const installedPath = await runExclusiveToolDownload(tool, () => installTermuxManagedTool(tool, silent));
			return installedPath
				? { status: "available", path: installedPath }
				: {
						status: "unavailable",
						failureCode: "not_found_after_install",
						message: `${config.name} installation completed but the binary was not found.`,
					};
		} catch (error) {
			const message = `Failed to install ${config.name}: ${error instanceof Error ? error.message : String(error)}`;
			if (!silent) {
				console.log(chalk.yellow(message));
			}
			return { status: "unavailable", failureCode: "installation_failed", message };
		}
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await runExclusiveToolDownload(tool, () => downloadTool(tool));
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path
			? { status: "available", path }
			: {
					status: "unavailable",
					failureCode: "not_found_after_install",
					message: `${config.name} installation completed but the binary was not found.`,
				};
	} catch (e) {
		const message = `Failed to download ${config.name}: ${e instanceof Error ? e.message : String(e)}`;
		if (!silent) {
			console.log(chalk.yellow(message));
		}
		return { status: "unavailable", failureCode: "installation_failed", message };
	}
}

/**
 * Resolves a managed tool only when it is already installed, and never downloads one: the resolver of a lane that holds
 * no network grant, whose host must not reach the network or install software on its behalf.
 */
export async function resolveInstalledManagedTool(tool: ManagedToolName): Promise<ManagedToolResolution> {
	const path = getToolPath(tool, { installedOnly: true });
	if (path) return { status: "available", path };
	return {
		status: "unavailable",
		failureCode: "offline",
		message: `${tool} is not installed, and this lane holds no network grant to download it.`,
	};
}

// Compatibility projection for callers that only need a path. New tool execution paths should use
// ensureToolWithDiagnostics so failure identity is not discarded at the provisioning boundary.
export async function ensureTool(tool: ManagedToolName, silent: boolean = false): Promise<string | undefined> {
	const resolution = await ensureToolWithDiagnostics(tool, silent);
	return resolution.status === "available" ? resolution.path : undefined;
}
