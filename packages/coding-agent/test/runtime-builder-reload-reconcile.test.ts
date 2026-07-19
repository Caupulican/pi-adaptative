import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentContext } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { registerInFlightWork, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { RuntimeBuilder, type RuntimeBuilderDeps } from "../src/core/runtime-builder.ts";
import type { ResourceProfileFilterSettings } from "../src/core/settings-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { LoadExtensionsResult, ResourceLoader } from "../src/index.ts";

/**
 * RuntimeBuilder's reload path must call the optional `reconcileLocalRuntimes` hook
 * exactly once, and ONLY once a reload generation has fully committed — never on a failed/rolled-
 * back reload, since a rollback restores the PREVIOUS configuration and nothing became ineligible.
 * The hook itself (what counts as "eligible" and how it maps to LocalRuntimeController.reconcile) is
 * the host's job to supply — this only pins the timing contract RuntimeBuilder owns.
 *
 * Constructs RuntimeBuilder DIRECTLY with a hand-built RuntimeBuilderDeps object this test holds a
 * reference to, rather than going through AgentSession and reaching into its private
 * `_runtimeBuilder` field — this repo bans cast-wired private access (tsc rejects an intersection
 * with a class that carries the same-named private member; biome --unsafe has also deleted fields
 * only reachable that way). Everything RuntimeBuilder actually touches on a successful reload with
 * an empty extension/tool surface is stubbed for real; anything genuinely unreached in that path
 * throws loudly if the assumption is ever wrong, instead of silently misbehaving.
 */

function unreachable(name: string): never {
	throw new Error(`${name} should not be called by a reload with an empty extension/tool surface`);
}

interface TestDeps {
	deps: RuntimeBuilderDeps;
	getCalls: () => number;
}

function makeDeps(cwd: string, resourceLoader: ResourceLoader): TestDeps {
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
	let toolProfileFilter: Required<ResourceProfileFilterSettings> | undefined;
	let unboundToolGrantWarnings: string[] = [];
	let calls = 0;

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
		getExtensionRunner: () => extensionRunner,
		setExtensionRunner: (runner) => {
			extensionRunner = runner;
		},
		getBaseSystemPrompt: () => baseSystemPrompt,
		setBaseSystemPrompt: (prompt) => {
			baseSystemPrompt = prompt;
		},
		getCustomTools: () => [],
		// Truthy (even empty) skips the entire built-in diagnostics/goal/task-steps/delegate/model-
		// fitness/scout/toolkit-script tool creation block in buildRuntime() — none of those deps
		// (goal state, task steps, worker delegation, model fitness, isolated completion, spawned-
		// usage) are reached by this test, so they are intentionally left unreachable below.
		getBaseToolsOverride: () => ({}),
		getRequestedActiveToolNames: () => requestedActiveToolNames,
		setRequestedActiveToolNames: (names) => {
			requestedActiveToolNames = names;
		},
		getToolProfileFilter: () => toolProfileFilter,
		setToolProfileFilter: (filter) => {
			toolProfileFilter = filter;
		},
		getAllowedToolNames: () => undefined,
		getExcludedToolNames: () => undefined,
		deriveToolProfileFilter: () => ({ allow: [], block: [] }),
		isToolOrCommandAllowedByProfile: () => false,
		filterExtensionsForRuntime: (extensions) => extensions,
		setUnboundToolGrantWarnings: (warnings) => {
			unboundToolGrantWarnings = warnings;
		},
		getUnboundToolGrantWarnings: () => unboundToolGrantWarnings,
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
		reconcileLocalRuntimes: () => {
			calls += 1;
		},
	};

	return { deps, getCalls: () => calls };
}

