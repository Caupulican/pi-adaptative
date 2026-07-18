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

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent, AgentContext, AgentMessage, AgentTool, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type {
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "./agent-session.ts";
import type { WorkerResult } from "./autonomy/contracts.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { MemoryPromptInclusionReport, MemoryRetrievalDiagnostics } from "./context/memory-diagnostics.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES, mapToolNamesForPlatform } from "./default-tool-surface.ts";
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
import type { MemoryControllerReloadSnapshot } from "./memory-controller.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { evaluateSurfaceFitness } from "./model-router/fitness-gate.ts";
import { FitnessStore } from "./models/fitness-store.ts";
import type { ProfileFilterReloadSnapshot } from "./profile-filter-controller.ts";
import { describeInFlightWorkUnit, getInFlightWorkUnits } from "./reload-blockers.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { ScoutController } from "./scout-controller.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileFilterSettings,
	type SettingsManager,
} from "./settings-manager.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { TaskStepsState } from "./tasks/task-state.ts";
import {
	buildReflexUserPrompt,
	parseReflexPlan,
	REFLEX_INTERPRETER_SYSTEM_PROMPT,
} from "./toolkit/reflex-interpreter.ts";
import { executeToolkitScript } from "./toolkit/script-runner.ts";
import { createContextScoutToolDefinition } from "./tools/context-scout.ts";
import { createDelegateToolDefinition } from "./tools/delegate.ts";
import { createDelegateStatusToolDefinition } from "./tools/delegate-status.ts";
import { createFindTool } from "./tools/find.ts";
import { createGoalToolDefinition } from "./tools/goal.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createModelFitnessToolDefinition } from "./tools/model-fitness.ts";
import { createReadTool } from "./tools/read.ts";
import { createRunToolkitScriptToolDefinition } from "./tools/run-toolkit-script.ts";
import { createTaskStepsToolDefinition } from "./tools/task-steps.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/**
 * Deterministic `addSpawnedUsage` reportId: `kind` + session id + a content hash of `identity`
 * (never `Date.now`/random). Same identity on a retry of the same logical work unit yields the same
 * id, so the ledger's `seenSubagentReportIds` dedupe catches a duplicate report instead of
 * double-counting spend.
 */
function deriveSpawnedUsageReportId(kind: string, sessionId: string, identity: string): string {
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	return `${kind}:${sessionId}:${digest}`;
}

interface ReloadRuntimeSnapshot {
	extensionRunner: ExtensionRunner;
	settings: ReturnType<SettingsManager["createReloadSnapshot"]>;
	modelRegistry: ReturnType<ModelRegistry["createReloadSnapshot"]>;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	sessionLeafId: string | null;
	toolProfileFilter: Required<ResourceProfileFilterSettings> | undefined;
	requestedActiveToolNames: string[] | undefined;
	memory: MemoryControllerReloadSnapshot;
	profileFilter: ProfileFilterReloadSnapshot;
	unboundToolGrantWarnings: string[];
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
	/** Per-agent persistent shell session key; stable across reloads so the shell survives them. */
	getShellSessionKey(): string;
	/** Agent state root, including the host-keyed fitness store. */
	getAgentDir(): string;
	/** Session log, passed to the extension runner. */
	getSessionManager(): SessionManager;
	/** Tool/shell/toolkit/resource settings + reload target (settingsManager.reload()). */
	getSettingsManager(): SettingsManager;
	/** Model registry, passed to the extension runner and profile model re-resolution. */
	getModelRegistry(): ModelRegistry;
	/** Session-scoped provider/model quota exhaustion guard. */
	isModelExhausted(model: Model<Api>): boolean;
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
	getUnboundToolGrantWarnings(): string[];
	createProfileFilterReloadSnapshot(): ProfileFilterReloadSnapshot;
	restoreProfileFilterReloadSnapshot(snapshot: ProfileFilterReloadSnapshot): void;

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

	/** Session-scoped tool-output artifact store for artifact-producing tools and artifact_retrieve (gated on the profile). */
	getToolArtifactStore(): ArtifactStore;

