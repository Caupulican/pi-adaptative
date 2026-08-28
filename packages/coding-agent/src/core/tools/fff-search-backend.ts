import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ensureFffNodePackage, isFffInstallRetryable, loadAvailableFffNodePackage } from "../../utils/tools-manager.ts";
import type { SearchRouter, SearchToolKind } from "./search-router.ts";

export type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type FffGrepMode = "plain" | "regex" | "fuzzy";

export interface FffFileItem {
	relativePath: string;
	fileName: string;
	size: number;
	modified: number;
	gitStatus: string;
	accessFrecencyScore?: number;
	modificationFrecencyScore?: number;
	totalFrecencyScore?: number;
}

export interface FffScore {
	total: number;
	baseScore: number;
	matchType: string;
}

export interface FffSearchResult {
	items: FffFileItem[];
	scores: FffScore[];
	totalMatched: number;
	totalFiles: number;
}

export interface FffSearchOptions {
	pageIndex?: number;
	pageSize?: number;
}

export interface FffGlobOptions {
	pageIndex?: number;
	pageSize?: number;
}

export interface FffGrepOptions {
	maxMatchesPerFile?: number;
	smartCase?: boolean;
	mode?: FffGrepMode;
	beforeContext?: number;
	afterContext?: number;
	pageSize?: number;
}

export interface FffGrepMatch {
	relativePath: string;
	fileName: string;
	gitStatus: string;
	size: number;
	modified: number;
	isBinary: boolean;
	totalFrecencyScore: number;
	accessFrecencyScore: number;
	modificationFrecencyScore: number;
	lineNumber: number;
	col: number;
	byteOffset: number;
	lineContent: string;
	matchRanges: [number, number][];
	contextBefore?: string[];
	contextAfter?: string[];
}

export interface FffGrepResult {
	items: FffGrepMatch[];
	totalMatched: number;
	totalFilesSearched: number;
	totalFiles: number;
	filteredFileCount: number;
	nextCursor: unknown | null;
	regexFallbackError?: string;
}

export interface FffFileFinder {
	readonly isDestroyed: boolean;
	destroy(): void;
	fileSearch(query: string, options?: FffSearchOptions): FffResult<FffSearchResult>;
	glob(pattern: string, options?: FffGlobOptions): FffResult<FffSearchResult>;
	grep(query: string, options?: FffGrepOptions): FffResult<FffGrepResult>;
	waitForScan(timeoutMs?: number): Promise<FffResult<boolean>>;
}

interface FffInitOptions {
	basePath: string;
	aiMode?: boolean;
	enableHomeDirScanning?: boolean;
	enableFsRootScanning?: boolean;
}

interface FffFileFinderConstructor {
	create(options: FffInitOptions): FffResult<FffFileFinder>;
	isAvailable?: () => boolean;
}

export interface FffModule {
	FileFinder: FffFileFinderConstructor;
}

export interface FffSearchBackend {
	getFinder(basePath: string): Promise<FffFileFinder | undefined>;
	/**
	 * Non-blocking acquisition: the finder for this basePath ONLY when it is already
	 * warm. When nothing is warm yet, implementations start (or continue) warming in the
	 * background and return undefined so the current search is served by the fd/rg
	 * fallback instead of stalling on an index scan — finder creation waits on a
	 * filesystem crawl (up to 15s per attempt, effectively unbounded over WSL /mnt
	 * mounts), and a search tool call must never block on an index build.
	 *
	 * Optional so extension-supplied backends (e.g. SSH remote search) keep their
	 * existing awaited-acquisition contract unchanged.
	 */
	peekFinder?(basePath: string): FffFileFinder | undefined;
}

/**
 * Calls backend.getFinder(cwd) and guarantees the returned promise can never
 * reject -- not even if a non-conforming backend's getFinder throws
 * synchronously instead of returning a rejected promise (the FffSearchBackend
 * contract is also implemented by extension-supplied backends, e.g. an SSH
 * remote search, which aren't guaranteed to be `async`-declared). find.ts and
 * grep.ts call this unconditionally, before routing decides whether this call
 * even wants FFF, specifically so a broken/throwing backend degrades to
 * "unavailable for this call" (graceful fd/rg fallback) instead of failing
 * the whole tool call or risking an unhandled rejection.
 */
export async function safeGetFinder(backend: FffSearchBackend, cwd: string): Promise<FffFileFinder | undefined> {
	try {
		return await backend.getFinder(cwd);
	} catch {
		return undefined;
	}
}

/**
 * Non-throwing wrapper around an optional backend.peekFinder, mirroring safeGetFinder's
 * guarantee for non-conforming backends: a synchronous throw degrades to "unavailable
 * for this call" rather than failing the tool call.
 */
