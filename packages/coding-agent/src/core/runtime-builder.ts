/**
 * Runtime build & reload: the session's tool-registry assembly and the self-modification-safe
 * extension reload path. Owns building the base tool definitions, wrapping them into the live tool
 * registry (`_refreshToolRegistry`), constructing the {@link ExtensionRunner} for a rebuilt runtime
 * (`_buildRuntime`), and the repo's self-modification safety crown jewel: the preflight-guarded
 * `reload()` with its snapshot / doctor / commit-or-rollback sequence, plus the single-extension
 * live load/unload/reconcile operations that rebuild the runtime in place.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns ONLY the tool-registry
 * state — the base tool definitions, the wrapped tool registry, the definition registry, and the
 * per-tool prompt snippet/guideline maps. Everything else the build & reload touch — the live
 * {@link ExtensionRunner}, the agent's tool/system-prompt state, the base system prompt, the
 * resource loader, the session/settings managers, the model registry, the profile tool filter and
 * its warning sinks, the requested-active-tool-names request, the memory subsystem, and the many
 * host callbacks the rebuilt tools/runtime are wired to — is reached through narrow deps accessors
 * that read and write the SAME storage the host owns today.
 *
 * Snapshot-ownership boundary (deliberate, load-bearing for reload safety): the reload snapshot
 * spans state owned by OTHER collaborators — the extension runner and its ref, `agent.state.tools`
 * / `agent.state.systemPrompt`, and `_baseSystemPrompt`. Those are captured and restored through
 * {@link RuntimeBuilderDeps} get/set accessors so save/restore mutate exactly the host/agent fields
 * they mutated before extraction; only the five tool-registry maps are captured by direct field
 * reference here (this builder owns them). The `_extensionRunnerRef.current` update folds into
 * {@link RuntimeBuilderDeps.setExtensionRunner} (the same field-then-ref pattern the host used at
 * every assignment site), so no observer runs between the two writes.
 *
 * Host-binding boundary (deliberate): `_bindExtensionCore` — which exposes the SESSION's own public
 * surface (sendMessage, setModel, compact, abort, reload, …) to the extension runner — stays
 * host-side and is invoked from {@link buildRuntime} via {@link RuntimeBuilderDeps.bindExtensionCore};
 * it is host identity, not build logic, and moving it would only re-export ~30 host methods through
 * deps to hand them straight back. The host keeps one-line delegations for the public reload /
 * load / unload / reconcile API and for `getAllTools` / `getToolDefinition`, and a private
 * `_refreshToolRegistry` delegation for its internal callers.
 */

import type { Agent, AgentContext, AgentMessage, AgentTool } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { resetApiProviders } from "@caupulican/pi-ai";
import type {
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "./agent-session.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { MemoryPromptInclusionReport, MemoryRetrievalDiagnostics } from "./context/memory-diagnostics.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { createCoreDiagnosticsToolDefinitions } from "./extensions/builtin.ts";
import {
	type ContextUsage,
	type Extension,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolInfo,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { disposeExtensionEventSubscriptions } from "./extensions/loader.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileFilterSettings,
	type SettingsManager,
} from "./settings-manager.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	buildReflexUserPrompt,
	parseReflexPlan,
	REFLEX_INTERPRETER_SYSTEM_PROMPT,
} from "./toolkit/reflex-interpreter.ts";
import { executeToolkitScript } from "./toolkit/script-runner.ts";
import { createDelegateToolDefinition } from "./tools/delegate.ts";
import { createGoalToolDefinition } from "./tools/goal.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createModelFitnessToolDefinition } from "./tools/model-fitness.ts";
import { createRunToolkitScriptToolDefinition } from "./tools/run-toolkit-script.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface ReloadRuntimeSnapshot {
	extensionRunner: ExtensionRunner;
	baseToolDefinitions: Map<string, ToolDefinition>;
	toolRegistry: Map<string, AgentTool>;
	toolDefinitions: Map<string, ToolDefinitionEntry>;
	toolPromptSnippets: Map<string, string>;
	toolPromptGuidelines: Map<string, string[]>;
	agentTools: AgentTool[];
	agentSystemPrompt: string;
	baseSystemPrompt: string;
}

