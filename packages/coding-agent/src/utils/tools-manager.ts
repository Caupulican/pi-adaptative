import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "fs";
import { createRequire } from "module";
import { arch, platform } from "os";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { pathToFileURL } from "url";
import { APP_NAME, getBinDir } from "../config.ts";
import { spawnProcess, waitForChildProcess } from "./child-process.ts";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const FFF_NODE_VERSION = "0.9.6";
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
}

const TOOLS: Record<string, ToolConfig> = {
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
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
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
	const result = spawnSync(command, args, { stdio: "pipe" });
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
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Get latest version
	let version = await getLatestVersion(config.repo);
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
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
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
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
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

export function loadAvailableFffNodePackage(): unknown | undefined {
	for (const requireFff of [moduleRequire, executableDirRequire, createManagedFffRequire()].filter(
		(candidate): candidate is ModuleRequire => Boolean(candidate),
	)) {
		const loaded = loadFffNodeWith(requireFff);
		if (loaded) return loaded;
	}
	return undefined;
}

async function runNpmInstall(args: string[]): Promise<{ code: number | null; stderr: string }> {
	try {
		const child = spawnProcess("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const code = await waitForChildProcess(child);
		return { code, stderr };
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
): Promise<unknown | undefined> {
	const existing = forceManagedInstall ? undefined : loadAvailableFffNodePackage();
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

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
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

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return undefined;
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
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
