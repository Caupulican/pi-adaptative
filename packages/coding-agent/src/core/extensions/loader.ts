/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { cacheFile } from "../agent-paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import { resolveExtensionIndexEntry } from "./entry-resolution.ts";
import {
	createExtension,
	createExtensionAPI,
	createExtensionRuntime,
	EXTENSION_FACTORY_TIMEOUT_MS,
	ExtensionFactoryTimeoutError,
	restoreExtensionLoadRuntime,
	runExtensionFactory,
	snapshotExtensionLoadRuntime,
} from "./factory-runtime.ts";
import { disposeExtensionEventSubscriptions, isExtensionGenerationInactive } from "./lifecycle.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult, ToolDefinition } from "./types.ts";
import {
	getBundledExtensionVirtualModules,
	PI_AGENT_CORE_EXTENSION_SUBPATHS,
	PI_AI_EXTENSION_SUBPATHS,
} from "./virtual-modules.ts";

export { createExtensionRuntime, loadExtensionFromFactory } from "./factory-runtime.ts";
export { disposeExtensionEventSubscriptions } from "./lifecycle.ts";

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

function safeRealpath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const loaderFile = fileURLToPath(import.meta.url);
	const realLoaderFile = safeRealpath(loaderFile);
	const __dirname = path.dirname(loaderFile);
	const realDirname = path.dirname(realLoaderFile);
	const packageIndex = [
		path.resolve(__dirname, "../..", "index.ts"),
		path.resolve(__dirname, "../..", "index.js"),
	].find((candidate) => fs.existsSync(candidate));
	if (!packageIndex) throw new Error("Unable to resolve the coding-agent package entry");

	const moduleRequires = uniquePaths([loaderFile, realLoaderFile]).map((file) => createRequire(file));
	const resolveModule = (specifier: string): string => {
		for (const moduleRequire of moduleRequires) {
			try {
				return moduleRequire.resolve(specifier);
			} catch {
				// Try the next resolution base. Linked global installs may resolve the
				// loader through the global symlink path while workspace dependencies are
				// hoisted beside the real source path.
			}
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const typeboxEntry = resolveModule("typebox");
	const typeboxCompileEntry = resolveModule("typebox/compile");
	const typeboxValueEntry = resolveModule("typebox/value");

	const packagesRoots = uniquePaths([
		path.resolve(__dirname, "../../../../"),
		path.resolve(realDirname, "../../../../"),
	]);
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		for (const packagesRoot of packagesRoots) {
			const workspacePath = path.join(packagesRoot, workspaceRelativePath);
			if (fs.existsSync(workspacePath)) {
				return workspacePath;
			}
		}
		return resolveModule(specifier);
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/src/index.ts", "@caupulican/pi-agent-core");
	const piAgentCoreSubpathEntries = Object.fromEntries(
		Object.entries(PI_AGENT_CORE_EXTENSION_SUBPATHS).map(([subpath, workspacePath]) => [
			subpath,
			resolveWorkspaceOrImport(workspacePath, `@caupulican/pi-agent-core/${subpath}`),
		]),
	);
	const piTuiEntry = resolveWorkspaceOrImport("tui/src/index.ts", "@caupulican/pi-tui");
	const piAiEntry = resolveWorkspaceOrImport("ai/src/index.ts", "@caupulican/pi-ai");
	const piAiSubpathEntries = Object.fromEntries(
		Object.entries(PI_AI_EXTENSION_SUBPATHS).map(([subpath, workspacePath]) => [
			subpath,
			resolveWorkspaceOrImport(workspacePath, `@caupulican/pi-ai/${subpath}`),
		]),
	);
	const piAiAliases = (packageName: string): Record<string, string> =>
		Object.fromEntries([
			...Object.entries(piAiSubpathEntries).map(([subpath, entry]) => [`${packageName}/${subpath}`, entry]),
			[packageName, piAiEntry],
		]);
	const piAgentCoreAliases = (packageName: string): Record<string, string> =>
		Object.fromEntries([
			...Object.entries(piAgentCoreSubpathEntries).map(([subpath, entry]) => [`${packageName}/${subpath}`, entry]),
			[packageName, piAgentCoreEntry],
		]);

	_aliases = {
		...piAgentCoreAliases("@caupulican/pi-agent-core"),
		...piAiAliases("@caupulican/pi-ai"),
		"@caupulican/pi-adaptative": piCodingAgentEntry,
		"@caupulican/pi-tui": piTuiEntry,
		...piAgentCoreAliases("@earendil-works/pi-agent-core"),
		...piAiAliases("@earendil-works/pi-ai"),
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		...piAgentCoreAliases("@mariozechner/pi-agent-core"),
		...piAiAliases("@mariozechner/pi-ai"),
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function loadExtensionModule(
	extensionPath: string,
	transformCacheAgentDir: string | undefined,
	opts?: { fresh?: boolean; moduleTimeoutMs?: number },
) {
	const jiti = createJiti(import.meta.url, {
		// A fresh jiti instance is created on every call and moduleCache is disabled so each load
		// evaluates the module from scratch, producing a genuinely new instance with reset top-level
		// state and closures. This is required for hot reload (/reload, /new, /resume, /fork, profile
		// switch): a previous extension generation's module state must never leak into the next one.
		//
		// This is orthogonal to the Babel *transform* step. jiti has its own on-disk fsCache that
		// caches transformed output keyed by a content hash of the source, independent of
		// moduleCache. Pointing it at an explicit, durable directory under the agent dir (instead of
		// jiti's default heuristic, which falls back to a shared OS tmp dir when no node_modules
		// sibling exists next to the extension file) makes unchanged extensions skip Babel on repeat
		// loads while still isolating module state, and edits are still detected automatically via
		// the content hash. Do not hand-roll a second in-memory transform cache on top of this: it
		// would duplicate jiti's own content-hash-validated cache for no benefit. Production loaders
		// pass an explicit agent dir; low-level callers that omit it remain zero-write and skip fsCache.
		moduleCache: false,
		fsCache: transformCacheAgentDir ? cacheFile(transformCacheAgentDir, "jiti-transforms") : false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary
			? { virtualModules: getBundledExtensionVirtualModules(), tryNative: false }
			: { alias: getAliases() }),
	});

	// Every call gets a fresh jiti instance with moduleCache disabled. Do not append a query string:
	// jiti's Windows path resolver treats it as part of the .ts filename.
	const timeoutMs = opts?.moduleTimeoutMs ?? EXTENSION_FACTORY_TIMEOUT_MS;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const module = await Promise.race([
			jiti.import(extensionPath, { default: true }),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Extension module import timed out after ${timeoutMs}ms: ${extensionPath}`)),
					Math.max(0, timeoutMs),
				);
			}),
		]);
		const factory = module as ExtensionFactory;
		return typeof factory !== "function" ? undefined : factory;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	opts?: { fresh?: boolean; factoryTimeoutMs?: number; moduleTimeoutMs?: number; agentDir?: string },
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
	const resolvedAgentDir = resolvePath(opts?.agentDir ?? getAgentDir());
	const transformCacheAgentDir = opts?.agentDir ? resolvedAgentDir : undefined;

	try {
		const factory = await loadExtensionModule(resolvedPath, transformCacheAgentDir, opts);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus, resolvedAgentDir);
		const runtimeSnapshot = snapshotExtensionLoadRuntime(runtime);
		try {
			await runExtensionFactory(factory, api, opts?.factoryTimeoutMs);
		} catch (err) {
			await disposeExtensionEventSubscriptions([extension]);
			restoreExtensionLoadRuntime(runtime, runtimeSnapshot);
			throw err;
		}

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

function createLazyToolDefinition(
	extension: Extension,
	manifest: LazyToolManifest,
	load: () => Promise<void>,
): ToolDefinition {
	const name = String(manifest.name).trim();
	const definition: ToolDefinition = {
		name,
		label: typeof manifest.label === "string" && manifest.label.trim() ? manifest.label : name,
		description:
			typeof manifest.description === "string" && manifest.description.trim()
				? manifest.description
				: `Lazy extension tool ${name}`,
		parameters: (manifest.parameters ?? defaultLazyToolParameters()) as ToolDefinition["parameters"],
		promptSnippet: typeof manifest.promptSnippet === "string" ? manifest.promptSnippet : undefined,
		promptGuidelines: Array.isArray(manifest.promptGuidelines)
			? manifest.promptGuidelines.filter((item): item is string => typeof item === "string")
			: undefined,
		toolGroup: typeof manifest.toolGroup === "string" ? manifest.toolGroup : undefined,
		executionMode:
			manifest.executionMode === "parallel" || manifest.executionMode === "sequential"
				? manifest.executionMode
				: undefined,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			await load();
			const loadedDefinition = extension.tools.get(name)?.definition;
			if (!loadedDefinition || loadedDefinition === definition) {
				throw new Error(`Lazy extension ${extension.path} did not register tool ${name}`);
			}
			return loadedDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
	return definition;
}

function createLazyExtension(
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	agentDir: string,
	transformCacheAgentDir: string | undefined,
	lazyTools: LazyToolManifest[],
): Extension {
	const extension = createExtension(extensionPath, resolvedPath);
	let restoreLazyToolPlaceholders = (): void => {};
	const load = async (): Promise<void> => {
		if (isExtensionGenerationInactive(extension)) {
			throw new Error(`Lazy extension generation is no longer active: ${extension.path}`);
		}
		if (extension.lazy?.loaded) return;
		if (extension.lazy?.loading) return extension.lazy.loading;

		const loading = (async () => {
			const factory = await loadExtensionModule(resolvedPath, transformCacheAgentDir);
			if (!factory) {
				throw new Error(`Extension does not export a valid factory function: ${extensionPath}`);
			}
			const api = createExtensionAPI(extension, runtime, cwd, eventBus, agentDir);
			const runtimeSnapshot = snapshotExtensionLoadRuntime(runtime);
			try {
				await runExtensionFactory(factory, api);
			} catch (error) {
				await disposeExtensionEventSubscriptions([extension], { deactivate: false });
				restoreExtensionLoadRuntime(runtime, runtimeSnapshot);
				throw error;
			}
			if (extension.lazy) {
				extension.lazy.loaded = true;
				extension.lazy.loading = undefined;
			}
		})();

		if (extension.lazy) extension.lazy.loading = loading;
		try {
			await loading;
		} catch (err) {
			await disposeExtensionEventSubscriptions([extension], {
				deactivate: err instanceof ExtensionFactoryTimeoutError,
			});
			extension.handlers.clear();
			extension.messageRenderers.clear();
			extension.commands.clear();
			extension.flags.clear();
			extension.shortcuts.clear();
			extension.tools.clear();
			restoreLazyToolPlaceholders();
			if (extension.lazy) extension.lazy.loading = undefined;
			throw err;
		}
	};

	extension.lazy = { loaded: false, load };
	restoreLazyToolPlaceholders = () => {
		for (const tool of lazyTools) {
			const name = String(tool.name).trim();
			extension.tools.set(name, {
				definition: createLazyToolDefinition(extension, tool, load),
				sourceInfo: extension.sourceInfo,
			});
		}
	};
	restoreLazyToolPlaceholders();
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(
	paths: Array<string | ExtensionLoadSpec>,
	cwd: string,
	eventBus?: EventBus,
	options: { agentDir?: string } = {},
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedAgentDir = resolvePath(options.agentDir ?? getAgentDir());
	const transformCacheAgentDir = options.agentDir ? resolvedAgentDir : undefined;
	const runtime = createExtensionRuntime();

	for (const spec of paths) {
		const normalized = typeof spec === "string" ? { path: spec } : spec;
		const extPath = normalized.path;
		const resolvedPath = resolvePath(extPath, resolvedCwd, { normalizeUnicodeSpaces: true });
		const lazyTools = (normalized.lazyTools ?? inferLazyToolsForExtensionPath(resolvedPath))?.filter(
			(tool) => typeof tool.name === "string" && tool.name.trim(),
		);
		// Extension imports can be CPU-heavy under jiti. Yield around each load so
		// interactive reloads can repaint/status-update instead of freezing the TUI
		// for the whole extension set. Lazy tool manifests skip import entirely here.
		await yieldToEventLoop();
		if (lazyTools?.length) {
			extensions.push(
				createLazyExtension(
					extPath,
					resolvedPath,
					resolvedCwd,
					resolvedEventBus,
					runtime,
					resolvedAgentDir,
					transformCacheAgentDir,
					lazyTools,
				),
			);
			await yieldToEventLoop();
			continue;
		}

		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			runtime,
			options.agentDir ? { agentDir: resolvedAgentDir } : undefined,
		);
		await yieldToEventLoop();

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface LazyToolManifest {
	name?: unknown;
	label?: unknown;
	description?: unknown;
	parameters?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
	toolGroup?: unknown;
	executionMode?: unknown;
	/** Optional extension entry this tool belongs to when a package declares multiple entries. */
	extension?: unknown;
}

interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
	/** Tool metadata for opt-in lazy extension loading. Factories stay unloaded until one of these tools runs. */
	lazyTools?: LazyToolManifest[];
	/** Alternate nested spelling: { tools: [...] }. */
	lazy?: { tools?: LazyToolManifest[] } | boolean;
}

interface ExtensionLoadSpec {
	path: string;
	lazyTools?: LazyToolManifest[];
}

function getManifestLazyTools(manifest: PiManifest | null): LazyToolManifest[] | undefined {
	if (!manifest) return undefined;
	const tools = Array.isArray(manifest.lazyTools)
		? manifest.lazyTools
		: typeof manifest.lazy === "object" && Array.isArray(manifest.lazy.tools)
			? manifest.lazy.tools
			: undefined;
	return tools?.filter((tool) => tool && typeof tool.name === "string" && tool.name.trim());
}

function defaultLazyToolParameters(): ToolDefinition["parameters"] {
	return { type: "object", properties: {}, additionalProperties: false } as ToolDefinition["parameters"];
}

function lazyToolsForEntry(tools: LazyToolManifest[] | undefined, dir: string, entryPath: string, entryCount: number) {
	if (!tools?.length) return undefined;
	const selected = tools.filter((tool) => {
		if (typeof tool.extension !== "string" || !tool.extension.trim()) {
			return entryCount === 1;
		}
		return path.resolve(dir, tool.extension) === entryPath;
	});
	return selected.length > 0 ? selected : undefined;
}

function inferLazyToolsForExtensionPath(resolvedPath: string): LazyToolManifest[] | undefined {
	const dir = path.dirname(resolvedPath);
	const manifest = readPiManifest(path.join(dir, "package.json"));
	const lazyTools = getManifestLazyTools(manifest);
	if (!manifest?.extensions?.length || !lazyTools?.length) return undefined;
	const resolvedEntries = manifest.extensions.map((extPath) => path.resolve(dir, extPath));
	if (!resolvedEntries.includes(resolvedPath)) return undefined;
	return lazyToolsForEntry(lazyTools, dir, resolvedPath, resolvedEntries.length);
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const BUNDLED_EXTENSIONS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../bundled-resources/extensions",
);

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): ExtensionLoadSpec[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const resolvedEntries = manifest.extensions
				.map((extPath) => path.resolve(dir, extPath))
				.filter((resolvedExtPath) => fs.existsSync(resolvedExtPath));
			if (resolvedEntries.length > 0) {
				const lazyTools = getManifestLazyTools(manifest);
				return resolvedEntries.map((entryPath) => ({
					path: entryPath,
					lazyTools: lazyToolsForEntry(lazyTools, dir, entryPath, resolvedEntries.length),
				}));
			}
		}
	}

	// Check for index.ts or index.js
	const indexEntry = resolveExtensionIndexEntry(dir, BUNDLED_EXTENSIONS_ROOT);
	if (indexEntry) return [{ path: indexEntry }];

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): ExtensionLoadSpec[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: ExtensionLoadSpec[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push({ path: entryPath });
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: ExtensionLoadSpec[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: Array<string | ExtensionLoadSpec>) => {
		for (const spec of paths) {
			const normalized = typeof spec === "string" ? { path: spec } : spec;
			const resolved = path.resolve(normalized.path);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(normalized);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus, { agentDir: resolvedAgentDir });
}