describe("RuntimeBuilder.reload — local-runtime reconcile hook", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("invokes reconcileLocalRuntimes exactly once after a successful reload", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-reconcile-"));
		let extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
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
			reload: async () => {
				extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
			},
			getDiscoverableExtensionPaths: async () => [],
		};

		const { deps, getCalls } = makeDeps(tempDir, resourceLoader);
		const runtimeBuilder = new RuntimeBuilder(deps);

		await runtimeBuilder.reload();

		expect(getCalls()).toBe(1);
	});

	it("does not invoke reconcileLocalRuntimes when a reload fails and rolls back", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-reconcile-fail-"));
		let extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		let reloadCount = 0;
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
			reload: async () => {
				reloadCount += 1;
				// Every generation fails the doctor check — reload() must reject and roll back.
				extensionsResult = {
					extensions: [],
					errors: [{ path: "broken-extension.ts", error: "Failed to load extension: boom" }],
					runtime: createExtensionRuntime(),
				};
			},
			getDiscoverableExtensionPaths: async () => [],
		};

		const { deps, getCalls } = makeDeps(tempDir, resourceLoader);
		const runtimeBuilder = new RuntimeBuilder(deps);

		await expect(runtimeBuilder.reload()).rejects.toThrow(/Extension reload failed/i);

		expect(reloadCount).toBe(1);
		expect(getCalls()).toBe(0);
	});
});

/**
 * The reload gate (`_assertReloadQuiescent`, shared by `reload()`/`unloadExtensionLive()`/
 * `loadExtensionLive()`/`reconcileLoadedExtensions()`) must also refuse while the in-process quiesce
 * registry (reload-blockers.ts) has a registered unit — background lanes, a scout run, or an isolated
 * completion — not just while `deps.isStreaming()`/`isCompacting()` are true. Registers directly via
 * `registerInFlightWork` (the same primitive `BackgroundLaneController`/`ScoutController` call in
 * production) rather than driving a real lane, to isolate the GATE'S behavior from lane machinery.
 */
describe("RuntimeBuilder.reload — unified quiesce registry", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
		resetInFlightWorkRegistryForTests();
	});

	function makeTrivialResourceLoader(): ResourceLoader {
		let extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
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
			reload: async () => {
				extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
			},
			getDiscoverableExtensionPaths: async () => [],
		};
	}

	it("refuses reload() while a background lane is registered, and proceeds once it deregisters", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-quiesce-"));
		const { deps, getCalls } = makeDeps(tempDir, makeTrivialResourceLoader());
		const runtimeBuilder = new RuntimeBuilder(deps);

		const deregister = registerInFlightWork(tempDir, "lane", "research:lane-1");
		await expect(runtimeBuilder.reload()).rejects.toThrow(/Cannot reload while background work is in flight/);
		expect(getCalls()).toBe(0);

		deregister();
		await runtimeBuilder.reload();
		expect(getCalls()).toBe(1);
	});

	it("refuses reload() while a scout run is registered", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-quiesce-scout-"));
		const { deps } = makeDeps(tempDir, makeTrivialResourceLoader());
		const runtimeBuilder = new RuntimeBuilder(deps);

		const deregister = registerInFlightWork(tempDir, "scout", "where is X defined");
		await expect(runtimeBuilder.reload()).rejects.toThrow(/Cannot reload while background work is in flight/);
		deregister();
		await expect(runtimeBuilder.reload()).resolves.toBeUndefined();
	});

	it("refuses reconcileLoadedExtensions() while background work is in flight (same gate, all call sites)", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-quiesce-reconcile-"));
		const { deps } = makeDeps(tempDir, makeTrivialResourceLoader());
		const runtimeBuilder = new RuntimeBuilder(deps);

		const deregister = registerInFlightWork(tempDir, "isolated-completion", "reflection");
		await expect(runtimeBuilder.reconcileLoadedExtensions()).rejects.toThrow(
			/Cannot reconcile extensions while background work is in flight/,
		);
		deregister();
	});

	it("streaming/compacting refusals stay unchanged (checked before the registry, unaffected by it)", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-quiesce-streaming-"));
		const { deps } = makeDeps(tempDir, makeTrivialResourceLoader());
		const streamingDeps: RuntimeBuilderDeps = { ...deps, isStreaming: () => true };
		const runtimeBuilder = new RuntimeBuilder(streamingDeps);

		await expect(runtimeBuilder.reload()).rejects.toThrow(
			"Cannot reload while the agent is streaming or a tool call is active",
		);
	});
});
