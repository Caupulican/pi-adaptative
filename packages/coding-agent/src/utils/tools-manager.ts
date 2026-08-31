import { createHash } from "node:crypto";
import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import {
	accessSync,
	chmodSync,
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { createRequire } from "module";
import { arch, platform } from "os";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { pathToFileURL } from "url";
import { getAgentDir, getBinDir } from "../config.ts";
import { cacheDir as agentCacheDir, cacheFile } from "../core/agent-paths.ts";
import { ensureManagedJscpd, JSCPD_VERSION } from "./bundled-jscpd.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "./child-process.ts";
import { getProcessWorkRun } from "./work-directory.ts";
import { extractZipFile } from "./zip-extractor.ts";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_PROBE_TIMEOUT_MS = 5_000;
const ARCHIVE_EXTRACTION_TIMEOUT_MS = 5 * 60_000;
const FFF_NODE_VERSION = "0.9.6";
export const BITWARDEN_CLI_VERSION = "2026.7.0";
export const BITWARDEN_SECRETS_MANAGER_CLI_VERSION = "2.1.0";
export const FD_VERSION = "10.4.2";
const FD_DARWIN_X64_VERSION = "10.3.0";
export const RG_VERSION = "15.2.0";
export const JQ_VERSION = "1.8.2";
export const UV_VERSION = "0.11.28";
const FFF_MANAGED_DIR = join(TOOLS_DIR, "fff-node");
const FFF_MANAGED_PACKAGE_JSON = join(FFF_MANAGED_DIR, "package.json");

type ModuleRequire = ((id: string) => unknown) & { resolve?: (id: string) => string };

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
	downloadKind?: "archive" | "binary";
	pinnedVersion: string;
	getPinnedVersion?: (plat: string, architecture: string) => string | undefined;
	sha256ByAsset?: Readonly<Record<string, string>>;
}

const TOOLS: Record<"bw" | "bws" | "fd" | "jq" | "jscpd" | "rg" | "uv", ToolConfig> = {
	bw: {
		name: "Bitwarden CLI",
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
			"bw-linux-2026.7.0.zip": "7a35145e205952f7434d2370da359543145ae0c45ba1af0fe9bdd99d40a00180",
			"bw-linux-arm64-2026.7.0.zip": "e33ed05ca0fada9bd51b8bce76a230369bf0eefd5796a0a8e60699c977327fb5",
			"bw-macos-2026.7.0.zip": "b37836d539798f5adeb8a907619ee8a55b6322549bb68669aa4b3a03d5bc0452",
			"bw-macos-arm64-2026.7.0.zip": "61d5de8a279a9faf3637216f4fb02b506a1e4bb2817d1c64be0bd474466dd85a",
			"bw-windows-2026.7.0.zip": "b0c22438607b789c6452dbd37ffd6be0e8a61e7a5c4e9ac57804d7ae5ed01b5b",
		},
	},
	bws: {
		name: "Bitwarden Secrets Manager CLI",
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
		getPinnedVersion: (plat, architecture) =>
			plat === "darwin" && architecture === "x64" ? FD_DARWIN_X64_VERSION : undefined,
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
			"fd-v10.3.0-x86_64-apple-darwin.tar.gz": "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
			"fd-v10.4.2-aarch64-apple-darwin.tar.gz": "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
			"fd-v10.4.2-aarch64-pc-windows-msvc.zip": "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
			"fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz":
				"6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5",
			"fd-v10.4.2-x86_64-pc-windows-msvc.zip": "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
			"fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz":
				"def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8",
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
			"uv-aarch64-apple-darwin.tar.gz": "33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232",
			"uv-aarch64-pc-windows-msvc.zip": "3248109afad3ec59baad299d324ff53de17e2d9a3b3e21580ffd26744b11e036",
			"uv-aarch64-unknown-linux-musl.tar.gz": "da10cdfa7d92212b7acb62021a0fd61bcf8580c58c3632ec915d10c3a1a7906b",
			"uv-x86_64-apple-darwin.tar.gz": "2ad79983127ffca7d77b77ce6a24278d7e4f7b817a1acf72fea5f8124b4aac5e",
			"uv-x86_64-pc-windows-msvc.zip": "0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b",
			"uv-x86_64-unknown-linux-musl.tar.gz": "f02146b371c35c287d860f003ece7345c86e358a3fd70a9b63700cd141ee7fb4",
		},
	},
};