function safePeekFinder(backend: FffSearchBackend, cwd: string): FffFileFinder | undefined {
	if (backend.peekFinder === undefined) return undefined;
	try {
		return backend.peekFinder(cwd);
	} catch {
		return undefined;
	}
}

/**
 * Acquire an FFF finder only when all three routing stages accept it. A backend that
 * supports non-blocking acquisition (peekFinder) is consulted without awaiting: a cold
 * finder warms in the background while this call falls back to fd/rg, so no search ever
 * stalls behind an index scan. Backends without peekFinder (extension-supplied) keep the
 * awaited path, with finder startup begun before routing so a lazy managed install can
 * progress even when the current request falls back.
 */
export async function resolveRoutedFffFinder(options: {
	backend: FffSearchBackend;
	router: SearchRouter;
	tool: SearchToolKind;
	cwd: string;
	searchPath: string;
	glob: boolean;
	ignoreCase: boolean;
	limit: number;
	readGitignoreInTree: () => Promise<boolean> | boolean;
}): Promise<{ finder: FffFileFinder; searchPathRelativeToCwd: string } | undefined> {
	const nonBlocking = options.backend.peekFinder !== undefined;
	// Warm-up starts before routing so a lazy managed install can progress even when
	// this call falls back to fd/rg: non-blocking backends warm via the peek itself,
	// legacy ones via the awaited promise.
	const peeked = nonBlocking ? safePeekFinder(options.backend, options.cwd) : undefined;
	const finderPromise = nonBlocking ? undefined : safeGetFinder(options.backend, options.cwd);
	const searchPathRelativeToCwd = relativePathInside(options.cwd, options.searchPath);
	const route = (finderAvailable: boolean, pathResolvable: boolean, gitignoreInTree: boolean) =>
		options.router.route({
			tool: options.tool,
			glob: options.glob,
			ignoreCase: options.ignoreCase,
			limit: options.limit,
			finderAvailable,
			pathResolvable,
			gitignoreInTree,
		});

	if (route(true, searchPathRelativeToCwd !== undefined, false).backend !== "fff") return undefined;
	if (searchPathRelativeToCwd === undefined) return undefined;
	if (route(true, true, await options.readGitignoreInTree()).backend !== "fff") return undefined;

	const finder = nonBlocking ? peeked : await finderPromise;
	if (!finder || route(true, true, false).backend !== "fff") return undefined;
	return { finder, searchPathRelativeToCwd };
}

type ModuleRequire = (id: string) => unknown;

const DEFAULT_WAIT_FOR_SCAN_MS = 15_000;
const MAX_FINDER_CACHE_SIZE = 8;
const FFF_GITIGNORE_SKIP_DIRS = new Set([".git", "node_modules"]);

let loadedFffModule: FffModule | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function hasProperties(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && (typeof value === "object" || typeof value === "function");
}

function isFffResult<T>(value: unknown): value is FffResult<T> {
	if (!isRecord(value)) return false;
	return value.ok === true || value.ok === false;
}

function isFffModule(value: unknown): value is FffModule {
	if (!isRecord(value)) return false;
	const fileFinder = value.FileFinder;
	return hasProperties(fileFinder) && typeof fileFinder.create === "function";
}

export function loadFffModule(requires?: readonly ModuleRequire[]): FffModule | null {
	if (requires) {
		for (const requireFff of requires) {
			try {
				const loaded = requireFff("@ff-labs/fff-node");
				if (isFffModule(loaded)) return loaded;
			} catch {
				// Try the next resolution root.
			}
		}
		return null;
	}

	if (loadedFffModule !== undefined) return loadedFffModule;
	const loaded = loadAvailableFffNodePackage();
	loadedFffModule = isFffModule(loaded) ? loaded : null;
	return loadedFffModule;
}

async function ensureFffModule(): Promise<FffModule | null> {
	const loaded = loadFffModule();
	if (loaded) return loaded;
	const installed = await ensureFffNodePackage(true);
	loadedFffModule = isFffModule(installed) ? installed : null;
	return loadedFffModule;
}

function isFffRuntimeDisabled(): boolean {
	const value = process.env.PI_FFF_DISABLED ?? process.env.PI_SEARCH_BACKEND;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "disabled";
}

function isRootScanningEnabled(): boolean {
	const value = process.env.PI_FFF_ENABLE_ROOT_SCAN;
	return value === "1" || value?.toLowerCase() === "true";
}

function destroyFinder(finder: FffFileFinder | undefined): void {
	if (finder && !finder.isDestroyed) {
		finder.destroy();
	}
}

export function relativePathInside(basePath: string, targetPath: string): string | undefined {
	const relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
	if (relative === "") return "";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

export async function hasGitignoreInTree(rootPath: string): Promise<boolean> {
	const stack = [path.resolve(rootPath)];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return true;
		}

		for (const entry of entries) {
			if (entry.isFile() && entry.name === ".gitignore") return true;
			if (entry.isDirectory() && !FFF_GITIGNORE_SKIP_DIRS.has(entry.name)) {
				stack.push(path.join(current, entry.name));
			}
		}
	}
	return false;
}

