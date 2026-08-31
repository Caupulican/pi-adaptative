/**
 * Composition root for the session's model & tool selection wiring.
 *
 * Moved verbatim out of the AgentSession constructor (god-file decomposition): it builds the five
 * controllers that own model/thinking selection, standalone bash execution, resource-profile
 * filtering, tool-selection observation, and the agent tool-call gate. The session passes a narrow
 * host literal whose controller accessors are lazy getters — the constructor still has forward
 * references (the gate reads the model router, bash reads the runtime builder's credential manager)
 * that are only safe because the callbacks run after construction completes.
 */

import type { Agent, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "../agent-session-contracts.ts";
import type { CapabilityEnvelope, GateOutcome } from "../autonomy/contracts.ts";
import { evaluateToolGate } from "../autonomy/gates.ts";
import { BashExecutionController } from "../bash-execution-controller.ts";
import type { ExtensionRunner, ToolInfo } from "../extensions/index.ts";
import type { ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { formatModelRouterModel } from "../model-router-controller.ts";
import { ModelSelectionController } from "../model-selection-controller.ts";
import type { OllamaRuntime } from "../models/local-runtime.ts";
import { ProfileFilterController } from "../profile-filter-controller.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { CredentialManager } from "../secrets/credential-manager.ts";
import type { ResourceProfileFilterSettings, SettingsManager } from "../settings-manager.ts";
import { ToolGateController } from "../tool-gate-controller.ts";
import { ToolPerformanceStore } from "../tool-selection/tool-performance-store.ts";
import { ToolSelectionController } from "../tool-selection/tool-selection-controller.ts";

/**
 * What the model & tool selection group reads from the session. Controller-valued dependencies are
 * exposed as getter functions on purpose: the session assigns them after this composer runs.
 */
export interface ModelToolCompositionHost {
	getAgent(): Agent;
	getModel(): Model<Api> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getModelRegistry(): ModelRegistry;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getExtensionRunner(): ExtensionRunner;
	getAgentDir(): string;
	getScopedModels(): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	getRequestedActiveToolNames(): string[] | undefined;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
	getAllTools(): ToolInfo[];
	getModelCapabilityProfile(): ModelCapabilityProfile;
	refreshBaseSystemPrompt(): void;
	emit(event: AgentSessionEvent): void;
	checkContextWindowUsageWarning(): void;
	deriveOllamaServerUrl(modelBaseUrl: string): string;
	getLocalRuntime(serverUrl: string): OllamaRuntime;
	isStreaming(): boolean;
	getShellSessionKey(): string;
	/** Lazy: the credential manager lives on the runtime builder, built earlier in the constructor. */
	getCredentialManager(): CredentialManager;
	getResourceLoader(): ResourceLoader;
	getCwd(): string;
	getAllowedToolNames(): Set<string> | undefined;
	getExcludedToolNames(): Set<string> | undefined;
	getToolProfileFilter(): Required<ResourceProfileFilterSettings> | undefined;
	isExplicitModel(): boolean;
	isExplicitThinking(): boolean;
	setThinkingLevel(level: ThinkingLevel, options: { persistSettings?: boolean }): void;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Lazy: the model router is constructed earlier in the constructor. */
	maybeEscalateToolCall(toolName: string, args: unknown): { block: true; reason: string } | undefined;
	recordGateOutcome(outcome: GateOutcome): void;
}

export interface ModelToolComposition {
	modelSelection: ModelSelectionController;
	bash: BashExecutionController;
	profileFilter: ProfileFilterController;
	toolSelection: ToolSelectionController;
	toolGate: ToolGateController;
}

export function composeModelToolControllers(host: ModelToolCompositionHost): ModelToolComposition {
	const modelSelection = new ModelSelectionController({
		getAgent: () => host.getAgent(),
		getModel: () => host.getModel(),
		getThinkingLevel: () => host.getThinkingLevel(),
		getModelRegistry: () => host.getModelRegistry(),
		getSessionManager: () => host.getSessionManager(),
		getSettingsManager: () => host.getSettingsManager(),
		getExtensionRunner: () => host.getExtensionRunner(),
		getAgentDir: () => host.getAgentDir(),
		getScopedModels: () => host.getScopedModels(),
		getRequestedActiveToolNames: () => host.getRequestedActiveToolNames(),
		getActiveToolNames: () => host.getActiveToolNames(),
		setActiveToolsByName: (names) => host.setActiveToolsByName(names),
		getModelCapabilityProfile: () => host.getModelCapabilityProfile(),
		refreshBaseSystemPrompt: () => host.refreshBaseSystemPrompt(),
		emit: (event) => host.emit(event),
		checkContextWindowUsageWarning: () => host.checkContextWindowUsageWarning(),
		deriveOllamaServerUrl: (baseUrl) => host.deriveOllamaServerUrl(baseUrl),
		getLocalRuntime: (serverUrl) => host.getLocalRuntime(serverUrl),
	});
	const bash = new BashExecutionController({
		getAgent: () => host.getAgent(),
		getSessionManager: () => host.getSessionManager(),
		getSettingsManager: () => host.getSettingsManager(),
		isStreaming: () => host.isStreaming(),
		getShellSessionKey: () => host.getShellSessionKey(),
		getEnvironment: (cwd) => host.getCredentialManager().getEnvironmentForCwd(cwd) ?? {},
		redactSensitiveText: (text) => host.getCredentialManager().redactSensitiveText(text),
	});
	const profileFilter = new ProfileFilterController({
		getSettingsManager: () => host.getSettingsManager(),
		getResourceLoader: () => host.getResourceLoader(),
		getModelRegistry: () => host.getModelRegistry(),
		getCwd: () => host.getCwd(),
		getAgent: () => host.getAgent(),
		getSessionManager: () => host.getSessionManager(),
		getAllowedToolNames: () => host.getAllowedToolNames(),
		getExcludedToolNames: () => host.getExcludedToolNames(),
		getToolProfileFilter: () => host.getToolProfileFilter(),
		isExplicitModel: () => host.isExplicitModel(),
		isExplicitThinking: () => host.isExplicitThinking(),
		setThinkingLevel: (level) => host.setThinkingLevel(level, { persistSettings: false }),
	});
	const toolSelection = new ToolSelectionController({
		store: ToolPerformanceStore.forAgentDir(host.getAgentDir()),
		getModelRef: () => {
			const model = host.getModel();
			return model ? formatModelRouterModel(model) : "unknown";
		},
		getActiveTools: () => {
			const activeNames = new Set(host.getActiveToolNames());
			return host
				.getAllTools()
				.filter((tool) => activeNames.has(tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				}));
		},
		isCandidateAllowed: (toolName) => {
			const envelope = host.getCapabilityEnvelope();
			if (!envelope) return true;
			return (
				evaluateToolGate({
					toolName,
					args: {},
					cwd: host.getCwd(),
					envelope,
				}).outcome === "allow"
			);
		},
	});
	const toolGate = new ToolGateController({
		maybeEscalateToolCall: (toolName, args) => host.maybeEscalateToolCall(toolName, args),
		getCwd: () => host.getCwd(),
		getCapabilityEnvelope: () => host.getCapabilityEnvelope(),
		recordGateOutcome: (outcome) => host.recordGateOutcome(outcome),
		getExtensionRunner: () => host.getExtensionRunner(),
		getToolSelectionController: () => toolSelection,
	});
	return { modelSelection, bash, profileFilter, toolSelection, toolGate };
}