export interface RuntimeBuilderDeps {
	/** Live agent — the snapshot/doctor read and restore its `state.tools` / `state.systemPrompt`. */
	getAgent(): Agent;
	/** Workspace root, passed to the tool-definition factory and the extension runner. */
	getCwd(): string;
	/** Session log, passed to the extension runner. */
	getSessionManager(): SessionManager;
	/** Tool/shell/toolkit/resource settings + reload target (settingsManager.reload()). */
	getSettingsManager(): SettingsManager;
	/** Model registry, passed to the extension runner and profile model re-resolution. */
	getModelRegistry(): ModelRegistry;
	/** Extension/skill/prompt/theme discovery + the reload/commit/rollback generation swap. */
	getResourceLoader(): ResourceLoader;

	/** Live extension runner (host-owned; pervasive). */
	getExtensionRunner(): ExtensionRunner;
	/** Store the extension runner AND update the Agent's mutable `_extensionRunnerRef.current` (both together). */
	setExtensionRunner(runner: ExtensionRunner): void;
	/** Base (extension-free) system prompt; captured/restored by the reload snapshot. */
	getBaseSystemPrompt(): string;
	setBaseSystemPrompt(prompt: string): void;

	/** SDK-provided plain tools, synthesized into the registry alongside built-ins. */
	getCustomTools(): ToolDefinition[];
	/** Optional plain-tool override; when set, the built-in factory + core diagnostics are skipped. */
	getBaseToolsOverride(): Record<string, AgentTool> | undefined;
	/** Pre-filter tool REQUEST (never the capability/profile-filtered active set) preserved across a rebuild. */
	getRequestedActiveToolNames(): string[] | undefined;
	setRequestedActiveToolNames(names: string[] | undefined): void;

	/** Resource-profile tool allow/block filter + the raw allow/exclude sets applied during registry build. */
	getToolProfileFilter(): Required<ResourceProfileFilterSettings> | undefined;
	setToolProfileFilter(filter: Required<ResourceProfileFilterSettings> | undefined): void;
	getAllowedToolNames(): Set<string> | undefined;
	getExcludedToolNames(): Set<string> | undefined;
	/** Re-derive the profile tool filter from freshly reloaded settings (reload only). */
	deriveToolProfileFilter(): Required<ResourceProfileFilterSettings>;
	/** True when a tool/command name survives the active profile's allow/block + user allow/exclude. */
	isToolOrCommandAllowedByProfile(name: string): boolean;
	/** Filter the loaded extensions through the active resource profile (records inert/denied warnings host-side). */
	filterExtensionsForRuntime(extensions: Extension[]): Extension[];
	/** Sink for the G13 unbound-profile-tool-grant warnings surfaced in /context. */
	setUnboundToolGrantWarnings(warnings: string[]): void;

	/** Currently-active tool names (reads agent.state.tools; the pre-filter fallback for a rebuild). */
	getActiveToolNames(): string[];
	/** Apply the recomputed active set (capability filter + companion auto-activation live here). */
	setActiveToolsByName(toolNames: string[]): void;
	/** Normalize a tool's prompt snippet / guidelines through the system-prompt builder. */
	normalizePromptSnippet(text: string | undefined): string | undefined;
	normalizePromptGuidelines(guidelines: string[] | undefined): string[];

	/** Wire the session's own public surface into a freshly-built runner (host identity; stays host-side). */
	bindExtensionCore(runner: ExtensionRunner): void;
	/** Re-apply UI context / mode / command-context / error subscription to a runner. */
	applyExtensionBindings(runner: ExtensionRunner): void;
	/** Re-run resource discovery for the active extensions (reload only). */
	extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void>;
	/** Re-apply the active profile's model/thinking from reloaded settings (reload only). */
	reapplyActiveProfileModelSettings(): Promise<void>;
	/** Notify extensions-changed listeners after a single-extension live op. */
	notifyExtensionsChanged(): void;

