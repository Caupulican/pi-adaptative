/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Agent } from "@caupulican/pi-agent-core/agent";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AgentTool } from "@caupulican/pi-agent-core/types";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	RegisterFauxProviderOptions,
} from "@caupulican/pi-ai/faux";
import { registerFauxProvider } from "@caupulican/pi-ai/faux";
import type { Model } from "@caupulican/pi-ai/types";
import { onTestFinished } from "vitest";
import { AgentSession, type AgentSessionConfig, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import type { LocalRuntimeDeps } from "../../src/core/models/local-runtime.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../src/core/orchestration/profile-store.ts";
import type { collectWorkspaceSources } from "../../src/core/research/workspace-collector.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { removeTreeSync } from "../../src/core/util/remove-tree.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./test-resources.ts";

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
	/** Caller-owned state shared by multiple parents; harness cleanup never removes it. */
	agentDir?: string;
	/** Caller owns registration and response queue lifetime when supplied. */
	sharedFauxProvider?: FauxProviderRegistration;
	/** Session working directory; defaults to the harness temp dir. Must exist. */
	cwd?: string;
	/** Persist the session inside the harness-owned temporary directory. */
	persistSession?: boolean;
	models?: FauxModelDefinition[];
	fauxProvider?: Pick<RegisterFauxProviderOptions, "api" | "provider" | "onRequest">;
	settings?: Partial<Settings>;
	systemPrompt?: string;
	/**
	 * Replaces the session's whole base tool set (the session config's `baseToolsOverride`): only the
	 * listed tools exist, so builtins such as `delegate`, `bash` and `typesafe_review` are absent and
	 * a worker delegation reports `delegate_tool_inactive`. To hand a worker a real tool, keep the
	 * default set and grant it through `workerOrchestrationProfile` instead.
	 */
	baseToolsOverride?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: AgentSessionConfig["resourceLoader"];
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	/**
	 * Research-lane workspace source collector. Defaults to a no-op so session tests never spawn a
	 * real ripgrep; the collector itself is covered by test/workspace-collector.test.ts.
	 */
	collectWorkspaceSources?: typeof collectWorkspaceSources;
	/** Fake fetch/spawn/exists for the local (Ollama) runtime; see test/agent-session-local-runtime.test.ts. */
	localRuntimeDeps?: LocalRuntimeDeps;
	/** Ids of registered faux models to scope model cycling to, as an SDK caller's scope does. */
	scopedModelIds?: string[];
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
	cleanup: () => Promise<void>;
}

function createTempDir(): string {
	const root = realpathSync.native(tmpdir());
	const tempDir = join(root, `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return realpathSync.native(tempDir);
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const agentDir = options.agentDir ?? tempDir;
	const fauxProvider: FauxProviderRegistration =
		options.sharedFauxProvider ??
		registerFauxProvider({
			...options.fauxProvider,
			models: options.models,
		});
	if (!options.sharedFauxProvider) fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.baseToolsOverride
		? Object.fromEntries(options.baseToolsOverride.map((tool) => [tool.name, tool]))
		: undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.persistSession
		? SessionManager.create(options.cwd ?? tempDir, agentDir, join(tempDir, "sessions"))
		: SessionManager.inMemory();
	const workerModel = model;
	const defaultOrchestrationProfileId = options.workerOrchestrationProfile?.profileId ?? "test-worker";
	const effectiveSettings: Partial<Settings> = {
		// Transcript characterizations use an explicit empty grant set. Authority tests pass
		// edge: {} to exercise the production YOLO default and its durable context records.
		edge: { allow: [] },
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
		capabilityCeiling: [
			"filesystem.read",
			"filesystem.write",
			"worktree.read",
			"worktree.mutate",
			"workflow.delegate",
		],
		toolNames: ["read", "grep", "find", "ls", "write", "edit", "delegate"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 5, maxWallClockMs: 3_600_000, maxTokens: workerModel.maxTokens, maxToolCalls: 20 },
		maxConcurrent: 3,
		leaseTtlMs: 3_660_000,
		requireIndependentVerification: false,
		createdAt,
		updatedAt: createdAt,
	};
	const profileStore = new OrchestrationProfileStore({ agentDir, cwd: options.cwd ?? tempDir, projectTrusted: true });
	const profileSemantics = (profile: OrchestrationProfile) => {
		const { createdAt: _created, updatedAt: _updated, sourcePath: _source, ...semantics } = profile;
		return semantics;
	};
	for (const profile of [
		options.workerOrchestrationProfile ?? defaultOrchestrationProfile,
		...(options.additionalOrchestrationProfiles ?? []),
		...(options.orchestrationProfile ? [options.orchestrationProfile] : []),
	]) {
		if (options.agentDir && existsSync(profileStore.filePath(profile.profileId, "global"))) {
			const existing = profileStore.load().profiles.find((item) => item.profileId === profile.profileId);
			if (!existing || !isDeepStrictEqual(profileSemantics(existing), profileSemantics(profile)))
				throw new Error(`Shared harness profile ${profile.profileId} has conflicting configuration.`);
		} else profileStore.save(profile, "global");
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

	const scopedModels = options.scopedModelIds?.map((id) => {
		const scoped = modelRegistry.getAvailable().find((candidate) => candidate.id === id);
		if (!scoped) throw new Error(`Harness scopedModelIds: no registered model ${id}`);
		return { model: scoped };
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.cwd ?? tempDir,
		agentDir,
		modelRegistry,
		scopedModels,
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

	let cleanupPromise: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			try {
				await session.disposeAndWait();
			} finally {
				if (!options.sharedFauxProvider) fauxProvider.unregister();
				if (existsSync(tempDir)) removeTreeSync(tempDir);
			}
		})();
		return cleanupPromise;
	};
	onTestFinished(cleanup);

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
		cleanup,
	};
}
