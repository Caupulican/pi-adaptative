/**
 * Extension runtime binding: the boundary between {@link AgentSession} and the {@link
 * ExtensionRunner} it hosts. Owns the public `bindExtensions()` entry point (stores the
 * host-supplied UI/mode/callback bindings, applies them to the runner, fires the session-start
 * event, discovers extension-contributed resources, and initializes memory), the resource
 * discovery pass that turns extension-reported skill/prompt/theme paths into labeled {@link
 * ResourceExtensionPaths}, and `bindExtensionCore` — the ~30-method translation of the session's
 * own public surface (send message, set model, compact, abort, reload, …) into the `ExtensionActions`
 * / `ExtensionContextActions` shape `ExtensionRunner.bindCore` expects.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). All logic here is pure code
 * motion — no behavior changes. State that other collaborators (RuntimeBuilder, LocalRuntimeController,
 * HumanInputController) also read (`_extensionUIContext`, `_extensionMode`, `_extensionCommandContextActions`,
 * `_extensionShutdownHandler`, `_extensionErrorListener`) stays host-owned and is reached through the
 * same get/set deps accessors those collaborators already use; `_extensionAbortHandler` and the
 * error-unsubscribe callback are touched only within this binding boundary, so they are owned here.
 *
 * Host-binding boundary note (see runtime-builder.ts): `bindExtensionCore` exposes session identity
 * to the extension runner, not tool-registry build logic, which is why it lives in its own dedicated
 * module rather than inside RuntimeBuilder; RuntimeBuilder still invokes it (and `applyExtensionBindings`
 * / `extendResourcesFromExtensions`) through {@link RuntimeBuilderDeps}, one level further delegated.
 */

import { basename, dirname } from "node:path";
import type { Agent, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { CustomMessage } from "@caupulican/pi-agent-core/messages";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, ImageContent, Model, TextContent, Usage } from "@caupulican/pi-ai";
import type { ExtensionBindings } from "./agent-session-contracts.ts";
import type { MemoryProvider as ContextMemoryProvider } from "./context/memory-provider-contract.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	SessionStartEvent,
	ShutdownHandler,
	ToolInfo,
} from "./extensions/index.ts";
import type { ManagedLaneEvent } from "./extensions/types.ts";
import type { MemoryProvider } from "./memory/memory-provider.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";

export interface ExtensionBindingControllerDeps {
	getAgent(): Agent;
	getExtensionRunner(): ExtensionRunner;
	getSessionStartEvent(): SessionStartEvent;
	getCwd(): string;
	getResourceLoader(): ResourceLoader;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	getModel(): Model<Api> | undefined;
	getActiveToolNames(): string[];
	getAllTools(): ToolInfo[];
	setActiveToolsByName(toolNames: string[]): void;
	refreshToolRegistry(): void;
	rebuildSystemPrompt(toolNames: string[]): string;
	setBaseSystemPrompt(prompt: string): void;
	getPromptTemplates(): ReadonlyArray<PromptTemplate>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	setModel(model: Model<Api>): Promise<void>;
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; processSlashCommands?: boolean },
	): Promise<void>;
	setSessionName(name: string): void;
	registerMemoryProvider(provider: MemoryProvider): void;
	registerContextMemoryProvider(provider: ContextMemoryProvider): void;
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	recordManagedLane(event: ManagedLaneEvent): void;
	isForegroundBusy(): boolean;
	getPendingMessageCount(): number;
	isStreaming(): boolean;
	isCompacting(): boolean;
	getContextUsage(): ContextUsage | undefined;
	compactForExtension(options?: CompactOptions): void;
	reload(): Promise<void>;
	abort(): Promise<void>;
	getSystemPrompt(): string;
	getExtensionCommandContextActions(): ExtensionCommandContextActions | undefined;
	refreshCurrentModelFromRegistry(): void;
	initializeMemory(): Promise<void>;
	getExtensionUIContext(): ExtensionUIContext | undefined;
	setExtensionUIContext(uiContext: ExtensionUIContext | undefined): void;
	getExtensionMode(): ExtensionContext["mode"];
	setExtensionMode(mode: ExtensionContext["mode"]): void;
	setExtensionCommandContextActions(actions: ExtensionCommandContextActions | undefined): void;
	getExtensionShutdownHandler(): ShutdownHandler | undefined;
	setExtensionShutdownHandler(handler: ShutdownHandler | undefined): void;
	getExtensionErrorListener(): ExtensionErrorListener | undefined;
	setExtensionErrorListener(listener: ExtensionErrorListener | undefined): void;
}

export class ExtensionBindingController {
	private readonly deps: ExtensionBindingControllerDeps;
	private extensionAbortHandler?: () => void;
	private extensionErrorUnsubscriber?: () => void;