	/** Session-scoped tool-output artifact store for grep/find/artifact_retrieve (gated on the profile). */
	getToolArtifactStore(): ArtifactStore;

	/** Live memory manager — its provider tools join the registry. */
	getMemoryManager(): MemoryManager;
	/** Memory retrieval + prompt-inclusion diagnostics for the core diagnostics tool. */
	getMemoryAuditDiagnostics(): { retrieval: MemoryRetrievalDiagnostics; promptInclusion: MemoryPromptInclusionReport };
	/** Drop extension-contributed pending memory providers before a reload re-registers them. */
	clearPendingMemoryProviders(): void;
	/** (Re)derive the memory subsystem from reloaded settings/providers. */
	initializeMemory(): Promise<void>;

	/** Goal-tool state accessors. */
	getGoalStateSnapshot(): GoalState | undefined;
	saveGoalStateSnapshot(state: GoalState): string;
	/** Context-gc report for the core diagnostics tool. */
	getContextGcReport(messages: AgentMessage[]): ContextGcReport;
	/** Worker-delegation runner for the delegate tool. */
	runWorkerDelegationOnce(request: {
		instructions: string;
		systemPrompt?: string;
	}): Promise<WorkerDelegationRunOutcome>;
	/** Model-fitness probe for the model_fitness tool. */
	runModelFitness(args: {
		model: string;
		trials?: number;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }>;
	/** Fitness-gated reflex-brain model resolver (run_toolkit_script interpretation). */
	resolveCurationModelIfFit(): Model<Api> | undefined;
	/** One-shot, tool-less LLM call — the reflex-brain interpreter rides this. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Roll reflex-brain spend into spawned-usage accounting. */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;

	/** Post-rebuild doctor helpers (validate the rebuilt runtime can render a context). */
	createAgentContextSnapshot(): AgentContext;
	getContextUsage(): ContextUsage | undefined;

	/** Reload/live-op preflight refusal guards (identical refusal behavior; host-checked). */
	isStreaming(): boolean;
	isCompacting(): boolean;

	/** Extension bindings present — gate for re-emitting session_start on reload. */
	getExtensionUIContext(): ExtensionUIContext | undefined;
	getExtensionCommandContextActions(): ExtensionCommandContextActions | undefined;
	getExtensionShutdownHandler(): ShutdownHandler | undefined;
	getExtensionErrorListener(): ExtensionErrorListener | undefined;
}

/**
 * Owns the tool-registry build and the self-modification-safe extension reload extracted from
 * {@link AgentSession}. See the module header for the snapshot-ownership and host-binding boundaries.
 */
export class RuntimeBuilder {
	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();

	private readonly deps: RuntimeBuilderDeps;

	constructor(deps: RuntimeBuilderDeps) {
		this.deps = deps;
	}

	/** Whether a tool name is present in the live wrapped registry. */
	hasTool(name: string): boolean {
		return this._toolRegistry.has(name);
	}

	/** The live wrapped tool for a name, if registered (activation lookup). */
	getRegisteredTool(name: string): AgentTool | undefined {
		return this._toolRegistry.get(name);
	}

	/** A registered tool's normalized prompt snippet, if any. */
	getToolPromptSnippet(name: string): string | undefined {
		return this._toolPromptSnippets.get(name);
	}

