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
import { APP_NAME, getAgentDir, getBinDir } from "../config.ts";
import { cacheDir as agentCacheDir, cacheFile } from "../core/agent-paths.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "./child-process.ts";
import { getProcessWorkRun } from "./work-directory.ts";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_PROBE_TIMEOUT_MS = 5_000;
const ARCHIVE_EXTRACTION_TIMEOUT_MS = 5 * 60_000;
const FFF_NODE_VERSION = "0.9.6";
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
	pinnedVersion?: string;
	sha256ByAsset?: Readonly<Record<string, string>>;
}

const TOOLS: Record<"fd" | "rg" | "uv", ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
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
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
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
	if (!config.pinnedVersion || !config.sha256ByAsset) return null;
	const assetName = config.getAssetName(config.pinnedVersion, targetPlatform, targetArchitecture);
	if (!assetName) return null;
	const expectedSha256 = config.sha256ByAsset[assetName];
	return expectedSha256 ? { version: config.pinnedVersion, assetName, expectedSha256 } : null;
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
			if (result.error) continue;
			// Python 2 prints its version to stderr; Python 3 prints to stdout. Some
			// platforms' `python` alias is one or the other, so check both.
			const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || undefined;
			if (result.status !== 0 && !version) continue;
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

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
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

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
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

	// Pinned tools are reproducible; legacy search tools retain their current latest-release behavior.
	let version = config.pinnedVersion ?? (await getLatestVersion(config.repo));
	if (tool === "fd" && plat === "darwin" && architecture === "x64") {
		version = "10.3.0";
	}

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

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
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
			extractZipArchive(archivePath, extractDir, assetName);
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
const TERMUX_PACKAGES: Record<ManagedToolName, string> = {
	fd: "fd",
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

function loadFffNodeDistEntry(requireFff: ModuleRequire): unknown | undefined {
	if (!requireFff.resolve) return undefined;
	try {
		const ffiPath = requireFff.resolve("ffi-rs");
		const fffEntry = findFffNodeDistEntry(ffiPath);
		return fffEntry ? requireFff(fffEntry) : undefined;
	} catch {
		return undefined;
	}
}

function loadFffNodeWith(requireFff: ModuleRequire): unknown | undefined {
	try {
		return requireFff("@ff-labs/fff-node");
	} catch {
		return loadFffNodeDistEntry(requireFff);
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
		const loaded = loadFffNodeWith(createRequire(pathToFileURL(FFF_MANAGED_PACKAGE_JSON).href));
		if (!loaded) {
			const reason = "Managed FFF install completed but @ff-labs/fff-node could not be loaded.";
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
): Promise<unknown | undefined> {
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

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or undefined if unavailable
export async function ensureTool(tool: ManagedToolName, silent: boolean = false): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return undefined;
	}

	// On Android/Termux, upstream Linux archives target glibc/musl rather than Bionic.
	// uv is a required managed runtime and the user explicitly authorized provisioning it;
	// preserve guide-only behavior for optional search tools.
	if (platform() === "android") {
		if (tool !== "uv") {
			const packageName = TERMUX_PACKAGES[tool];
			if (!silent) console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${packageName}`));
			return undefined;
		}
		try {
			return await runExclusiveToolDownload(tool, () => installTermuxManagedTool(tool, silent));
		} catch (error) {
			if (!silent) {
				console.log(
					chalk.yellow(`Failed to install ${config.name}: ${error instanceof Error ? error.message : error}`),
				);
			}
			return undefined;
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
		return path;
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return undefined;
	}
}
