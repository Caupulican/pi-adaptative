import { Agent } from "@caupulican/pi-agent-core/agent";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import { getDefaultSessionDir, SessionManager } from "@caupulican/pi-agent-core/session";
import type { AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core/types";
import {
	type Api,
	type Message,
	type Model,
	resolveModelThinkingLevel,
	type ServiceTier,
	streamSimple,
} from "@caupulican/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { configFile } from "./agent-paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import {
	BEDROCK_PROVIDER_ID,
	bindSavedBedrockScope,
	getActiveBedrockScope,
	isUnscopedBedrockProxy,
} from "./bedrock-scope.ts";
import { recoverBedrockSsoAuthentication } from "./bedrock-sso-login.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "./default-tool-surface.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { resolveFastModeServiceTier } from "./fast-mode.ts";
import { isInstallTelemetryEnabled } from "./install-telemetry.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel, resolveProfileModelSettings } from "./model-resolver.ts";
import type { OrchestrationProfile } from "./orchestration/contracts.ts";
import { resolveConfiguredOrchestrationModel } from "./orchestration/model-binding.ts";
import { validateOrchestrationProfile } from "./orchestration/profile-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { parseResourceProfileInput } from "./resource-profile-blocks.ts";
import { isWorkerSession } from "./session-role.ts";
import type {
	ProfileDefinitionInput,
	ResourceProfileFilterSettings,
	ResourceProfileSettings,
} from "./settings-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<Api>;
	/** Thinking level. Default: from settings, then the model's declared default, else 'medium'. */
	thinkingLevel?: ThinkingLevel;
	/** Default provider processing tier for this session. Per-request options take precedence. */
	serviceTier?: ServiceTier;
	/**
	 * Whether `model` came from an explicit CLI/SDK flag (vs. profile/settings resolution).
	 * When false (default), the active profile's model is re-applied on reload so live profile
	 * edits take effect; when true, the explicit launch-time model is preserved across reloads.
	 */
	isExplicitModel?: boolean;
	/** Whether `thinkingLevel` came from an explicit flag (see isExplicitModel). */
	isExplicitThinking?: boolean;
	/** True when this session is a spawned subagent/child — gates durable memory writes. */
	isChildSession?: boolean;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, python, edit, write,
	 *   goal, delegate, and run_toolkit_script)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the shared default built-in tool surface and leaves extension/custom
	 * tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Optional resource-profile allow/block filters for tool names. */
	toolProfileFilter?: ResourceProfileFilterSettings;
	/** Optional one-shot resource filters or complete situation profiles. Never persisted to disk. */
	resourceProfileDefinitions?: Record<string, ResourceProfileSettings | ProfileDefinitionInput>;
	/** Optional one-shot profile definitions as JSON or <resource-profile> tag text. Never persisted to disk. */
	resourceProfileJson?: string | string[];
	/** Optional runtime profile selection. Never persisted to disk. */
	resourceProfiles?: string[];
	/** Immutable owner-authored orchestration policy for this session. */
	orchestrationProfile?: OrchestrationProfile;
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd, agentDir, getDefaultSessionDir(cwd, agentDir)) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function getAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId?: string,
): Record<string, string> | undefined {
	if (
		sessionId &&
		(model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai"))
	) {
		return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
	}

	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		model.baseUrl.includes("api.cloudflare.com") ||
		model.baseUrl.includes("gateway.ai.cloudflare.com")
	) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@caupulican/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? configFile(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? configFile(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	bindSavedBedrockScope(settingsManager, modelRegistry);
	const isChildSession = options.isChildSession ?? process.env.PI_CHILD_SESSION === "1";
	const forceBackgroundRequests = isChildSession || isWorkerSession();
	const defaultServiceTier = options.serviceTier;
	const orchestrationProfile = options.orchestrationProfile;
	if (orchestrationProfile) {
		validateOrchestrationProfile(orchestrationProfile);
		const conflictingOptions = [
			...(options.model ? ["model"] : []),
			...(options.thinkingLevel !== undefined ? ["thinkingLevel"] : []),
			...(options.scopedModels !== undefined ? ["scopedModels"] : []),
			...(options.tools !== undefined ? ["tools"] : []),
			...(options.noTools !== undefined ? ["noTools"] : []),
			...(options.excludeTools !== undefined ? ["excludeTools"] : []),
			...(options.toolProfileFilter !== undefined ? ["toolProfileFilter"] : []),
			...(options.resourceProfiles !== undefined ? ["resourceProfiles"] : []),
		];
		if (conflictingOptions.length > 0) {
			throw new TypeError(
				`Orchestration profile '${orchestrationProfile.profileId}' owns model, thinking, tools, and resources; remove conflicting SDK options: ${conflictingOptions.join(", ")}.`,
			);
		}
		settingsManager.setRuntimeResourceProfiles([...orchestrationProfile.resourceProfileNames]);
	}
	const needsProfileReload =
		options.resourceProfileDefinitions !== undefined ||
		options.resourceProfileJson !== undefined ||
		options.resourceProfiles !== undefined ||
		orchestrationProfile !== undefined;
	if (options.resourceProfileDefinitions) {
		settingsManager.addInlineResourceProfileDefinitions(options.resourceProfileDefinitions);
	}
	if (options.resourceProfileJson) {
		const inputs = Array.isArray(options.resourceProfileJson)
			? options.resourceProfileJson
			: [options.resourceProfileJson];
		for (const input of inputs) {
			settingsManager.addInlineResourceProfileDefinitions(parseResourceProfileInput(input).profiles);
		}
	}
	if (!orchestrationProfile && options.resourceProfiles !== undefined) {
		settingsManager.setRuntimeResourceProfiles(options.resourceProfiles);
	}
	const sessionManager =
		options.sessionManager ?? SessionManager.create(cwd, agentDir, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	} else if (needsProfileReload) {
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	const orchestrationModel = orchestrationProfile
		? resolveConfiguredOrchestrationModel(orchestrationProfile, modelRegistry)
		: undefined;
	if (orchestrationProfile && !orchestrationModel) {
		throw new TypeError(
			`Orchestration profile '${orchestrationProfile.profileId}' has no configured, authenticated model that supports its exact thinking level.`,
		);
	}
	let model = orchestrationModel?.model ?? options.model;
	let modelFallbackMessage: string | undefined;

	let thinkingLevel = orchestrationModel?.binding.thinkingLevel ?? options.thinkingLevel;

	const activeProfileNames = settingsManager.getActiveResourceProfileNames();
	if (!orchestrationProfile && activeProfileNames.length > 0) {
		const profileSettings = resolveProfileModelSettings({
			activeProfileNames,
			registry: settingsManager.getProfileRegistry(),
			modelRegistry,
			cwd,
		});
		if (profileSettings.error) {
			modelFallbackMessage = `Profile model resolution error: ${profileSettings.error}`;
		}
		if (!model && profileSettings.model) {
			model = profileSettings.model;
		}
		if (thinkingLevel === undefined && profileSettings.thinkingLevel) {
			thinkingLevel = profileSettings.thinkingLevel;
		}
	}

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (thinkingLevel === undefined && !(hasExistingSession && hasThinkingEntry)) {
			thinkingLevel = result.thinkingLevel;
		}
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: settingsManager.getDefaultThinkingLevel();
	}

	// Resolve preference, model metadata, harness fallback, and capability clamping through the
	// same contract used by CLI startup and isolated lanes.
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = resolveModelThinkingLevel(
			model,
			thinkingLevel ?? settingsManager.getDefaultThinkingLevel(),
		) as ThinkingLevel;
	}

	const defaultActiveToolNames = [
		...DEFAULT_ACTIVE_TOOL_NAMES,
		...(settingsManager.getScoutSettings().enabled ? ["context_scout"] : []),
	];
	const toolProfileFilter = orchestrationProfile
		? settingsManager.getResourceProfileFilter("tools")
		: (options.toolProfileFilter ?? settingsManager.getResourceProfileFilter("tools"));
	const allowedToolNames = orchestrationProfile
		? [...orchestrationProfile.toolNames]
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = orchestrationProfile ? undefined : options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		orchestrationProfile
			? [...orchestrationProfile.toolNames]
			: options.tools
				? [...options.tools]
				: options.noTools
					? []
					: defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const bedrockScope =
				model.provider === BEDROCK_PROVIDER_ID ? getActiveBedrockScope(settingsManager) : undefined;
			if (model.provider === BEDROCK_PROVIDER_ID && !bedrockScope && !isUnscopedBedrockProxy()) {
				throw new Error(
					"Amazon Bedrock requires a verified profile/region scope. Run /login amazon-bedrock before using this model.",
				);
			}
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const attributionHeaders = getAttributionHeaders(model, settingsManager, options?.sessionId);
			const fastModeServiceTier = resolveFastModeServiceTier(
				model,
				settingsManager.getFastModeEnabled(model.provider),
			);
			const providerOptions = {
				...options,
				serviceTier:
					options?.serviceTier === undefined ? (fastModeServiceTier ?? defaultServiceTier) : options.serviceTier,
				...(bedrockScope ? { region: bedrockScope.region, profile: bedrockScope.profile } : {}),
				interactionMode: forceBackgroundRequests ? "background" : (options?.interactionMode ?? "user"),
				onInteractiveAuthRecovery: options?.onInteractiveAuthRecovery ?? recoverBedrockSsoAuthentication,
				apiKey: auth.apiKey,
				onAuthRejection:
					auth.apiKey && model.provider === "openai-codex"
						? async () => modelRegistry.recoverRejectedOAuthApiKey(model.provider, auth.apiKey as string)
						: options?.onAuthRejection,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers:
					attributionHeaders || auth.headers || options?.headers
						? { ...attributionHeaders, ...auth.headers, ...options?.headers }
						: undefined,
			};
			return streamSimple(model, context, providerOptions);
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		agentDir,
		scopedModels: orchestrationModel
			? [{ model: orchestrationModel.model, thinkingLevel: orchestrationModel.binding.thinkingLevel }]
			: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		toolProfileFilter,
		isExplicitModel: orchestrationProfile ? true : (options.isExplicitModel ?? options.model != null),
		isExplicitThinking: orchestrationProfile
			? true
			: (options.isExplicitThinking ?? options.thinkingLevel !== undefined),
		isChildSession,
		orchestrationProfile,
		sessionStartEvent: options.sessionStartEvent,
	});
	try {
		// The initial runtime has now bound providers from profile-granted extensions. Re-resolve the
		// profile model against that authoritative registry generation, then resync model capability.
		await session.reapplyActiveProfileModelSettings();
		if (modelFallbackMessage?.startsWith("Profile model resolution error:")) {
			modelFallbackMessage = undefined;
		}
	} catch (error) {
		// Preserve the established non-fatal fallback for a genuinely unresolved profile model.
		if (!modelFallbackMessage?.startsWith("Profile model resolution error:")) {
			await session.disposeAndWait();
			throw error;
		}
	}
	// File-store memory tools exist only after providers initialize. Do this here so an SDK session
	// that never calls bindExtensions still has the requested `memory` tool when the grant allows it.
	await session.initializeMemory();
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