	/** A registered tool's normalized prompt guidelines, if any. */
	getToolPromptGuidelines(name: string): string[] | undefined {
		return this._toolPromptGuidelines.get(name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		// Re-derive from the pre-filter REQUEST, never from agent.state.tools: the active set is
		// capability/profile-filtered, so feeding it back through setActiveToolsByName would
		// permanently shrink what a later switch to a larger model (or permissive profile) restores.
		const previousActiveToolNames = this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames();
		const allowedToolNames = this.deps.getAllowedToolNames();
		const excludedToolNames = this.deps.getExcludedToolNames();
		const toolProfileFilter = this.deps.getToolProfileFilter();
		const isAllowedTool = (name: string): boolean => {
			if (allowedToolNames && !allowedToolNames.has(name)) return false;
			if (excludedToolNames?.has(name)) return false;
			if (!toolProfileFilter) return true;
			if (toolProfileFilter.allow.length > 0 && !matchesResourceProfilePattern(name, toolProfileFilter.allow)) {
				return false;
			}
			if (matchesResourceProfilePattern(name, toolProfileFilter.block)) return false;
			return true;
		};

		const registeredTools = this.deps.getExtensionRunner().getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this.deps.getCustomTools().map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
			// Memory subsystem provider tools (e.g. file-store's `memory` tool).
			...this.deps
				.getMemoryManager()
				.getToolDefinitions()
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<memory:${definition.name}>`, { source: "sdk" }),
				})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this.deps.normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this.deps.normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this.deps.getExtensionRunner();
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const requestedBase = options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames];
		const nextActiveToolNames = requestedBase.filter((name) => isAllowedTool(name));

		const autoActivated: string[] = [];
		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
				autoActivated.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
		}

		// Strict UAC: the active profile is the COMPLETE grant, so a tool the profile names
		// explicitly is itself a request for that tool — it must ACTIVATE from the registry even
		// if the session never requested it. Without this, activation is only ever the requested
		// defaults ∩ allow-list, and a profile granting non-default tools (a search-only profile's
		// grep/find) yields an empty or truncated tool set on load and /reload. A blanket "*"
		// stays grant-only: activation then still derives from the request/defaults above.
		const explicitAllowPatterns = toolProfileFilter?.allow.filter((pattern) => pattern !== "*") ?? [];
		if (explicitAllowPatterns.length > 0) {
			const boundPatterns = new Set<string>();
			for (const toolName of this._toolRegistry.keys()) {
				if (!isAllowedTool(toolName)) continue;
				for (const pattern of explicitAllowPatterns) {
					if (matchesResourceProfilePattern(toolName, [pattern])) boundPatterns.add(pattern);
				}
				if (matchesResourceProfilePattern(toolName, explicitAllowPatterns)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
			// G13: an explicit grant that binds to NO registered tool is a silent no-op — typo'd
			// name, or the owning extension is not granted/loaded. Surface it.
			this.deps.setUnboundToolGrantWarnings(
				explicitAllowPatterns
					.filter((pattern) => !boundPatterns.has(pattern))
					.map(
						(pattern) =>
							`profile tool grant "${pattern}" binds to no registered tool (typo, or the owning extension is not granted/loaded)`,
					),
			);
		} else {
			this.deps.setUnboundToolGrantWarnings([]);
		}

		// artifact_retrieve companion auto-activation is enforced inside
		// setActiveToolsByName() itself (not duplicated here), so every activation path --
		// including the public, extension-exposed setActiveTools() -- gets the same
		// guarantee, not just this settings/profile refresh flow.
		this.deps.setActiveToolsByName([...new Set(nextActiveToolNames)]);
		// setActiveToolsByName just stored the profile-filtered ACTIVE set as the request; restore
		// the true pre-filter request (plus this refresh's auto-activations) so an internal refresh
		// can never permanently narrow it.
		this.deps.setRequestedActiveToolNames([...new Set([...requestedBase, ...autoActivated])]);
	}

	private _createReloadRuntimeSnapshot(): ReloadRuntimeSnapshot {
		const agent = this.deps.getAgent();
		return {
			extensionRunner: this.deps.getExtensionRunner(),
			baseToolDefinitions: this._baseToolDefinitions,
			toolRegistry: this._toolRegistry,
			toolDefinitions: this._toolDefinitions,
			toolPromptSnippets: this._toolPromptSnippets,
			toolPromptGuidelines: this._toolPromptGuidelines,
			agentTools: agent.state.tools,
			agentSystemPrompt: agent.state.systemPrompt,
			baseSystemPrompt: this.deps.getBaseSystemPrompt(),
		};
	}

	private _restoreReloadRuntimeSnapshot(snapshot: ReloadRuntimeSnapshot): void {
		// setExtensionRunner restores both _extensionRunner and _extensionRunnerRef.current together
		// (the same field-then-ref pair the host wrote at every assignment site); nothing reads the
		// ref between the two writes, so folding them is unobservable.
		this.deps.setExtensionRunner(snapshot.extensionRunner);
		this._baseToolDefinitions = snapshot.baseToolDefinitions;
		this._toolRegistry = snapshot.toolRegistry;
		this._toolDefinitions = snapshot.toolDefinitions;
		this._toolPromptSnippets = snapshot.toolPromptSnippets;
		this._toolPromptGuidelines = snapshot.toolPromptGuidelines;
		const agent = this.deps.getAgent();
		agent.state.tools = snapshot.agentTools;
		agent.state.systemPrompt = snapshot.agentSystemPrompt;
		this.deps.setBaseSystemPrompt(snapshot.baseSystemPrompt);
		this.deps.applyExtensionBindings(snapshot.extensionRunner);
	}

	private _doctorReloadRuntime(): void {
		const extensionErrors = this.deps.getResourceLoader().getExtensions().errors;
		if (extensionErrors.length > 0) {
			const summary = extensionErrors
				.slice(0, 6)
				.map((error) => `${error.path}: ${error.error}`)
				.join("; ");
			throw new Error(`Extension reload failed doctor: ${summary}`);
		}

		const missingActiveTools = this.deps.getActiveToolNames().filter((name) => !this._toolRegistry.has(name));
		if (missingActiveTools.length > 0) {
			throw new Error(
				`Extension reload failed doctor: active tool(s) missing after reload: ${missingActiveTools.join(", ")}`,
			);
		}

		for (const tool of this.deps.getAgent().state.tools) {
			if (!this._toolDefinitions.has(tool.name)) {
				throw new Error(`Extension reload failed doctor: tool ${tool.name} missing from definition registry`);
			}
		}

		this.deps.createAgentContextSnapshot();
		this.deps.getContextUsage();
	}

	buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const settingsManager = this.deps.getSettingsManager();
		const autoResizeImages = settingsManager.getImageAutoResize();
		const shellCommandPrefix = settingsManager.getShellCommandPrefix();
		const shellPath = settingsManager.getShellPath();
		const baseToolsOverride = this.deps.getBaseToolsOverride();
		// grep/find must not emit a "Full output: artifact tool-output:<id>" handle that
		// nothing can resolve. If artifact_retrieve is explicitly excluded/blocked/outside
		// an active allowlist, don't hand grep/find an artifact store at all: they fall
		// back to their pre-existing bounded preview/truncation behavior, with no
		// payload/meta files ever written and no retrieval promise made.
		const toolArtifactStore = this.deps.isToolOrCommandAllowedByProfile("artifact_retrieve")
			? this.deps.getToolArtifactStore()
			: undefined;
		const baseToolDefinitions = baseToolsOverride
			? Object.fromEntries(
					Object.entries(baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
				)
			: createAllToolDefinitions(this.deps.getCwd(), {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
					grep: { artifactStore: toolArtifactStore },
					find: { artifactStore: toolArtifactStore },
					artifact_retrieve: { artifactStore: toolArtifactStore },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		if (!baseToolsOverride) {
			for (const definition of createCoreDiagnosticsToolDefinitions(
				() => this.deps.getActiveToolNames(),
				() => this.getAllTools(),
				(messages) => this.deps.getContextGcReport(messages),
				() => this.deps.getMemoryAuditDiagnostics(),
			)) {
				this._baseToolDefinitions.set(definition.name, definition);
			}
			const goalToolDefinition = createGoalToolDefinition({
				getGoalState: () => this.deps.getGoalStateSnapshot(),
				saveGoalState: (state) => {
					this.deps.saveGoalStateSnapshot(state);
				},
			});
			this._baseToolDefinitions.set(goalToolDefinition.name, goalToolDefinition);
			const delegateToolDefinition = createDelegateToolDefinition({
				runWorkerDelegation: (args) => this.deps.runWorkerDelegationOnce(args),
			});
			this._baseToolDefinitions.set(delegateToolDefinition.name, delegateToolDefinition);
			// Registered but not default-active: probes spend tokens on the probed model, so
			// activation is an explicit choice (settings/profile/setActiveTools or /autonomy fitness).
			const modelFitnessToolDefinition = createModelFitnessToolDefinition({
				runProbe: (args) => this.deps.runModelFitness(args),
			});
			this._baseToolDefinitions.set(modelFitnessToolDefinition.name, modelFitnessToolDefinition);
			const runToolkitScriptToolDefinition = createRunToolkitScriptToolDefinition({
				getScripts: () => this.deps.getSettingsManager().getToolkitScripts(),
				execute: (script, scriptArgs) => executeToolkitScript({ script, scriptArgs, cwd: this.deps.getCwd() }),
				// Reflex brain (fitness-gated local model): resolves ambiguous requests into a
				// registry pick. Best-effort — absent/unfit brain keeps the shortlist behavior.
				interpret: async (request, scripts) => {
					const model = this.deps.resolveCurationModelIfFit();
					if (!model) return undefined;
					const completion = await this.deps.runIsolatedCompletion({
						systemPrompt: REFLEX_INTERPRETER_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildReflexUserPrompt(request, scripts) }],
								timestamp: Date.now(),
							},
						],
						model,
						thinkingLevel: "off",
						maxTokens: 256,
						cacheRetention: "short",
					});
					if (completion.usage.cost.total > 0 || completion.usage.totalTokens > 0) {
						this.deps.addSpawnedUsage(completion.usage, { label: "toolkit-brain" });
					}
					return parseReflexPlan(completion.text);
				},
			});
			this._baseToolDefinitions.set(runToolkitScriptToolDefinition.name, runToolkitScriptToolDefinition);
		}

		const extensionsResult = this.deps.getResourceLoader().getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		const extensions = this.deps.filterExtensionsForRuntime(extensionsResult.extensions);
		const runtimeExtensionPaths = new Set(extensions.map((extension) => extension.path));
		extensionsResult.runtime.pendingProviderRegistrations =
			extensionsResult.runtime.pendingProviderRegistrations.filter((registration) =>
				runtimeExtensionPaths.has(registration.extensionPath),
			);

		const runner = new ExtensionRunner(
			extensions,
			extensionsResult.runtime,
			this.deps.getCwd(),
			this.deps.getSessionManager(),
			this.deps.getModelRegistry(),
		);
		this.deps.setExtensionRunner(runner);
		this.deps.bindExtensionCore(runner);
		this.deps.applyExtensionBindings(runner);

		const defaultActiveToolNames = baseToolsOverride
			? Object.keys(baseToolsOverride)
			: ["read", "bash", "edit", "write", "context_audit", "goal", "delegate", "run_toolkit_script"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this.refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		if (this.deps.isStreaming()) {
			throw new Error("Cannot reload while the agent is streaming or a tool call is active");
		}
		if (this.deps.isCompacting()) {
			throw new Error("Cannot reload while context compaction or branch summarization is active");
		}
		const previousRunner = this.deps.getExtensionRunner();
		const snapshot = this._createReloadRuntimeSnapshot();
		// Preserve the pre-filter tool REQUEST across the rebuild, not the capability/profile-filtered
		// active set — otherwise a reload under a small model permanently shrinks the restorable set.
		const activeToolNames = this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames();
		const previousFlagValues = previousRunner.getFlagValues();
		const reloadErrors: string[] = [];
		let newRunner: ExtensionRunner | undefined;
		try {
			await this.deps.getSettingsManager().reload();
			// Re-derive the resource-profile tool filter from the freshly reloaded settings.
			// Unlike skills/prompts/themes (which re-filter through the resource loader on every
			// reload), the tool filter is held on the session, so without this a live edit to the
			// active profile's tools allow/block — or switching the active profile — would not
			// apply on /reload and allowed tools would stay missing.
			this.deps.setToolProfileFilter(this.deps.deriveToolProfileFilter());
			// Re-apply the active profile's model/thinking from the freshly reloaded settings, so a live
			// profile edit (or switch) takes effect on /reload. Skipped when the launch used an explicit
			// --model/--thinking flag, which must win over the profile across reloads.
			await this.deps.reapplyActiveProfileModelSettings();
			await this.deps.getResourceLoader().reload({ failOnExtensionErrors: true, deferExtensionDispose: true });
			resetApiProviders();
			this.buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
			newRunner = this.deps.getExtensionRunner();
			const offDoctorErrors = newRunner.onError((error) => {
				reloadErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`);
			});
			try {
				this._doctorReloadRuntime();
				// Reload starts memory providers fresh; loaded extensions re-register below.
				this.deps.clearPendingMemoryProviders();
				const hasBindings =
					this.deps.getExtensionUIContext() ||
					this.deps.getExtensionCommandContextActions() ||
					this.deps.getExtensionShutdownHandler() ||
					this.deps.getExtensionErrorListener();
				if (hasBindings) {
					await newRunner.emit({ type: "session_start", reason: "reload" });
					await this.deps.extendResourcesFromExtensions("reload");
					this._doctorReloadRuntime();
				}
			} finally {
				offDoctorErrors();
			}
			if (reloadErrors.length > 0) {
				throw new Error(`Extension reload failed doctor: ${reloadErrors.slice(0, 6).join("; ")}`);
			}
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });
			previousRunner.invalidate();
			this.deps.getResourceLoader().commitReload?.();
			// Re-derive the memory subsystem from the reloaded settings/providers.
			await this.deps.initializeMemory();
		} catch (error) {
			if (newRunner && newRunner !== previousRunner) {
				newRunner.invalidate(
					"This extension ctx was discarded because reload failed and Pi restored the previous valid runtime.",
				);
			}
			this.deps.getResourceLoader().rollbackReload?.();
			this._restoreReloadRuntimeSnapshot(snapshot);
			throw error;
		}
	}

	/**
	 * Unload a single extension without full reload.
	 * Runs the extension's session_shutdown lifecycle, unregisters its providers,
	 * disposes its event subscriptions, and rebuilds the runtime.
	 * Falls back to full reload on error.
	 */
	async unloadExtensionLive(extensionPath: string): Promise<void> {
		if (this.deps.isStreaming()) {
			throw new Error("Cannot unload extension while the agent is streaming or a tool call is active");
		}
		if (this.deps.isCompacting()) {
			throw new Error("Cannot unload extension while context compaction or branch summarization is active");
		}

		const ext = this.deps.getResourceLoader().getLoadedExtension(extensionPath);
		if (!ext) {
			return; // Nothing to unload
		}

		const previousRunner = this.deps.getExtensionRunner();
		try {
			// Run session_shutdown lifecycle for this extension only
			await this.deps.getExtensionRunner().emitToExtension(ext, { type: "session_shutdown", reason: "unload" });

			// Unregister its providers (keyed by the extension's own path, as registered)
			const runtime = this.deps.getResourceLoader().getExtensions().runtime;
			for (const name of runtime.getProvidersForExtension(ext.path)) {
				runtime.unregisterProvider(name, ext.path);
			}

			// Dispose its event subscriptions and run disposers
			await disposeExtensionEventSubscriptions([ext]);

			// Remove from loaded extensions
			this.deps.getResourceLoader().removeLoadedExtension(extensionPath);

			// Rebuild runtime with new extension set
			const activeToolNames = this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames();
			const previousFlagValues = previousRunner.getFlagValues();
			this.buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
			previousRunner.invalidate();

			// Notify extensions-changed listeners
			this.deps.notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
	}

	/**
	 * Load a single extension without full reload.
	 * Loads the extension with fresh import, rebuilds the runtime,
	 * and runs the extension's session_start lifecycle.
	 * Falls back to full reload on error.
	 */
	async loadExtensionLive(extensionPath: string): Promise<void> {
		if (this.deps.isStreaming()) {
			throw new Error("Cannot load extension while the agent is streaming or a tool call is active");
		}
		if (this.deps.isCompacting()) {
			throw new Error("Cannot load extension while context compaction or branch summarization is active");
		}

		const previousRunner = this.deps.getExtensionRunner();
		try {
			// Load the extension with fresh import
			const { extension, error } = await this.deps.getResourceLoader().loadSingleExtension(extensionPath);
			if (error || !extension) {
				throw new Error(error || `Failed to load extension: ${extensionPath}`);
			}

			// Rebuild runtime to aggregate tools/commands/handlers/providers
			const activeToolNames = this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames();
			const previousFlagValues = previousRunner.getFlagValues();
			this.buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});

			// Run session_start lifecycle for the new extension only
			await this.deps.getExtensionRunner().emitToExtension(extension, { type: "session_start", reason: "load" });

			// Notify extensions-changed listeners
			this.deps.notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
	}

	/**
	 * Reconcile loaded extensions with the active profile.
	 * Loads extensions that should be enabled but aren't, and unloads extensions that shouldn't be.
	 * Falls back to full reload if any individual load/unload fails.
	 */
	async reconcileLoadedExtensions(): Promise<void> {
		if (this.deps.isStreaming()) {
			throw new Error("Cannot reconcile extensions while the agent is streaming or a tool call is active");
		}
		if (this.deps.isCompacting()) {
			throw new Error("Cannot reconcile extensions while context compaction or branch summarization is active");
		}

		try {
			// Get all discoverable extension paths
			const allDiscoverablePaths = await this.deps.getResourceLoader().getDiscoverableExtensionPaths();

			// Get the target enabled set based on profile filters
			const targetEnabledSet = new Set<string>();
			for (const path of allDiscoverablePaths) {
				if (this.deps.getSettingsManager().isResourceAllowedByProfile("extensions", path)) {
					targetEnabledSet.add(path);
				}
			}

			// Get currently loaded set
			const loadedExtensions = this.deps.getResourceLoader().getExtensions().extensions;
			const loadedSet = new Set<string>();
			for (const ext of loadedExtensions) {
				loadedSet.add(ext.path);
			}

			// Collect unloads and loads
			const toUnload: string[] = [];
			const toLoad: string[] = [];

			for (const path of loadedSet) {
				if (!targetEnabledSet.has(path)) {
					toUnload.push(path);
				}
			}

			for (const path of targetEnabledSet) {
				if (!loadedSet.has(path)) {
					toLoad.push(path);
				}
			}

			// Apply unloads first, then loads, to minimize churn
			// Collect errors but continue through all operations
			const errors: Error[] = [];

			for (const path of toUnload) {
				try {
					await this.unloadExtensionLive(path);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}

			for (const path of toLoad) {
				try {
					await this.loadExtensionLive(path);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}

			// If any errors occurred, throw the first one (already fell back to full reload in load/unload)
			if (errors.length > 0) {
				throw errors[0];
			}

			// Single notification at the end
			this.deps.notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
	}
}
