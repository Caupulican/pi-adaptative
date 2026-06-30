import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ensureFffNodePackage, loadAvailableFffNodePackage } from "../../utils/tools-manager.ts";

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

interface FffModule {
	FileFinder: FffFileFinderConstructor;
}

export interface FffSearchBackend {
	getFinder(basePath: string): Promise<FffFileFinder | undefined>;
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

class DefaultFffSearchBackend implements FffSearchBackend {
	private readonly finders = new Map<string, Promise<FffFileFinder | undefined>>();

	async getFinder(basePath: string): Promise<FffFileFinder | undefined> {
		if (isFffRuntimeDisabled()) return undefined;

		const normalizedBasePath = path.resolve(basePath);
		const cached = this.finders.get(normalizedBasePath);
		if (cached) return cached;

		const created = this.createFinder(normalizedBasePath);
		this.finders.set(normalizedBasePath, created);
		this.evictIfNeeded();
		return created;
	}

	private evictIfNeeded(): void {
		while (this.finders.size > MAX_FINDER_CACHE_SIZE) {
			const firstKey = this.finders.keys().next().value;
			if (!firstKey) return;
			const first = this.finders.get(firstKey);
			this.finders.delete(firstKey);
			void first?.then(destroyFinder, () => undefined);
		}
	}

	private async createFinder(basePath: string): Promise<FffFileFinder | undefined> {
		let fff = await ensureFffModule();
		if (!fff) return undefined;
		if (fff.FileFinder.isAvailable && !fff.FileFinder.isAvailable()) {
			const installed = await ensureFffNodePackage(true, true);
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