	/** Live memory manager — its provider tools join the registry. */
	getMemoryManager(): MemoryManager;
	/** Memory retrieval + prompt-inclusion diagnostics for the core diagnostics tool. */
	getMemoryAuditDiagnostics(): { retrieval: MemoryRetrievalDiagnostics; promptInclusion: MemoryPromptInclusionReport };
	/** Drop extension-contributed pending memory providers before a reload re-registers them. */
	clearPendingMemoryProviders(): void;
	createMemoryReloadSnapshot(): MemoryControllerReloadSnapshot;
	restoreMemoryReloadSnapshot(snapshot: MemoryControllerReloadSnapshot): void;
	/** (Re)derive the memory subsystem from reloaded settings/providers. */
	initializeMemory(): Promise<void>;

	/** Goal-tool state accessors. */
	getGoalStateSnapshot(): GoalState | undefined;
	saveGoalStateSnapshot(state: GoalState): string;
	/** Native task-step state accessors. */
	getTaskStepsStateSnapshot(): TaskStepsState | undefined;
	saveTaskStepsStateSnapshot(state: TaskStepsState): string;
	/** Context-gc report for the core diagnostics tool. */
	getContextGcReport(messages: AgentMessage[]): ContextGcReport;
	/** Non-blocking worker-delegation starter for the delegate tool. */
	startWorkerDelegation(request: {
		instructions: string;
		systemPrompt?: string;
		memoryRead?: boolean;
	}): { started: false; skipReason: string } | { started: true; record: LaneRecord };
	getWorkerLaneRecords(): LaneRecord[];
	getWorkerResultSnapshots(): WorkerResult[];
	/** Worker-delegation runner for SDK/test through-completion calls. */
	runWorkerDelegationOnce(request: {
		instructions: string;
		systemPrompt?: string;
		memoryRead?: boolean;
	}): Promise<WorkerDelegationRunOutcome>;
	/** Model-fitness probe for the model_fitness tool. `toolCallId` is the idempotency token
	 * for spawned-usage reportId — present only for the LLM tool-call path (see model-fitness.ts). */
	runModelFitness(args: {
		model: string;
		trials?: number;
		toolCallId?: string;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }>;
	/** Fitness-gated reflex-brain model resolver (run_toolkit_script interpretation). */
	resolveCurationModelIfFit(): Model<Api> | undefined;
	/** One-shot, tool-less LLM call — the reflex-brain interpreter rides this. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Roll reflex-brain spend into spawned-usage accounting. `reportId` is REQUIRED: every
	 * caller derives a stable id from the work unit's identity so a retry cannot double-count. */
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
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

	/**
	 * Stop any pi-spawned local (Ollama/Transformers/prism llama.cpp) runtime the host's
	 * LocalRuntimeController is holding open that no longer applies under the just-reloaded
	 * configuration — e.g. `LocalRuntimeController.reconcile(eligibleModels)`, with `eligibleModels`
	 * derived from whatever the host still routes to post-reload (foreground model + any configured
	 * router tier). Called ONLY after `_reloadOnce()` commits successfully — never on a rolled-back
	 * reload, since a rollback restores the PREVIOUS configuration and nothing became ineligible.
	 * Optional: a host that hasn't wired a LocalRuntimeController through here yet sees no behavior
	 * change — a local runtime this builder doesn't know about is simply left alone, never guessed at.
	 */
	reconcileLocalRuntimes?(): void;
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
	private _reloadPromise: Promise<void> | undefined;
	private _reloadRequested = false;

	private readonly deps: RuntimeBuilderDeps;

	constructor(deps: RuntimeBuilderDeps) {
		this.deps = deps;
	}

	private async _runContextScout(
		query: string,
		maxTurns: number | undefined,
		artifactStore: ArtifactStore | undefined,
	) {
		const cwd = this.deps.getCwd();
		const controller = new ScoutController({
			resolveScoutModel: async () =>
				resolveScoutModel(
					this.deps.getModelRegistry(),
					this.deps.getSettingsManager().getScoutSettings().model,
					this.deps.getAgentDir(),
					(model) => this.deps.isModelExhausted(model),
				),
			getCwd: () => cwd,
			buildReadOnlyTools: (toolCwd) => [
				createReadTool(toolCwd),
				createGrepTool(toolCwd, { artifactStore }),
				createFindTool(toolCwd, { artifactStore }),
			],
			streamFn: this.deps.getAgent().streamFn,
			fileExists: (path) => existsSync(resolveCwdPath(cwd, path)),
			countLines: (path) => countFileLines(resolveCwdPath(cwd, path)),
			// Lets the scout register itself in the reload-gate quiesce registry (see
			// reload-blockers.ts) for its own agentDir — the same key `_assertReloadQuiescent` reads.
			getAgentDir: () => this.deps.getAgentDir(),
		});
		return controller.run(query, maxTurns);
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
		const previousActiveToolNames = mapToolNamesForPlatform(
			this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames(),
		);
		const configuredAllowedToolNames = this.deps.getAllowedToolNames();
		const allowedToolNames = configuredAllowedToolNames
			? new Set(mapToolNamesForPlatform([...configuredAllowedToolNames]))
			: undefined;
		const configuredExcludedToolNames = this.deps.getExcludedToolNames();
		const excludedToolNames = configuredExcludedToolNames
			? new Set(mapToolNamesForPlatform([...configuredExcludedToolNames]))
			: undefined;
		const configuredToolProfileFilter = this.deps.getToolProfileFilter();
		const toolProfileFilter = configuredToolProfileFilter
			? {
					allow: mapToolNamesForPlatform(configuredToolProfileFilter.allow),
					block: mapToolNamesForPlatform(configuredToolProfileFilter.block),
				}
			: undefined;
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

		const requestedBase = options?.activeToolNames
			? mapToolNamesForPlatform(options.activeToolNames)
			: [...previousActiveToolNames];
		const nextActiveToolNames = requestedBase.filter((name) => isAllowedTool(name));

		const persistentAutoActivated: string[] = [];
		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					persistentAutoActivated.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
				persistentAutoActivated.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					persistentAutoActivated.push(toolName);
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
		// the true pre-filter request (plus non-profile auto-activations) so an internal refresh can
		// never permanently narrow it. Explicit profile grants are generation-local activations: if
		// profile A names grep and profile B later grants "*", A must not pin grep into B's request.
		this.deps.setRequestedActiveToolNames([...new Set([...requestedBase, ...persistentAutoActivated])]);
	}

	private _createReloadRuntimeSnapshot(): ReloadRuntimeSnapshot {
		const agent = this.deps.getAgent();
		const toolProfileFilter = this.deps.getToolProfileFilter();
		const requestedActiveToolNames = this.deps.getRequestedActiveToolNames();
		return {
			extensionRunner: this.deps.getExtensionRunner(),
			settings: this.deps.getSettingsManager().createReloadSnapshot(),
			modelRegistry: this.deps.getModelRegistry().createReloadSnapshot(),
			model: agent.state.model,
			thinkingLevel: agent.state.thinkingLevel,
			sessionLeafId: this.deps.getSessionManager().getLeafId(),
			toolProfileFilter: toolProfileFilter
				? { allow: [...toolProfileFilter.allow], block: [...toolProfileFilter.block] }
				: undefined,
			requestedActiveToolNames: requestedActiveToolNames ? [...requestedActiveToolNames] : undefined,
			memory: this.deps.createMemoryReloadSnapshot(),
			profileFilter: this.deps.createProfileFilterReloadSnapshot(),
			unboundToolGrantWarnings: [...this.deps.getUnboundToolGrantWarnings()],
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
		this.deps.getSettingsManager().restoreReloadSnapshot(snapshot.settings);
		this.deps.getModelRegistry().restoreReloadSnapshot(snapshot.modelRegistry);
		this.deps.setToolProfileFilter(
			snapshot.toolProfileFilter
				? { allow: [...snapshot.toolProfileFilter.allow], block: [...snapshot.toolProfileFilter.block] }
				: undefined,
		);
		this.deps.setRequestedActiveToolNames(
			snapshot.requestedActiveToolNames ? [...snapshot.requestedActiveToolNames] : undefined,
		);
		this.deps.restoreMemoryReloadSnapshot(snapshot.memory);
		this.deps.restoreProfileFilterReloadSnapshot(snapshot.profileFilter);
		this.deps.setUnboundToolGrantWarnings([...snapshot.unboundToolGrantWarnings]);
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
		agent.state.model = snapshot.model;
		agent.state.thinkingLevel = snapshot.thinkingLevel;
		agent.state.tools = snapshot.agentTools;
		agent.state.systemPrompt = snapshot.agentSystemPrompt;
		this.deps.setBaseSystemPrompt(snapshot.baseSystemPrompt);
		const sessionManager = this.deps.getSessionManager();
		if (snapshot.sessionLeafId === null) {
			sessionManager.resetLeaf();
		} else {
			sessionManager.branch(snapshot.sessionLeafId);
		}
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
		onError?: ExtensionErrorListener;
	}): (() => void) | undefined {
		const settingsManager = this.deps.getSettingsManager();
		const autoResizeImages = settingsManager.getImageAutoResize();
		const shellCommandPrefix = settingsManager.getShellCommandPrefix();
		const shellPath = settingsManager.getShellPath();
		const baseToolsOverride = this.deps.getBaseToolsOverride();
		// Artifact-producing tools must not emit a "Full output: artifact tool-output:<id>" handle
		// that nothing can resolve. If artifact_retrieve is explicitly excluded/blocked/outside
		// an active allowlist, don't hand grep/find/run_toolkit_script an artifact store at all:
		// they fall back to their bounded preview/truncation behavior, with no payload/meta files
		// ever written and no retrieval promise made.
		const toolArtifactStore = this.deps.isToolOrCommandAllowedByProfile("artifact_retrieve")
			? this.deps.getToolArtifactStore()
			: undefined;
		const baseToolDefinitions = baseToolsOverride
			? Object.fromEntries(
					Object.entries(baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
				)
			: createAllToolDefinitions(this.deps.getCwd(), {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath, sessionKey: this.deps.getShellSessionKey() },
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
			const taskStepsToolDefinition = createTaskStepsToolDefinition({
				getTaskStepsState: () => this.deps.getTaskStepsStateSnapshot(),
				saveTaskStepsState: (state) => {
					this.deps.saveTaskStepsStateSnapshot(state);
				},
			});
			this._baseToolDefinitions.set(taskStepsToolDefinition.name, taskStepsToolDefinition);
			const delegateToolDefinition = createDelegateToolDefinition({
				startWorkerDelegation: (args) => this.deps.startWorkerDelegation(args),
				runWorkerDelegation: (args) => this.deps.runWorkerDelegationOnce(args),
			});
			const delegateStatusToolDefinition = createDelegateStatusToolDefinition({
				getLaneRecords: () => this.deps.getWorkerLaneRecords(),
				getWorkerResultSnapshots: () => this.deps.getWorkerResultSnapshots(),
			});
			this._baseToolDefinitions.set(delegateToolDefinition.name, delegateToolDefinition);
			this._baseToolDefinitions.set(delegateStatusToolDefinition.name, delegateStatusToolDefinition);
			// Registered but not default-active: probes spend tokens on the probed model, so
			// activation is an explicit choice (settings/profile/setActiveTools or /autonomy fitness).
			const modelFitnessToolDefinition = createModelFitnessToolDefinition({
				runProbe: (args) => this.deps.runModelFitness(args),
			});
			this._baseToolDefinitions.set(modelFitnessToolDefinition.name, modelFitnessToolDefinition);
			if (settingsManager.getScoutSettings().enabled) {
				const contextScoutToolDefinition = createContextScoutToolDefinition({
					runScout: (input) => this._runContextScout(input.query, input.maxTurns, toolArtifactStore),
				});
				this._baseToolDefinitions.set(contextScoutToolDefinition.name, contextScoutToolDefinition);
			}
			const runToolkitScriptToolDefinition = createRunToolkitScriptToolDefinition({
				getScripts: () => this.deps.getSettingsManager().getToolkitScripts(),
				execute: (script, scriptArgs) => executeToolkitScript({ script, scriptArgs, cwd: this.deps.getCwd() }),
				artifactStore: toolArtifactStore,
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
						// Stable per-lane synthetic affinity key so repeat ambiguous-request
						// interpretations hit the same cache-warm backend.
						laneKind: "toolkit-brain",
					});
					if (completion.usage.cost.total > 0 || completion.usage.totalTokens > 0) {
						// `reportId` keyed on the ambiguous request text driving THIS interpretation —
						// stable across a retry of the same tool call, distinct across genuinely
						// different requests.
						const reportId = deriveSpawnedUsageReportId(
							"toolkit-brain",
							this.deps.getSessionManager().getSessionId(),
							request,
						);
						this.deps.addSpawnedUsage(completion.usage, { label: "toolkit-brain", reportId });
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
		const offBuildErrors = options.onError ? runner.onError(options.onError) : undefined;
		this.deps.setExtensionRunner(runner);
		try {
			this.deps.bindExtensionCore(runner);
		} catch (error) {
			offBuildErrors?.();
			throw error;
		}
		this.deps.applyExtensionBindings(runner);

		const defaultActiveToolNames = mapToolNamesForPlatform(
			baseToolsOverride
				? Object.keys(baseToolsOverride)
				: [...DEFAULT_ACTIVE_TOOL_NAMES, ...(settingsManager.getScoutSettings().enabled ? ["context_scout"] : [])],
		);
		const baseActiveToolNames = mapToolNamesForPlatform(options.activeToolNames ?? defaultActiveToolNames);
		this.refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
		return offBuildErrors;
	}

	reload(): Promise<void> {
		if (this._reloadPromise) {
			// State can change while a generation is being validated. Coalesce any number of
			// overlapping requests into one follow-up generation instead of silently treating a
			// later profile/settings mutation as part of the already-snapshotted generation.
			this._reloadRequested = true;
			return this._reloadPromise;
		}
		const reloadPromise = this._drainReloadRequests();
		this._reloadPromise = reloadPromise;
		return reloadPromise;
	}

	private async _drainReloadRequests(): Promise<void> {
		let finalError: unknown;
		try {
			do {
				this._reloadRequested = false;
				try {
					await this._reloadOnce();
					finalError = undefined;
				} catch (error) {
					finalError = error;
				}
			} while (this._reloadRequested);
			if (finalError !== undefined) throw finalError;
		} finally {
			this._reloadPromise = undefined;
			this._reloadRequested = false;
		}
	}

	/**
	 * Unified reload-gate quiescence check: refuses the caller's action (message-prefixed by
	 * `action`) while the agent is streaming, is compacting, or ANY background work unit is still
	 * registered in the in-process quiesce registry — background lanes (research/worker/
	 * model-fitness), a context-scout run, or an isolated completion (see reload-blockers.ts). Every
	 * live-op entry point below calls this so they refuse identically; this is a synchronous refusal
	 * (not a wait/poll) — callers retry via the same coalescing `reload()` already provides.
	 */
	private _assertReloadQuiescent(action: string): void {
		if (this.deps.isStreaming()) {
			throw new Error(`Cannot ${action} while the agent is streaming or a tool call is active`);
		}
		if (this.deps.isCompacting()) {
			throw new Error(`Cannot ${action} while context compaction or branch summarization is active`);
		}
		const units = getInFlightWorkUnits(this.deps.getAgentDir());
		if (units.length > 0) {
			const summary = units.map(describeInFlightWorkUnit).join(", ");
			throw new Error(`Cannot ${action} while background work is in flight: ${summary}`);
		}
	}

	private async _reloadOnce(): Promise<void> {
		this._assertReloadQuiescent("reload");
		const previousRunner = this.deps.getExtensionRunner();
		const snapshot = this._createReloadRuntimeSnapshot();
		// Preserve the pre-filter tool REQUEST across the rebuild, not the capability/profile-filtered
		// active set — otherwise a reload under a small model permanently shrinks the restorable set.
		const activeToolNames = this.deps.getRequestedActiveToolNames() ?? this.deps.getActiveToolNames();
		const previousFlagValues = previousRunner.getFlagValues();
		const previousExtensionProviderNames = previousRunner.getRegisteredProviderNames();
		const reloadErrors: string[] = [];
		let newRunner: ExtensionRunner | undefined;
		let offReloadErrors: (() => void) | undefined;
		try {
			await this.deps.getSettingsManager().reload();
			// Re-derive the resource-profile tool filter from the freshly reloaded settings.
			// Unlike skills/prompts/themes (which re-filter through the resource loader on every
			// reload), the tool filter is held on the session, so without this a live edit to the
			// active profile's tools allow/block — or switching the active profile — would not
			// apply on /reload and allowed tools would stay missing.
			this.deps.setToolProfileFilter(this.deps.deriveToolProfileFilter());
			// Resource discovery must consume this exact settings generation. A second settings read here
			// could combine profile state from one generation with resources from the next.
			await this.deps.getResourceLoader().reload({
				failOnExtensionErrors: true,
				deferExtensionDispose: true,
				skipSettingsReload: true,
			});
			// Replace the previous extension-owned provider generation before binding the new one. The
			// bulk refresh also preserves API/OAuth streams for surviving non-extension providers.
			this.deps.getModelRegistry().unregisterProviders(previousExtensionProviderNames);
			offReloadErrors = this.buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
				onError: (error) => {
					reloadErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`);
				},
			});
			newRunner = this.deps.getExtensionRunner();
			// Extensions are now bound and their queued providers/models are registered, so a profile may
			// safely select a model contributed by an extension granted in that same profile generation.
			await this.deps.reapplyActiveProfileModelSettings();
			// Model capability and system-prompt/tool exposure must reflect the newly selected model.
			this.refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
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
				offReloadErrors?.();
				offReloadErrors = undefined;
			}
			if (reloadErrors.length > 0) {
				throw new Error(`Extension reload failed doctor: ${reloadErrors.slice(0, 6).join("; ")}`);
			}
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });
			previousRunner.invalidate();
			await this.deps.getResourceLoader().commitReload?.();
			// Re-derive the memory subsystem from the reloaded settings/providers.
			await this.deps.initializeMemory();
			// This generation has fully committed (no rollback below this point), so any local
			// runtime the host no longer routes to under the new configuration can be stopped now.
			this.deps.reconcileLocalRuntimes?.();
		} catch (error) {
			offReloadErrors?.();
			if (newRunner && newRunner !== previousRunner) {
				newRunner.invalidate(
					"This extension ctx was discarded because reload failed and Pi restored the previous valid runtime.",
				);
			}
			await this.deps.getResourceLoader().rollbackReload?.();
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
		this._assertReloadQuiescent("unload extension");

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
			const ownedMemoryProviders = runtime.memoryProvidersByExtension.get(ext.path) ?? new Set();
			const ownedContextMemoryProviders = runtime.contextMemoryProvidersByExtension.get(ext.path) ?? new Set();
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
			const memorySnapshot = this.deps.createMemoryReloadSnapshot();
			this.deps.restoreMemoryReloadSnapshot({
				...memorySnapshot,
				pendingMemoryProviders: memorySnapshot.pendingMemoryProviders.filter(
					(provider) => !ownedMemoryProviders.has(provider),
				),
				pendingContextMemoryProviders: memorySnapshot.pendingContextMemoryProviders.filter(
					(provider) => !ownedContextMemoryProviders.has(provider),
				),
			});
			runtime.memoryProvidersByExtension.delete(ext.path);
			runtime.contextMemoryProvidersByExtension.delete(ext.path);
			await this.deps.initializeMemory();

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
		this._assertReloadQuiescent("load extension");

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
			// Activate newly registered legacy/context providers immediately. Reinitialization also
			// refreshes provider tools and preserves all providers owned by existing extensions.
			await this.deps.initializeMemory();

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
		this._assertReloadQuiescent("reconcile extensions");

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

export async function resolveScoutModel(
	modelRegistry: ModelRegistry,
	modelSetting: string,
	agentDir: string,
	isModelExhausted: (model: Model<Api>) => boolean = () => false,
) {
	const model =
		modelSetting === "auto"
			? findFastContextModel(modelRegistry)
			: resolveCliModel({ cliModel: modelSetting, modelRegistry }).model;
	if (!model) {
		return { failure: `no scout model matched ${modelSetting}` };
	}
	if (isModelExhausted(model)) {
		return { failure: `${model.provider}/${model.id} exhausted: quota` };
	}
	if (modelSetting === "auto") {
		const modelRef = `${model.provider}/${model.id}`;
		const fitness = FitnessStore.forAgentDir(agentDir)
			.getForHost()
			.find((entry) => entry.model === modelRef);
		const verdict = evaluateSurfaceFitness("scout_auto", fitness?.report);
		if (!verdict.fit) {
			return verdict.reason === "unprobed"
				? { failure: `${modelRef} unprobed — run /fitness before auto-selection` }
				: { failure: `${modelRef} unfit (${verdict.lane} ${verdict.succeeded}/${verdict.total})` };
		}
	}
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { failure: auth.error ?? `no usable auth for scout model ${model.provider}/${model.id}` };
	}
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function findFastContextModel(modelRegistry: ModelRegistry) {
	return modelRegistry.getAll().find((model) => {
		const text = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
		return text.includes("fastcontext");
	});
}

function resolveCwdPath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function countFileLines(path: string): number | undefined {
	try {
		return readFileSync(path, "utf8").split(/\r?\n/).length;
	} catch {
		return undefined;
	}
}