/**
 * The two calls DefaultFffSearchBackend.createFinder makes to lazily load and,
 * if needed, install `@ff-labs/fff-node`. Pulled out as an injectable seam
 * (mirroring loadFffModule's optional `requires` param) so tests can simulate
 * a fresh machine -- and a faked install succeeding or failing -- without
 * touching the real module-global caches or spawning a real npm install.
 */
export interface FffFinderDeps {
	ensureFffModule: () => Promise<FffModule | null>;
	ensureFffNodePackage: (silent: boolean, forceManagedInstall?: boolean) => Promise<unknown | undefined>;
	/** Whether the last install outcome was a genuine failure worth retrying. */
	isInstallRetryable: () => boolean;
}

const realFffFinderDeps: FffFinderDeps = {
	ensureFffModule,
	ensureFffNodePackage,
	isInstallRetryable: isFffInstallRetryable,
};

export class DefaultFffSearchBackend implements FffSearchBackend {
	private readonly finders = new Map<string, Promise<FffFileFinder | undefined>>();
	/** Settled outcomes only, so peekFinder can answer without awaiting creation. */
	private readonly warmFinders = new Map<string, FffFileFinder | undefined>();
	private readonly deps: FffFinderDeps;

	constructor(deps: FffFinderDeps = realFffFinderDeps) {
		this.deps = deps;
	}

	async getFinder(basePath: string): Promise<FffFileFinder | undefined> {
		if (isFffRuntimeDisabled()) return undefined;

		const normalizedBasePath = path.resolve(basePath);
		const cached = this.finders.get(normalizedBasePath);
		if (cached) return cached;

		const created = this.createFinder(normalizedBasePath);
		void created.then(
			(finder) => {
				if (this.finders.get(normalizedBasePath) !== created) return;
				// A genuine install failure (network hiccup, registry blip, ...) must
				// not permanently gate FFF out of this basePath for the rest of the
				// process: drop the cache entry so the NEXT search retries instead of
				// being silently stuck on the fd/rg fallback forever. A stable
				// "not applicable" outcome (offline mode, unsupported platform) is left
				// cached, since retrying it would just repeat the same answer.
				if (!finder && this.deps.isInstallRetryable()) {
					this.finders.delete(normalizedBasePath);
					return;
				}
				this.warmFinders.set(normalizedBasePath, finder);
			},
			() => undefined,
		);
		this.finders.set(normalizedBasePath, created);
		this.evictIfNeeded();
		return created;
	}

	peekFinder(basePath: string): FffFileFinder | undefined {
		if (isFffRuntimeDisabled()) return undefined;
		const normalizedBasePath = path.resolve(basePath);
		if (this.warmFinders.has(normalizedBasePath)) return this.warmFinders.get(normalizedBasePath);
		// Cold: kick off (or continue) creation in the background and let this call fall
		// back to fd/rg. getFinder never rejects from here (createFinder catches its own
		// failures into undefined), but guard anyway for non-conforming injected deps.
		void this.getFinder(normalizedBasePath).then(
			() => undefined,
			() => undefined,
		);
		return undefined;
	}

	private evictIfNeeded(): void {
		while (this.finders.size > MAX_FINDER_CACHE_SIZE) {
			const firstKey = this.finders.keys().next().value;
			if (!firstKey) return;
			const first = this.finders.get(firstKey);
			this.finders.delete(firstKey);
			this.warmFinders.delete(firstKey);
			void first?.then(destroyFinder, () => undefined);
		}
	}

	private async createFinder(basePath: string): Promise<FffFileFinder | undefined> {
		let fff = await this.deps.ensureFffModule();
		if (!fff) return undefined;
		if (fff.FileFinder.isAvailable && !fff.FileFinder.isAvailable()) {
			const installed = await this.deps.ensureFffNodePackage(true, true);
			loadedFffModule = isFffModule(installed) ? installed : null;
			fff = loadedFffModule;
			if (!fff || (fff.FileFinder.isAvailable && !fff.FileFinder.isAvailable())) return undefined;
		}

		const created = fff.FileFinder.create({
			basePath,
			aiMode: true,
			enableHomeDirScanning: true,
			enableFsRootScanning: isRootScanningEnabled(),
		});
		if (!isFffResult<FffFileFinder>(created) || !created.ok) return undefined;

		const scan = await created.value.waitForScan(DEFAULT_WAIT_FOR_SCAN_MS);
		if (!scan.ok) {
			destroyFinder(created.value);
			return undefined;
		}
		return created.value;
	}
}

export const defaultFffSearchBackend: FffSearchBackend = new DefaultFffSearchBackend();