	constructor(deps: ExtensionBindingControllerDeps) {
		this.deps = deps;
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this.deps.setExtensionUIContext(bindings.uiContext);
		}
		if (bindings.mode !== undefined) {
			this.deps.setExtensionMode(bindings.mode);
		}
		if (bindings.commandContextActions !== undefined) {
			this.deps.setExtensionCommandContextActions(bindings.commandContextActions);
		}
		if (bindings.abortHandler !== undefined) {
			this.extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this.deps.setExtensionShutdownHandler(bindings.shutdownHandler);
		}
		if (bindings.onError !== undefined) {
			this.deps.setExtensionErrorListener(bindings.onError);
		}

		this.applyExtensionBindings(this.deps.getExtensionRunner());
		await this.deps.getExtensionRunner().emit(this.deps.getSessionStartEvent());
		await this.extendResourcesFromExtensions(
			this.deps.getSessionStartEvent().reason === "reload" ? "reload" : "startup",
		);
		// Initialize the memory subsystem after extensions have had a chance to register providers.
		await this.deps.initializeMemory();
	}

	async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		const runner = this.deps.getExtensionRunner();
		if (!runner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await runner.emitResourcesDiscover(this.deps.getCwd(), reason);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this.deps.getResourceLoader().extendResources(extensionPaths);
		const rebuiltSystemPrompt = this.deps.rebuildSystemPrompt(this.deps.getActiveToolNames());
		this.deps.setBaseSystemPrompt(rebuiltSystemPrompt);
		this.deps.getAgent().state.systemPrompt = rebuiltSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this.deps.getExtensionUIContext());
		runner.setMode(this.deps.getExtensionMode());
		runner.bindCommandContext(this.deps.getExtensionCommandContextActions());

		this.extensionErrorUnsubscriber?.();
		const errorListener = this.deps.getExtensionErrorListener();
		this.extensionErrorUnsubscriber = errorListener ? runner.onError(errorListener) : undefined;
	}

	bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.deps.getPromptTemplates().map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this.deps
				.getResourceLoader()
				.getActiveSkills()
				.map((skill) => ({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.deps.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.deps.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.deps.getSessionManager().appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.deps.setSessionName(name);
				},
				getSessionName: () => {
					return this.deps.getSessionManager().getSessionName();
				},
				setLabel: (entryId, label) => {
					this.deps.getSessionManager().appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.deps.getActiveToolNames(),
				getAllTools: () => this.deps.getAllTools(),
				setActiveTools: (toolNames) => this.deps.setActiveToolsByName(toolNames),
				refreshTools: () => this.deps.refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.deps.getModelRegistry().hasConfiguredAuth(model)) return false;
					await this.deps.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.deps.getThinkingLevel(),
				setThinkingLevel: (level) => this.deps.setThinkingLevel(level),
				getExternalResourceRoots: () => this.deps.getSettingsManager().getEffectiveExternalResourceRoots(),
				registerMemoryProvider: (provider) => this.deps.registerMemoryProvider(provider),
				registerContextMemoryProvider: (provider) => this.deps.registerContextMemoryProvider(provider),
				reportSpawnedUsage: (usage, opts) => {
					this.deps.addSpawnedUsage(usage, opts);
				},
				reportManagedLane: (event) => {
					this.deps.recordManagedLane(event);
				},
			},
			{
				getModel: () => this.deps.getModel(),
				isIdle: () => !this.deps.isForegroundBusy(),
				getSignal: () => this.deps.getAgent().signal,
				abort: () => {
					if (this.extensionAbortHandler) {
						this.extensionAbortHandler();
						return;
					}
					void this.deps.abort();
				},
				hasPendingMessages: () => this.deps.getPendingMessageCount() > 0,
				shutdown: () => {
					this.deps.getExtensionShutdownHandler()?.();
				},
				getContextUsage: () => this.deps.getContextUsage(),
				compact: (options) => this.deps.compactForExtension(options),
				reload: () => {
					if (this.deps.isStreaming()) {
						return Promise.reject(
							new Error(
								"ctx.reload() cannot run while the agent is streaming or a tool call is active. Wait for ctx.isIdle(), queue a follow-up /reload, or use an idle command/event handler so hot reload cannot destabilize the UI.",
							),
						);
					}
					if (this.deps.isCompacting()) {
						return Promise.reject(
							new Error(
								"ctx.reload() cannot run during context compaction or branch summarization. Let compaction finish before reloading so the session tree and UI remain stable.",
							),
						);
					}
					const actions = this.deps.getExtensionCommandContextActions();
					if (!actions) {
						return this.deps.reload();
					}
					return actions.reload();
				},
				getSystemPrompt: () => this.deps.getSystemPrompt(),
			},
			{
				registerProvider: (name, config) => {
					this.deps.getModelRegistry().registerProvider(name, config);
					this.deps.refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this.deps.getModelRegistry().unregisterProvider(name);
					this.deps.refreshCurrentModelFromRegistry();
				},
			},
		);
	}
}