export type ManagedToolName = keyof typeof TOOLS;

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

function getConfiguredPinnedVersion(config: ToolConfig, targetPlatform: string, targetArchitecture: string): string {
	return config.getPinnedVersion?.(targetPlatform, targetArchitecture) ?? config.pinnedVersion;
}

export function getPinnedToolAsset(
	tool: ManagedToolName,
	targetPlatform: string = platform(),
	targetArchitecture: string = arch(),
): PinnedToolAsset | null {
	const config: ToolConfig = TOOLS[tool];
	const version = getConfiguredPinnedVersion(config, targetPlatform, targetArchitecture);
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
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
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

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ManagedToolName): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
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
	if (cached && isCachedToolPathFresh(cached)) {
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
	mkdirSync(dirname(binaryPath), { recursive: true });
	renameSync(downloadedPath, binaryPath);
	if (targetPlatform !== "win32") chmodSync(binaryPath, 0o755);
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
	const version = getConfiguredPinnedVersion(config, plat, architecture);

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const downloadWorkDir = getProcessWorkRun(getAgentDir(), "downloads", "tools").path;
	const archivePath = join(downloadWorkDir, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download and verify pinned artifacts before extraction.
	await downloadFile(downloadUrl, archivePath);
	const expectedSha256 = config.sha256ByAsset?.[assetName];
	if (config.sha256ByAsset && !expectedSha256) {
		throw new Error(`No pinned SHA-256 is registered for ${assetName}`);
	}
	if (expectedSha256 && !(await verifyFileSha256(archivePath, expectedSha256))) {
		throw new Error(`SHA-256 verification failed for ${assetName}`);
	}

	if (config.downloadKind === "binary") {
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
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
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

const FFF_PLATFORM_PACKAGES: Record<string, string> = {
	"darwin/arm64": "@ff-labs/fff-bin-darwin-arm64",
	"darwin/x64": "@ff-labs/fff-bin-darwin-x64",
	"linux/arm64/glibc": "@ff-labs/fff-bin-linux-arm64-gnu",
	"linux/arm64/musl": "@ff-labs/fff-bin-linux-arm64-musl",
	"linux/x64/glibc": "@ff-labs/fff-bin-linux-x64-gnu",
	"linux/x64/musl": "@ff-labs/fff-bin-linux-x64-musl",
	"win32/arm64": "@ff-labs/fff-bin-win32-arm64",
	"win32/x64": "@ff-labs/fff-bin-win32-x64",
};

let fffNodeInstallPromise: Promise<unknown | undefined> | undefined;

function detectLinuxLibc(): "glibc" | "musl" {
	let output = "";
	try {
		const result = spawnSync("ldd", ["--version"], { encoding: "utf-8", stdio: "pipe", timeout: 5000 });
		output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	} catch (e: unknown) {
		const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
		output = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
	}
	return output.toLowerCase().includes("musl") ? "musl" : "glibc";
}

function getFffPlatformPackageName(): string | undefined {
	const plat = platform();
	const architecture = arch();
	if (plat === "linux") {
		return FFF_PLATFORM_PACKAGES[`${plat}/${architecture}/${detectLinuxLibc()}`];
	}
	return FFF_PLATFORM_PACKAGES[`${plat}/${architecture}`];
}

function createManagedFffRequire(): ModuleRequire | undefined {
	if (!existsSync(FFF_MANAGED_PACKAGE_JSON)) return undefined;
	return createRequire(pathToFileURL(FFF_MANAGED_PACKAGE_JSON).href);
}

function findFffNodeDistEntry(startPath: string): string | undefined {
	let currentDir = dirname(startPath);
	while (currentDir !== dirname(currentDir)) {
		const candidate = join(currentDir, "node_modules", "@ff-labs", "fff-node", "dist", "src", "index.js");
		if (existsSync(candidate)) return candidate;
		currentDir = dirname(currentDir);
	}
	return undefined;
}

/**
 * Why a load attempt failed, kept for the diagnostic. Both paths below swallow their throw to try
 * the next candidate, and reporting only "could not be loaded" leaves nothing to act on — the real
 * cause is one or two levels down the require chain (a missing native binding, say), never the
 * name of the package we asked for.
 */
let lastFffLoadError: string | undefined;

function recordFffLoadError(error: unknown): undefined {
	lastFffLoadError = error instanceof Error ? error.message.split("\n")[0] : String(error);
	return undefined;
}

function loadFffNodeDistEntry(requireFff: ModuleRequire): unknown | undefined {
	if (!requireFff.resolve) return undefined;
	try {
		const ffiPath = requireFff.resolve("ffi-rs");
		const fffEntry = findFffNodeDistEntry(ffiPath);
		return fffEntry ? requireFff(fffEntry) : undefined;
	} catch (error) {
		return recordFffLoadError(error);
	}
}

function loadFffNodeWith(requireFff: ModuleRequire): unknown | undefined {
	try {
		return requireFff("@ff-labs/fff-node");
	} catch (error) {
		// The package publishes an exports map with no `require` condition, so a bare specifier
		// always throws here and the dist entry below is the real path. Keep this error only if the
		// fallback has nothing better to say.
		const bareSpecifierError = error;
		const loaded = loadFffNodeDistEntry(requireFff);
		if (!loaded && lastFffLoadError === undefined) recordFffLoadError(bareSpecifierError);
		return loaded;
	}
}

/**
 * @param requires Override the resolution candidates, for tests (mirrors
 * fff-search-backend.ts's loadFffModule(requires?)). Whether this resolves
 * depends on the ambient environment -- @ff-labs/fff-node is a real npm
 * dependency (package.json), so moduleRequire succeeds wherever a normal
 * `npm install`/`npm ci` provisioned it (e.g. CI) even though it fails on a
 * dev checkout that never ran that install here (this repo resolves fff-node
 * via the separate managed-dir path instead). A test asserting "nothing is
 * available" must pass `[]` here rather than relying on that being true.
 */
export function loadAvailableFffNodePackage(requires?: readonly ModuleRequire[]): unknown | undefined {
	const candidates =
		requires ??
		[moduleRequire, executableDirRequire, createManagedFffRequire()].filter((candidate): candidate is ModuleRequire =>
			Boolean(candidate),
		);
	for (const requireFff of candidates) {
		const loaded = loadFffNodeWith(requireFff);
		if (loaded) return loaded;
	}
	return undefined;
}

async function runNpmInstall(args: string[]): Promise<{ code: number | null; stderr: string }> {
	try {
		const child = spawnProcess("npm", args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-64 * 1024);
		});
		const terminal = await waitForChildProcessWithTermination(child, {
			timeoutMs: ARCHIVE_EXTRACTION_TIMEOUT_MS,
			killGraceMs: 2_000,
		});
		if (terminal.reason === "timeout") {
			stderr = `${stderr}\nnpm install timed out after ${ARCHIVE_EXTRACTION_TIMEOUT_MS}ms`.trim();
		}
		return { code: terminal.code, stderr };
	} catch (error) {
		return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Outcome of the most recent {@link ensureFffNodePackage} call, kept for
 * observability (e.g. a future `doctor` check) since the function itself
 * only ever returns the loaded module or `undefined` either way.
 *
 * `install-failed` is distinguished from `offline`/`unsupported-platform`
 * because it is the only one worth *retrying*: offline mode and an
 * unsupported platform are stable for the life of the process, but a real
 * install attempt can fail on a transient issue (registry hiccup, timeout)
 * that may no longer apply on the next search. See
 * DefaultFffSearchBackend.getFinder in fff-search-backend.ts, which uses
 * this distinction to decide whether a failed finder is retryable.
 */
export type FffInstallOutcome =
	| { status: "already-available" }
	| { status: "offline" }
	| { status: "unsupported-platform" }
	| { status: "installed" }
	| { status: "install-failed"; reason: string };

/**
 * How long a genuine install failure gates out a NEW npm spawn. An agent turn
 * can fire several find/grep calls in quick succession, and each one now
 * primes the finder in the background (see tryFffFind/tryFffGrep) -- without
 * this, a persistently-failing install (registry down, disk full, ...) would
 * re-spawn npm on every single one of those calls instead of once.
 *
 * This gates the SPAWN inside ensureFffNodePackage, not whether a failed
 * finder is retryable (see isFffInstallRetryable): DefaultFffSearchBackend
 * always evicts a failed finder so the next search re-enters this function,
 * and it is THIS cooldown check -- evaluated fresh, at call time -- that
 * decides whether that re-entry is a real attempt or a fast, spawn-free bail.
 * (An earlier version conflated the two: it gated eviction itself on the
 * cooldown, which is checked once, immediately after the failure it's timing
 * -- i.e. always still within the window -- so the failed finder was never
 * evicted and the retry never got a chance to happen at all.)
 */
export const FFF_INSTALL_RETRY_COOLDOWN_MS = 30_000;

let lastFffInstallOutcome: FffInstallOutcome | undefined;
let lastFffInstallFailureAt: number | undefined;

/** The outcome of the last {@link ensureFffNodePackage} call, if any. */
export function getLastFffInstallOutcome(): FffInstallOutcome | undefined {
	return lastFffInstallOutcome;
}

/** Whether the last install outcome was a genuine failure worth retrying (as opposed to a stable "not applicable" result). Cooldown-independent by design -- see FFF_INSTALL_RETRY_COOLDOWN_MS. */
export function isFffInstallRetryable(): boolean {
	return lastFffInstallOutcome?.status === "install-failed";
}

/**
 * Pure decision logic behind {@link isFffInstallCoolingDown}, exposed directly
 * so tests can assert the cooldown boundary without faking the system clock.
 */
export function computeIsFffInstallCoolingDown(
	outcome: FffInstallOutcome | undefined,
	failedAt: number | undefined,
	now: number,
): boolean {
	if (outcome?.status !== "install-failed") return false;
	if (failedAt === undefined) return false;
	return now - failedAt < FFF_INSTALL_RETRY_COOLDOWN_MS;
}

/** Whether a real install attempt happened too recently to try again right now. */
function isFffInstallCoolingDown(): boolean {
	return computeIsFffInstallCoolingDown(lastFffInstallOutcome, lastFffInstallFailureAt, Date.now());
}

/** Records a genuine install failure and stamps when it happened, so the cooldown above has a start time to measure from. */
function recordFffInstallFailure(reason: string): void {
	lastFffInstallOutcome = { status: "install-failed", reason };
	lastFffInstallFailureAt = Date.now();
}

/**
 * Put ffi-rs's native bindings where a compiled binary can actually reach them.
 *
 * `ffi-rs/index.js` prefers `require("./ffi-rs.<triple>.node")` and only falls back to
 * `require("@yuuang/ffi-rs-<triple>")` when that file is absent — the local-file branch napi-rs
 * publishes precisely for bundled and compiled runtimes. Our releases are built with
 * `bun build --compile`, and inside that executable the scoped fallback does not resolve from an
 * external node_modules tree: the load fails with `Cannot find module '@yuuang/ffi-rs-<triple>'`
 * even though npm installed it. Running from source on Node resolves it fine, which is why this
 * only ever bites a shipped binary.
 *
 * Copying is by exact filename, so no platform table is duplicated here: npm installs only the
 * optional packages whose os/cpu/libc match, and ffi-rs looks each one up by its own triple.
 */
export function stageFfiRsNativeBindings(): void {
	const ffiRsDir = join(FFF_MANAGED_DIR, "node_modules", "ffi-rs");
	const scopeDir = join(FFF_MANAGED_DIR, "node_modules", "@yuuang");
	if (!existsSync(ffiRsDir) || !existsSync(scopeDir)) return;
	for (const packageName of readdirSync(scopeDir)) {
		const packageDir = join(scopeDir, packageName);
		if (!statSync(packageDir).isDirectory()) continue;
		for (const entry of readdirSync(packageDir)) {
			if (!entry.endsWith(".node")) continue;
			const target = join(ffiRsDir, entry);
			if (existsSync(target)) continue;
			copyFileSync(join(packageDir, entry), target);
		}
	}
}

async function installManagedFffNodePackage(platformPackage: string, silent: boolean): Promise<unknown | undefined> {
	try {
		mkdirSync(FFF_MANAGED_DIR, { recursive: true });
		if (!existsSync(FFF_MANAGED_PACKAGE_JSON)) {
			writeFileSync(FFF_MANAGED_PACKAGE_JSON, '{"name":"pi-managed-fff-node","private":true,"version":"0.0.0"}\n');
		}

		if (!silent) {
			console.log(chalk.dim("FFF native search not found. Installing managed FFF package..."));
		}

		const args = [
			"install",
			"--ignore-scripts",
			"--omit=dev",
			"--include=optional",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
			"--prefix",
			FFF_MANAGED_DIR,
			`@ff-labs/fff-node@${FFF_NODE_VERSION}`,
			`${platformPackage}@${FFF_NODE_VERSION}`,
		];
		const result = await runNpmInstall(args);
		if (result.code !== 0) {
			const reason = result.stderr.trim() || `npm exited with code ${result.code}`;
			if (!silent) {
				console.log(chalk.yellow(`Failed to install FFF native search: ${reason}`));
			}
			recordFffInstallFailure(reason);
			return undefined;
		}
		stageFfiRsNativeBindings();
		lastFffLoadError = undefined;
		const loaded = loadFffNodeWith(createRequire(pathToFileURL(FFF_MANAGED_PACKAGE_JSON).href));
		if (!loaded) {
			const reason = `Managed FFF install completed but @ff-labs/fff-node could not be loaded${lastFffLoadError ? `: ${lastFffLoadError}` : "."}`;
			if (!silent) {
				console.log(chalk.yellow(reason));
			}
			recordFffInstallFailure(reason);
			return undefined;
		}
		lastFffInstallOutcome = { status: "installed" };
		return loaded;
	} catch (error) {
		// Never let a filesystem/spawn surprise (e.g. a read-only home directory)
		// crash the caller: fall back like any other install failure, but keep
		// the reason observable.
		const reason = error instanceof Error ? error.message : String(error);
		if (!silent) {
			console.log(chalk.yellow(`Failed to install FFF native search: ${reason}`));
		}
		recordFffInstallFailure(reason);
		return undefined;
	}
}

export async function ensureFffNodePackage(
	silent: boolean = false,
	forceManagedInstall: boolean = false,
	/** Override the "is it already available" resolution candidates, for tests. See loadAvailableFffNodePackage's doc. */
	requires?: readonly ModuleRequire[],
	/** Override native binding staging for deterministic filesystem-failure tests. */
	stageBindings: () => void = stageFfiRsNativeBindings,
): Promise<unknown | undefined> {
	// A prior managed install can be complete while its package-native ffi-rs binding has not yet
	// been staged (for example, after upgrading from a release that staged only post-install).
	// Repair that local installation before the first load attempt and before offline/network gates.
	// Staging is opportunistic: unreadable/corrupt managed trees must not block other load roots or
	// turn an offline closed fallback into a bootstrap exception.
	try {
		stageBindings();
	} catch {
		// Continue to ordinary module resolution and provisioning gates.
	}
	const existing = forceManagedInstall ? undefined : loadAvailableFffNodePackage(requires);
	if (existing) {
		lastFffInstallOutcome = { status: "already-available" };
		return existing;
	}

	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow("FFF native search not found. Offline mode enabled, skipping install."));
		}
		lastFffInstallOutcome = { status: "offline" };
		return undefined;
	}

	// A prior attempt failed too recently to try again: bail out fast (no npm
	// spawn, no platform/libc probing) rather than repeating a doomed attempt.
	// Leaves lastFffInstallOutcome/lastFffInstallFailureAt untouched -- this
	// isn't a new attempt, so there's nothing new to record.
	if (isFffInstallCoolingDown()) {
		return undefined;
	}

	const platformPackage = getFffPlatformPackageName();
	if (!platformPackage) {
		if (!silent) {
			console.log(chalk.yellow(`FFF native search is not available for ${platform()}/${arch()}.`));
		}
		lastFffInstallOutcome = { status: "unsupported-platform" };
		return undefined;
	}

	fffNodeInstallPromise ??= installManagedFffNodePackage(platformPackage, silent).finally(() => {
		fffNodeInstallPromise = undefined;
	});
	return fffNodeInstallPromise;
}

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

// Compatibility projection for callers that only need a path. New tool execution paths should use
// ensureToolWithDiagnostics so failure identity is not discarded at the provisioning boundary.
export async function ensureTool(tool: ManagedToolName, silent: boolean = false): Promise<string | undefined> {
	const resolution = await ensureToolWithDiagnostics(tool, silent);
	return resolution.status === "available" ? resolution.path : undefined;
}
