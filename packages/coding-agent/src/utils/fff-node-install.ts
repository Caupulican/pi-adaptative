import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
/**
 * Owns FFF platform selection, module loading, per-target install cooldown and the staged managed-package lifecycle.
 * npm/module access is an explicit port; all production bytes publish through the managed-install owner.
 */

import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { getAgentDir, getBinDir, getPackageDependencyVersion } from "../config.ts";
import { hostTransitionsFile } from "../core/agent-paths.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "./child-process.ts";
import { publishHostFile, publishHostTree } from "./host-tree-publication.ts";
import {
	MANAGED_TOOL_INSTALL_TIMEOUT_MS as ARCHIVE_EXTRACTION_TIMEOUT_MS,
	isOfflineModeEnabled,
} from "./managed-tool-policy.ts";

type ModuleRequire = ((id: string) => unknown) & { resolve?: (id: string) => string };
const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
export const FFF_NODE_VERSION = getPackageDependencyVersion("@ff-labs/fff-node");
function fffManagedDir(): string {
	return join(getBinDir(), "fff-node");
}

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

const fffNodeInstallPromises = new Map<string, Promise<unknown | undefined>>();

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
	if (!existsSync(join(fffManagedDir(), "package.json"))) return undefined;
	return createRequire(pathToFileURL(join(fffManagedDir(), "package.json")).href);
}

const FFF_DIST_CANDIDATE_ENTRIES = [
	join("dist", "index.cjs"),
	join("dist", "index.js"),
	join("dist", "src", "index.js"),
] as const;

