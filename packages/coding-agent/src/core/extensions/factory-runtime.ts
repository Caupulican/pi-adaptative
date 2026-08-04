import * as path from "node:path";
import type { KeyId } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { disposeExtensionEventSubscriptions, isExtensionGenerationInactive } from "./lifecycle.ts";
import { DEFAULT_STALE_EXTENSION_CONTEXT_MESSAGE } from "./stale-context.ts";
import { createExtensionStorage } from "./storage.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

export const EXTENSION_FACTORY_TIMEOUT_MS = 30_000;

export class ExtensionFactoryTimeoutError extends Error {}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/** Create the shared pre-bind state used by both file-backed and inline extension factories. */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) throw new Error(state.staleMessage);
	};
	const providersByExtension = new Map<string, Set<string>>();
	const providerRegistrations = new Map<string, { config: ProviderConfig; extensionPath?: string }>();
	const memoryProvidersByExtension = new Map<string, Set<Parameters<ExtensionRuntime["registerMemoryProvider"]>[0]>>();
	const contextMemoryProvidersByExtension = new Map<
		string,
		Set<Parameters<ExtensionRuntime["registerContextMemoryProvider"]>[0]>
	>();
	const extensionStorageOwners = new Map<string, Extension>();
	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: notInitialized,
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		getExternalResourceRoots: notInitialized,
		registerMemoryProvider: notInitialized,
		registerContextMemoryProvider: notInitialized,
		reportSpawnedUsage: notInitialized,
		reportManagedLane: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??= message ?? DEFAULT_STALE_EXTENSION_CONTEXT_MESSAGE;
		},
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
				(entry) => entry.name !== name,
			);
		},
		providersByExtension,
		providerRegistrations,
		getProvidersForExtension: (extensionPath) => [...(providersByExtension.get(extensionPath) ?? [])],
		memoryProvidersByExtension,
		contextMemoryProvidersByExtension,
		extensionStorageOwners,
	};
	return runtime;
}

export function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);
	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		eventUnsubscribes: [],
		disposers: [],
	};
}

