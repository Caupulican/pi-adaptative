import type { Agent, AgentContext, AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeBuilder, type RuntimeBuilderDeps } from "../src/core/runtime-builder.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { LoadExtensionsResult, ResourceLoader } from "../src/index.ts";

/**
 * D2: the strict worker UAC ceiling (WORKER_FORBIDDEN_TOOLS, session-role.ts) is the FIRST line of
 * `refreshToolRegistry`'s `isAllowedTool` predicate -- it must win even when an allow-list
 * EXPLICITLY grants a forbidden tool by name (the "Strict UAC" auto-activation further down would
 * otherwise activate any explicitly-granted tool from the registry).
 *
 * Constructs RuntimeBuilder DIRECTLY (same rationale as
 * runtime-builder-reload-reconcile.test.ts: this repo bans cast-wired private access) and drives
 * `buildRuntime()` with a `getBaseToolsOverride` supplying four minimal fake tools -- this skips
 * the entire real built-in tool-factory block (goal/task-steps/delegate/model-fitness/scout/
 * toolkit-script/worktree-sync), which is irrelevant to the ceiling itself: the ceiling gates on
 * NAME alone, regardless of which factory produced the definition.
 */

function fakeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `fake ${name} for the worker-ceiling test`,
		parameters: { type: "object", properties: {} } as never,
		execute: async () => ({ content: [], details: undefined }),
	};
}

function unreachable(name: string): never {
	throw new Error(`${name} should not be called by a buildRuntime() with getBaseToolsOverride set`);
}

function makeDeps(cwd: string): RuntimeBuilderDeps {
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
	const extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const resourceLoader: ResourceLoader = {
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
		reload: async () => unreachable("resourceLoader.reload"),
		getDiscoverableExtensionPaths: async () => [],
	};

	return {
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
		getExtensionRunner: () => extensionRunner,
		setExtensionRunner: (runner) => {
			extensionRunner = runner;
		},
		getBaseSystemPrompt: () => baseSystemPrompt,
		setBaseSystemPrompt: (prompt) => {
			baseSystemPrompt = prompt;
		},
		getCustomTools: () => [],
		// Truthy override skips the entire built-in diagnostics/goal/task-steps/delegate/model-
		// fitness/scout/toolkit-script/worktree-sync tool creation block -- irrelevant to a ceiling
		// that gates purely on tool NAME. Four fake tools stand in for two forbidden (goal, python)
		// and two never-forbidden (read, edit) names.
		getBaseToolsOverride: () => ({
			goal: fakeTool("goal"),
			python: fakeTool("python"),
			read: fakeTool("read"),
			edit: fakeTool("edit"),
		}),
		getRequestedActiveToolNames: () => requestedActiveToolNames,
		setRequestedActiveToolNames: (names) => {
			requestedActiveToolNames = names;
		},
		getToolProfileFilter: () => undefined,
		setToolProfileFilter: () => {},
		// The allow-list EXPLICITLY grants every one of the four tools, including the two
		// worker-forbidden ones -- the point of this test is that the ceiling wins anyway.
		getAllowedToolNames: () => new Set(["goal", "python", "read", "edit"]),
		getExcludedToolNames: () => undefined,
		deriveToolProfileFilter: () => unreachable("deriveToolProfileFilter"),
		isToolOrCommandAllowedByProfile: () => false,
		filterExtensionsForRuntime: (extensions) => extensions,
		setUnboundToolGrantWarnings: (warnings) => {
			unboundToolGrantWarnings = warnings;
		},
		getUnboundToolGrantWarnings: () => unboundToolGrantWarnings,
		createProfileFilterReloadSnapshot: () => unreachable("createProfileFilterReloadSnapshot"),
		restoreProfileFilterReloadSnapshot: () => unreachable("restoreProfileFilterReloadSnapshot"),
		getActiveToolNames: () => [],
		setActiveToolsByName: () => {},
		normalizePromptSnippet: (text) => text,
		normalizePromptGuidelines: (guidelines) => guidelines ?? [],
		bindExtensionCore: () => {},
		applyExtensionBindings: () => {},
		extendResourcesFromExtensions: () => unreachable("extendResourcesFromExtensions"),
		reapplyActiveProfileModelSettings: async () => unreachable("reapplyActiveProfileModelSettings"),
		notifyExtensionsChanged: () => unreachable("notifyExtensionsChanged"),
		getToolArtifactStore: () => unreachable("getToolArtifactStore"),
		getMemoryManager: () => ({ getToolDefinitions: () => [] }) as unknown as MemoryManager,
		getMemoryAuditDiagnostics: () => unreachable("getMemoryAuditDiagnostics"),
		clearPendingMemoryProviders: () => unreachable("clearPendingMemoryProviders"),
		createMemoryReloadSnapshot: () => unreachable("createMemoryReloadSnapshot"),
		restoreMemoryReloadSnapshot: () => unreachable("restoreMemoryReloadSnapshot"),
		initializeMemory: async () => unreachable("initializeMemory"),
		getGoalStateSnapshot: () => unreachable("getGoalStateSnapshot"),
		saveGoalStateSnapshot: () => unreachable("saveGoalStateSnapshot"),
		getTaskStepsStateSnapshot: () => unreachable("getTaskStepsStateSnapshot"),
		saveTaskStepsStateSnapshot: () => unreachable("saveTaskStepsStateSnapshot"),
		getContextGcReport: () => unreachable("getContextGcReport"),
		startWorkerDelegation: () => unreachable("startWorkerDelegation"),
		getWorkerLaneRecords: () => unreachable("getWorkerLaneRecords"),
		getWorkerResultSnapshots: () => unreachable("getWorkerResultSnapshots"),
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
	} satisfies RuntimeBuilderDeps;
}

