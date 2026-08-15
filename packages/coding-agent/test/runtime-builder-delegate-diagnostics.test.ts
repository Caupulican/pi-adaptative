import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentContext } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeBuilder, type RuntimeBuilderDeps } from "../src/core/runtime-builder.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import type { LoadExtensionsResult, ResourceLoader } from "../src/index.ts";

/**
 * The root-session delegate tool's promptGuidelines are bounded through
 * normalizeProviderPromptGuidelines, which reports drop/truncation diagnostics through an optional
 * `warn` callback (provider-tool-text.ts, delegate.ts). RuntimeBuilder.buildRuntime() must forward
 * that callback's messages to `deps.setDelegatePromptGuidelineWarnings` for the root-session
 * delegate tool specifically (the one wired here with `caller: { kind: "session_root" }`) — the
 * nested/worker delegate tool wires its own `warn` in worker-delegation-controller.ts, covered
 * separately. Mocks createDelegateToolDefinition so this test controls exactly what `warn` receives,
 * rather than needing real content that organically overflows the 1200-char guidelines budget
 * (every field feeding that path is independently capped short, making genuine overflow through
 * realistic content impractical to construct deterministically).
 */

const capturedWarn: { fn?: (message: string) => void } = {};

vi.mock("../src/core/tools/delegate.ts", () => ({
	createDelegateToolDefinition: (deps: { warn?: (message: string) => void }) => {
		capturedWarn.fn = deps.warn;
		return {
			name: "delegate",
			label: "delegate",
			description: "fake delegate tool for the RuntimeBuilder diagnostics wiring test",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: undefined }),
		};
	},
}));

function unreachable(name: string): never {
	throw new Error(`${name} should not be called by a buildRuntime() restricted to the delegate tool`);
}

function makeDeps(
	cwd: string,
	resourceLoader: ResourceLoader,
): { deps: RuntimeBuilderDeps; getWarnings: () => string[] } {
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory();
	const model = { provider: "faux", id: "faux-model", contextWindow: 100_000 } as unknown as Model<any>;
	const agent = {
		state: { model, thinkingLevel: "medium", tools: [], systemPrompt: "" },
	} as unknown as Agent;

	let extensionRunner = new ExtensionRunner([], createExtensionRuntime(), cwd, sessionManager, modelRegistry);
	let baseSystemPrompt = "";
	let requestedActiveToolNames: string[] | undefined;
	let unboundToolGrantWarnings: string[] = [];
	let delegatePromptGuidelineWarnings: string[] = [];
	const skillVault = new SkillVaultController({ getSkills: () => resourceLoader.getActiveSkills() });

	const deps: RuntimeBuilderDeps = {
		getAgent: () => agent,
		getCwd: () => cwd,
		getShellSessionKey: () => "test-shell-session",
		getAgentDir: () => cwd,
		getLaneWorkerRefusal: () => undefined,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => settingsManager,
		getModelRegistry: () => modelRegistry,
		isModelExhausted: () => false,
		getResourceLoader: () => resourceLoader,
		getSkillVault: () => skillVault,
		getExtensionRunner: () => extensionRunner,
		setExtensionRunner: (runner) => {
			extensionRunner = runner;
		},
		getBaseSystemPrompt: () => baseSystemPrompt,
		setBaseSystemPrompt: (prompt) => {
			baseSystemPrompt = prompt;
		},
		getCustomTools: () => [],
		// No override: the real built-in tool-factory block runs, restricted to just "delegate" via
		// getToolProfileFilter below so every other factory (goal/task-steps/model-fitness/scout/
		// toolkit-script/worktree-sync) stays unreached, matching this test's narrow scope.
		getBaseToolsOverride: () => undefined,
		getRequestedActiveToolNames: () => requestedActiveToolNames,
		setRequestedActiveToolNames: (names) => {
			requestedActiveToolNames = names;
		},
		getToolProfileFilter: () => ({ allow: ["delegate"], block: [] }),
		setToolProfileFilter: () => {},
		getAllowedToolNames: () => undefined,
		getExcludedToolNames: () => undefined,
		deriveToolProfileFilter: () => ({ allow: ["delegate"], block: [] }),
		isToolOrCommandAllowedByProfile: () => true,
		isExtensionPathAllowed: (_path, authority) => authority === "explicit",
		filterExtensionsForRuntime: (extensions) => extensions,
		setUnboundToolGrantWarnings: (warnings) => {
			unboundToolGrantWarnings = warnings;
		},
		getUnboundToolGrantWarnings: () => unboundToolGrantWarnings,
		setDelegatePromptGuidelineWarnings: (warnings) => {
			delegatePromptGuidelineWarnings = warnings;
		},
		createProfileFilterReloadSnapshot: () => ({}) as never,
		restoreProfileFilterReloadSnapshot: () => {},
		getActiveToolNames: () => [],
		setActiveToolsByName: () => {},
		normalizePromptSnippet: (text) => text,
		normalizePromptGuidelines: (guidelines) => guidelines ?? [],
		bindExtensionCore: () => {},
		applyExtensionBindings: () => {},
		extendResourcesFromExtensions: () => unreachable("extendResourcesFromExtensions"),
		reapplyActiveProfileModelSettings: async () => {},
		notifyExtensionsChanged: () => unreachable("notifyExtensionsChanged"),
		getToolArtifactStore: () => unreachable("getToolArtifactStore"),
		getSessionImageStore: () => undefined,
		getMemoryManager: () => ({ getToolDefinitions: () => [] }) as unknown as MemoryManager,
		getMemoryAuditDiagnostics: () => unreachable("getMemoryAuditDiagnostics"),
		clearPendingMemoryProviders: () => {},
		createMemoryReloadSnapshot: () => ({}) as never,
		restoreMemoryReloadSnapshot: () => {},
		initializeMemory: async () => {},
		getGoalStateSnapshot: () => unreachable("getGoalStateSnapshot"),
		saveGoalStateSnapshot: () => unreachable("saveGoalStateSnapshot"),
		getTaskStepsStateSnapshot: () => unreachable("getTaskStepsStateSnapshot"),
		saveTaskStepsStateSnapshot: () => unreachable("saveTaskStepsStateSnapshot"),
		getPipelineRunSnapshot: () => undefined,
		savePipelineRunSnapshot: () => unreachable("savePipelineRunSnapshot"),
		getContextGcReport: () => unreachable("getContextGcReport"),
		startWorkerDelegation: () => unreachable("startWorkerDelegation"),
		getOrchestrationProfileCatalog: () => [],
		getWorkerLaneRecords: () => unreachable("getWorkerLaneRecords"),
		getWorkerClaimSnapshots: () => unreachable("getWorkerClaimSnapshots"),
		resolveManagedLaneId: () => unreachable("resolveManagedLaneId"),
		runWorkerDelegationOnce: () => unreachable("runWorkerDelegationOnce"),
		runModelFitness: () => unreachable("runModelFitness"),
		resolveCurationModelIfFit: () => unreachable("resolveCurationModelIfFit"),
		runIsolatedCompletion: () => unreachable("runIsolatedCompletion"),
		addSpawnedUsage: () => unreachable("addSpawnedUsage"),
		createAgentContextSnapshot: () => ({}) as unknown as AgentContext,
		getContextUsage: () => undefined,
		isStreaming: () => false,
		isCompacting: () => false,
		getExtensionUIContext: () => undefined,
		getExtensionCommandContextActions: () => undefined,
		getExtensionShutdownHandler: () => undefined,
		getExtensionErrorListener: () => undefined,
	};

	return { deps, getWarnings: () => delegatePromptGuidelineWarnings };
}

