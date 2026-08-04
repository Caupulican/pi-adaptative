/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Agent, convertToLlm } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	RegisterFauxProviderOptions,
} from "@caupulican/pi-ai";
import { registerFauxProvider } from "@caupulican/pi-ai";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import type { LocalRuntimeDeps } from "../../src/core/models/local-runtime.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../src/core/orchestration/profile-store.ts";
import type { collectWorkspaceSources } from "../../src/core/research/workspace-collector.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	models?: FauxModelDefinition[];
	fauxProvider?: Pick<RegisterFauxProviderOptions, "api" | "provider">;
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	/**
	 * Research-lane workspace source collector. Defaults to a no-op so session tests never spawn a
	 * real ripgrep; the collector itself is covered by test/workspace-collector.test.ts.
	 */
	collectWorkspaceSources?: typeof collectWorkspaceSources;
	/** Fake fetch/spawn/exists for the local (Ollama) runtime; see test/agent-session-local-runtime.test.ts. */
	localRuntimeDeps?: LocalRuntimeDeps;
	orchestrationProfile?: OrchestrationProfile;
	/** Owner-authored profile used by delegate calls; independent from the foreground profile. */
	workerOrchestrationProfile?: OrchestrationProfile;
	additionalOrchestrationProfiles?: readonly OrchestrationProfile[];
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		...options.fauxProvider,
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = SessionManager.inMemory();
	const workerModel = model;
	const defaultOrchestrationProfileId = options.workerOrchestrationProfile?.profileId ?? "test-worker";
	const effectiveSettings: Partial<Settings> = {
		...options.settings,
		workerDelegation: {
			orchestrationProfile: defaultOrchestrationProfileId,
			...options.settings?.workerDelegation,
		},
	};
	const settingsManager = SettingsManager.inMemory(effectiveSettings);
	const createdAt = new Date().toISOString();
	const defaultOrchestrationProfile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: defaultOrchestrationProfileId,
		description: "Faux-provider test worker",
		role: "implementer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: workerModel.provider, modelId: workerModel.id, thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "filesystem.write", "worktree.read", "worktree.mutate"],
		toolNames: ["read", "grep", "find", "ls", "write", "edit"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 5, maxWallClockMs: 3_600_000, maxTokens: workerModel.maxTokens, maxToolCalls: 20 },
		maxConcurrent: 3,
		leaseTtlMs: 3_660_000,
		requireIndependentVerification: false,
		createdAt,
		updatedAt: createdAt,
	};
	new OrchestrationProfileStore({ agentDir: tempDir, cwd: tempDir, projectTrusted: true }).save(
		options.workerOrchestrationProfile ?? defaultOrchestrationProfile,
		"global",
	);
	for (const profile of options.additionalOrchestrationProfiles ?? []) {
		new OrchestrationProfileStore({ agentDir: tempDir, cwd: tempDir, projectTrusted: true }).save(profile, "global");
	}
	if (options.orchestrationProfile) {
		new OrchestrationProfileStore({ agentDir: tempDir, cwd: tempDir, projectTrusted: true }).save(
			options.orchestrationProfile,
			"global",
		);
	}

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				textToolCallProtocol: registeredModel.textToolCallProtocol,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
				defaultThinkingLevel: registeredModel.defaultThinkingLevel,
				thinkingLevelMap: registeredModel.thinkingLevelMap,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
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
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
		collectWorkspaceSources: options.collectWorkspaceSources ?? (async () => []),
		localRuntimeDeps: options.localRuntimeDeps,
		orchestrationProfile: options.orchestrationProfile,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