export function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
	agentDir: string,
): ExtensionAPI {
	const sharedRuntime = runtime;
	runtime = new Proxy(sharedRuntime, {
		get(target, property, receiver) {
			if (property === "assertActive") {
				return () => {
					target.assertActive();
					if (isExtensionGenerationInactive(extension)) {
						throw new Error(`Extension generation is no longer active: ${extension.path}`);
					}
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});

	return {
		getStorage(namespace: string) {
			runtime.assertActive();
			if (extension.storage) {
				if (extension.storage.namespace !== namespace) {
					throw new Error(
						`Extension ${extension.path} already owns storage namespace ${extension.storage.namespace}; cannot also use ${namespace}`,
					);
				}
				return extension.storage;
			}
			const storage = createExtensionStorage(agentDir, namespace, runtime.assertActive, (disposer) =>
				extension.disposers.push(disposer),
			);
			const previousOwner = runtime.extensionStorageOwners.get(namespace);
			if (previousOwner && previousOwner.path !== extension.path) {
				throw new Error(
					`Extension storage namespace ${namespace} is already owned by ${previousOwner.path}; ${extension.path} cannot also use it`,
				);
			}
			runtime.extensionStorageOwners.set(namespace, extension);
			extension.disposers.push(() => {
				if (runtime.extensionStorageOwners.get(namespace) !== extension) return;
				if (previousOwner && !isExtensionGenerationInactive(previousOwner)) {
					runtime.extensionStorageOwners.set(namespace, previousOwner);
				} else {
					runtime.extensionStorageOwners.delete(namespace);
				}
			});
			extension.storage = storage;
			return storage;
		},
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const handlers = extension.handlers.get(event) ?? [];
			handlers.push(handler);
			extension.handlers.set(event, handlers);
		},
		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo });
			runtime.refreshTools();
		},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, { name, sourceInfo: extension.sourceInfo, ...options });
		},
		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},
		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name))
				runtime.flagValues.set(name, options.default);
		},
		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},
		getFlag(name: string) {
			runtime.assertActive();
			return extension.flags.has(name) ? runtime.flagValues.get(name) : undefined;
		},
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},
		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},
		appendEntry(customType, data): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},
		setSessionName(name): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},
		getSessionName() {
			runtime.assertActive();
			return runtime.getSessionName();
		},
		setLabel(entryId, label): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		getActiveTools() {
			runtime.assertActive();
			return runtime.getActiveTools();
		},
		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},
		setActiveTools(toolNames): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},
		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},
		getExternalResourceRoots() {
			runtime.assertActive();
			return runtime.getExternalResourceRoots();
		},
		registerMemoryProvider(provider): void {
			runtime.assertActive();
			runtime.registerMemoryProvider(provider);
			const providers = runtime.memoryProvidersByExtension.get(extension.path) ?? new Set();
			providers.add(provider);
			runtime.memoryProvidersByExtension.set(extension.path, providers);
		},
		registerContextMemoryProvider(provider): void {
			runtime.assertActive();
			runtime.registerContextMemoryProvider(provider);
			const providers = runtime.contextMemoryProvidersByExtension.get(extension.path) ?? new Set();
			providers.add(provider);
			runtime.contextMemoryProvidersByExtension.set(extension.path, providers);
		},
		reportSpawnedUsage(usage, options): void {
			runtime.assertActive();
			runtime.reportSpawnedUsage(usage, options);
		},
		reportManagedLane(event): void {
			runtime.assertActive();
			runtime.reportManagedLane(event);
		},
		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},
		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},
		setThinkingLevel(level): void {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},
		registerProvider(name, config): void {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},
		unregisterProvider(name): void {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},
		onDispose(disposer): void {
			runtime.assertActive();
			extension.disposers.push(disposer);
		},
		events: {
			emit: (channel, data) => {
				runtime.assertActive();
				eventBus.emit(channel, data);
			},
			on: (channel, handler) => {
				runtime.assertActive();
				const unsubscribe = eventBus.on(channel, handler);
				extension.eventUnsubscribes.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;
}

export async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	timeoutMs: number = EXTENSION_FACTORY_TIMEOUT_MS,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const completion = Promise.resolve().then(() => factory(api));
	try {
		await Promise.race([
			completion,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new ExtensionFactoryTimeoutError(`Extension factory timed out after ${timeoutMs}ms`)),
					Math.max(0, timeoutMs),
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export interface ExtensionLoadRuntimeSnapshot {
	pendingProviderRegistrations: ExtensionRuntime["pendingProviderRegistrations"];
	flagValues: Map<string, boolean | string>;
	providerRegistrations: ExtensionRuntime["providerRegistrations"];
}

export function snapshotExtensionLoadRuntime(runtime: ExtensionRuntime): ExtensionLoadRuntimeSnapshot {
	return {
		pendingProviderRegistrations: [...runtime.pendingProviderRegistrations],
		flagValues: new Map(runtime.flagValues),
		providerRegistrations: new Map(runtime.providerRegistrations),
	};
}

export function restoreExtensionLoadRuntime(runtime: ExtensionRuntime, snapshot: ExtensionLoadRuntimeSnapshot): void {
	for (const [name, current] of runtime.providerRegistrations) {
		const previous = snapshot.providerRegistrations.get(name);
		if (!previous || previous.config !== current.config || previous.extensionPath !== current.extensionPath) {
			try {
				runtime.unregisterProvider(name, current.extensionPath);
			} catch {}
		}
	}
	for (const [name, previous] of snapshot.providerRegistrations) {
		const current = runtime.providerRegistrations.get(name);
		if (current?.config === previous.config && current.extensionPath === previous.extensionPath) continue;
		try {
			runtime.registerProvider(name, previous.config, previous.extensionPath);
		} catch {}
	}
	runtime.pendingProviderRegistrations = snapshot.pendingProviderRegistrations;
	runtime.flagValues.clear();
	for (const [name, value] of snapshot.flagValues) runtime.flagValues.set(name, value);
}

export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
	options: { factoryTimeoutMs?: number; agentDir?: string } = {},
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(options.agentDir ?? getAgentDir());
	const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus, resolvedAgentDir);
	const runtimeSnapshot = snapshotExtensionLoadRuntime(runtime);
	try {
		await runExtensionFactory(factory, api, options.factoryTimeoutMs);
	} catch (error) {
		await disposeExtensionEventSubscriptions([extension]);
		restoreExtensionLoadRuntime(runtime, runtimeSnapshot);
		throw error;
	}
	return extension;
}