describe("RuntimeBuilder — root-session delegate prompt-guideline bounding diagnostics", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
		capturedWarn.fn = undefined;
	});

	function buildResourceLoader(): ResourceLoader {
		const extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		return {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getActiveSkills: () => [],
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getActivePrompts: () => [],
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getActiveThemes: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getAgentsDiagnostics: () => [],
			getDiscoverableSkillPaths: () => [],
			getDiscoverablePromptPaths: () => [],
			getDiscoverableAgentsFilePaths: () => [],
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getLoadedExtension: () => undefined,
			removeLoadedExtension: () => undefined,
			loadSingleExtension: async () => ({ extension: null, error: "Not implemented" }),
			extendResources: () => {},
			reload: async () => {},
			getDiscoverableExtensionPaths: async () => [],
		};
	}

	it("forwards createDelegateToolDefinition's warn callback to deps.setDelegatePromptGuidelineWarnings", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-delegate-diagnostics-"));
		const { deps, getWarnings } = makeDeps(tempDir, buildResourceLoader());
		const runtimeBuilder = new RuntimeBuilder(deps);

		runtimeBuilder.buildRuntime({});

		expect(capturedWarn.fn).toBeInstanceOf(Function);
		expect(getWarnings()).toEqual([]);

		capturedWarn.fn?.('Provider tool guideline dropped: guidelines budget exhausted: "..."');

		expect(getWarnings()).toEqual(['Provider tool guideline dropped: guidelines budget exhausted: "..."']);
	});

	it("clears stale warnings on a rebuild that no longer overflows", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-delegate-diagnostics-clear-"));
		const { deps, getWarnings } = makeDeps(tempDir, buildResourceLoader());
		const runtimeBuilder = new RuntimeBuilder(deps);

		runtimeBuilder.buildRuntime({});
		capturedWarn.fn?.("stale warning from a prior build");
		expect(getWarnings()).toEqual(["stale warning from a prior build"]);

		runtimeBuilder.buildRuntime({});

		expect(getWarnings()).toEqual([]);
	});
});