const PI_SESSION_ROLE_ENV = "PI_SESSION_ROLE";

describe("RuntimeBuilder worker UAC ceiling (D2)", () => {
	const originalRole = process.env[PI_SESSION_ROLE_ENV];

	afterEach(() => {
		if (originalRole === undefined) delete process.env[PI_SESSION_ROLE_ENV];
		else process.env[PI_SESSION_ROLE_ENV] = originalRole;
	});

	it("removes worker-forbidden tools even when an allow-list explicitly grants them, keeping non-forbidden tools", () => {
		process.env[PI_SESSION_ROLE_ENV] = "worker";
		try {
			const runtimeBuilder = new RuntimeBuilder(makeDeps("/tmp/pi-worker-ceiling-test"));
			runtimeBuilder.buildRuntime({ activeToolNames: ["goal", "python", "read", "edit"] });

			expect(runtimeBuilder.getToolDefinition("goal")).toBeUndefined();
			expect(runtimeBuilder.getToolDefinition("python")).toBeUndefined();
			expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).not.toContain("goal");
			expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).not.toContain("python");

			expect(runtimeBuilder.getToolDefinition("read")).toBeDefined();
			expect(runtimeBuilder.getToolDefinition("edit")).toBeDefined();
			expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["read", "edit"]),
			);
		} finally {
			if (originalRole === undefined) delete process.env[PI_SESSION_ROLE_ENV];
			else process.env[PI_SESSION_ROLE_ENV] = originalRole;
		}
	});

	it("keeps the same build byte-identical (all four tools present) for a main session", () => {
		delete process.env[PI_SESSION_ROLE_ENV];
		const runtimeBuilder = new RuntimeBuilder(makeDeps("/tmp/pi-worker-ceiling-test-main"));
		runtimeBuilder.buildRuntime({ activeToolNames: ["goal", "python", "read", "edit"] });

		expect(runtimeBuilder.getToolDefinition("goal")).toBeDefined();
		expect(runtimeBuilder.getToolDefinition("python")).toBeDefined();
		expect(runtimeBuilder.getToolDefinition("read")).toBeDefined();
		expect(runtimeBuilder.getToolDefinition("edit")).toBeDefined();
		expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["goal", "python", "read", "edit"]),
		);
	});
});