function findFffNodeDistEntry(startPath: string): string | undefined {
	let currentDir = dirname(startPath);
	while (currentDir !== dirname(currentDir)) {
		for (const candidateEntry of FFF_DIST_CANDIDATE_ENTRIES) {
			const candidate = join(currentDir, "node_modules", "@ff-labs", "fff-node", candidateEntry);
			if (existsSync(candidate)) return candidate;
		}
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

export function getLastFffLoadError(): string | undefined {
	return lastFffLoadError;
}

function loadFffNodeDistEntry(requireFff: ModuleRequire): unknown | undefined {
	if (!requireFff.resolve) return undefined;
	try {
		try {
			const pkgPath = requireFff.resolve("@ff-labs/fff-node/package.json");
			const pkgDir = dirname(pkgPath);
			for (const candidateEntry of FFF_DIST_CANDIDATE_ENTRIES) {
				const candidate = join(pkgDir, candidateEntry);
				if (existsSync(candidate)) {
					return requireFff(candidate);
				}
			}
		} catch {
			// Fall through to ffi-rs traversal if direct resolve is unavailable or fails.
		}
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
		// bun --compile cannot resolve the bare specifier from an external node_modules tree even
		// when createRequire is rooted at the managed package.json. Keep this error only if the
		// dist fallback has nothing better to say.
		const bareSpecifierError = error;
		const loaded = loadFffNodeDistEntry(requireFff);
		if (!loaded && lastFffLoadError === undefined) recordFffLoadError(bareSpecifierError);
		return loaded;
	}
}

/**
 * Load the managed install by absolute dist path. Specifier resolution is skipped, so a
 * bun-compiled binary can use the files npm already wrote under `bin/fff-node`.
 * Paths are resolved at call time so tests that redirect {@link getBinDir} after import still hit
 * the redirected tree. Tests that pass an explicit `requires` list to
 * {@link loadAvailableFffNodePackage} must not go through this path.
 */
export function loadFffNodeFromManagedInstall(managedToolsDirectory: string = getBinDir()): unknown | undefined {
	const packageDir = join(managedToolsDirectory, "fff-node", "node_modules", "@ff-labs", "fff-node");
	for (const candidateEntry of FFF_DIST_CANDIDATE_ENTRIES) {
		const candidate = join(packageDir, candidateEntry);
		if (!existsSync(candidate)) continue;
		try {
			const loaded = createRequire(candidate)(candidate);
			lastFffLoadError = undefined;
			return loaded;
		} catch (error) {
			recordFffLoadError(error);
		}
	}
	return undefined;
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
	if (requires === undefined) return loadFffNodeFromManagedInstall();
	return undefined;
}

async function runNpmInstall(args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
	try {
		const child = spawnProcess("npm", args, {
			cwd,
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

/** External package-install and module-load I/O; the staged publication remains owned here. */
export interface FffManagedInstallIo {
	runNpmInstall(args: string[], cwd: string): Promise<{ code: number | null; stderr: string }>;
	loadManagedPackage(packageDir: string): unknown | undefined;
}

const defaultFffManagedInstallIo: FffManagedInstallIo = {
	runNpmInstall,
	loadManagedPackage(packageDir) {
		return (
			loadFffNodeWith(createRequire(pathToFileURL(join(packageDir, "package.json")).href)) ??
			loadFffNodeFromManagedInstall(dirname(packageDir))
		);
	},
};

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
const fffInstallFailures = new Map<string, number>();
const MAX_FFF_INSTALL_FAILURE_TARGETS = 32;

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
function isFffInstallCoolingDown(targetKey: string): boolean {
	return computeIsFffInstallCoolingDown(
		fffInstallFailures.has(targetKey) ? { status: "install-failed", reason: "" } : undefined,
		fffInstallFailures.get(targetKey),
		Date.now(),
	);
}

/** Records a genuine install failure and stamps when it happened, so the cooldown above has a start time to measure from. */
function recordFffInstallFailure(reason: string, targetKey: string): void {
	lastFffInstallOutcome = { status: "install-failed", reason };
	fffInstallFailures.delete(targetKey);
	fffInstallFailures.set(targetKey, Date.now());
	if (fffInstallFailures.size > MAX_FFF_INSTALL_FAILURE_TARGETS)
		fffInstallFailures.delete(fffInstallFailures.keys().next().value!);
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
export function stageFfiRsNativeBindings(
	root: string = fffManagedDir(),
	journal: string | undefined = root === fffManagedDir() ? hostTransitionsFile(getAgentDir()) : undefined,
): void {
	const ffiRsDir = join(root, "node_modules", "ffi-rs");
	const scopeDir = join(root, "node_modules", "@yuuang");
	if (!existsSync(ffiRsDir) || !existsSync(scopeDir)) return;
	for (const packageName of readdirSync(scopeDir)) {
		const packageDir = join(scopeDir, packageName);
		if (!statSync(packageDir).isDirectory()) continue;
		for (const entry of readdirSync(packageDir)) {
			if (!entry.endsWith(".node")) continue;
			const target = join(ffiRsDir, entry);
			if (existsSync(target)) continue;
			if (journal) {
				const npmDir = join(getAgentDir(), "npm");
				publishHostFile(join(packageDir, entry), target, npmDir, journal, { replaceExisting: true });
			} else copyFileSync(join(packageDir, entry), target);
		}
	}
}

async function installManagedFffNodePackage(
	platformPackage: string,
	silent: boolean,
	io: FffManagedInstallIo,
	agentDir: string,
	managedDirectory: string,
): Promise<unknown | undefined> {
	let stagingDir: string | undefined;
	const targetKey = `${agentDir}\0${managedDirectory}`;
	try {
		const npmDir = join(agentDir, "npm");
		mkdirSync(npmDir, { recursive: true });
		stagingDir = mkdtempSync(join(npmDir, "fff-node-stage-"));
		writeFileSync(
			join(stagingDir, "package.json"),
			'{"name":"pi-managed-fff-node","private":true,"version":"0.0.0"}\n',
		);

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
			stagingDir,
			`@ff-labs/fff-node@${FFF_NODE_VERSION}`,
			`${platformPackage}@${FFF_NODE_VERSION}`,
		];
		const result = await io.runNpmInstall(args, stagingDir);
		if (result.code !== 0) {
			const reason = result.stderr.trim() || `npm exited with code ${result.code}`;
			if (!silent) {
				console.log(chalk.yellow(`Failed to install FFF native search: ${reason}`));
			}
			recordFffInstallFailure(reason, targetKey);
			return undefined;
		}
		stageFfiRsNativeBindings(stagingDir);
		const publication = publishHostTree(stagingDir, managedDirectory, hostTransitionsFile(agentDir), npmDir);
		if (publication.status === "failed" || !publication.attributed) {
			const reason =
				publication.status === "failed" ? publication.reason : "Publication provenance was unavailable.";
			if (!silent) console.log(chalk.yellow(`Failed to publish managed FFF package: ${reason}`));
			recordFffInstallFailure(reason, targetKey);
			return undefined;
		}
		lastFffLoadError = undefined;
		const loaded = io.loadManagedPackage(managedDirectory);
		if (!loaded) {
			const reason = `Managed FFF install completed but @ff-labs/fff-node could not be loaded${lastFffLoadError ? `: ${lastFffLoadError}` : "."}`;
			if (!silent) {
				console.log(chalk.yellow(reason));
			}
			recordFffInstallFailure(reason, targetKey);
			return undefined;
		}
		lastFffInstallOutcome = { status: "installed" };
		fffInstallFailures.delete(targetKey);
		return loaded;
	} catch (error) {
		// Never let a filesystem/spawn surprise (e.g. a read-only home directory)
		// crash the caller: fall back like any other install failure, but keep
		// the reason observable.
		const reason = error instanceof Error ? error.message : String(error);
		if (!silent) {
			console.log(chalk.yellow(`Failed to install FFF native search: ${reason}`));
		}
		recordFffInstallFailure(reason, targetKey);
		return undefined;
	} finally {
		if (stagingDir && existsSync(stagingDir)) {
			try {
				rmSync(stagingDir, { recursive: true, force: true });
			} catch {
				// A leftover stage is confined to the host-owned npm directory.
			}
		}
	}
}

export async function ensureFffNodePackage(
	silent: boolean = false,
	forceManagedInstall: boolean = false,
	/** Override the "is it already available" resolution candidates, for tests. See loadAvailableFffNodePackage's doc. */
	requires?: readonly ModuleRequire[],
	/** Override native binding staging for deterministic filesystem-failure tests. */
	stageBindings: () => void = stageFfiRsNativeBindings,
	/** Explicit boundary for npm/module I/O; staged filesystem publication always follows the production path. */
	installIo: FffManagedInstallIo = defaultFffManagedInstallIo,
	/** Explicit installation owner paths for an embedded session; production defaults to the current user's managed bin. */
	installTarget: {
		readonly agentDir: string;
		readonly managedDirectory: string;
		readonly platformPackage?: string;
	} = {
		agentDir: getAgentDir(),
		managedDirectory: fffManagedDir(),
	},
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
	// Leaves the target's prior failure stamp untouched -- this
	// isn't a new attempt, so there's nothing new to record.
	const targetKey = `${installTarget.agentDir}\0${installTarget.managedDirectory}`;
	if (isFffInstallCoolingDown(targetKey)) {
		return undefined;
	}

	const platformPackage = installTarget.platformPackage ?? getFffPlatformPackageName();
	if (!platformPackage) {
		if (!silent) {
			console.log(chalk.yellow(`FFF native search is not available for ${platform()}/${arch()}.`));
		}
		lastFffInstallOutcome = { status: "unsupported-platform" };
		return undefined;
	}

	let installPromise = fffNodeInstallPromises.get(targetKey);
	if (!installPromise) {
		installPromise = installManagedFffNodePackage(
			platformPackage,
			silent,
			installIo,
			installTarget.agentDir,
			installTarget.managedDirectory,
		).finally(() => {
			if (fffNodeInstallPromises.get(targetKey) === installPromise) fffNodeInstallPromises.delete(targetKey);
		});
		fffNodeInstallPromises.set(targetKey, installPromise);
	}
	return installPromise;
}
