import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentContext } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { capabilityTierPolicy } from "../src/core/capability-tier.ts";
import { ExtensionRunner } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeBuilder, type RuntimeBuilderDeps } from "../src/core/runtime-builder.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import type { Skill } from "../src/core/skills.ts";
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
	throw new Error(`${name} should not be called by a restricted buildRuntime()`);
}

function makeDeps(
	cwd: string,
	resourceLoader: ResourceLoader,
	allowedTools: string[] = ["delegate"],
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
		getCapabilityTierPolicy: () => capabilityTierPolicy("frontier"),
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
		// No override: the real built-in tool-factory block runs, restricted through the explicit
		// profile below so unrelated factories stay unreached and each test owns a narrow surface.
		getBaseToolsOverride: () => undefined,
		getRequestedActiveToolNames: () => requestedActiveToolNames,
		setRequestedActiveToolNames: (names) => {
			requestedActiveToolNames = names;
		},
		getToolProfileFilter: () => ({ allow: allowedTools, block: [] }),
		setToolProfileFilter: () => {},
		getAllowedToolNames: () => undefined,
		getExcludedToolNames: () => undefined,
		deriveToolProfileFilter: () => ({ allow: allowedTools, block: [] }),
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

	it("supplies resource-loader-admitted skills to both built-in audit tools", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-builder-skill-tools-"));
		const baseDir = join(tempDir, "skills", "admitted-runtime-skill");
		const filePath = join(baseDir, "SKILL.md");
		const admittedSkill: Skill = {
			name: "admitted-runtime-skill",
			description: "An admitted runtime skill",
			filePath,
			baseDir,
			sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: false,
		};
		const getSkills = vi.fn(() => ({ skills: [admittedSkill], diagnostics: [] }));
		const resourceLoader: ResourceLoader = {
			...buildResourceLoader(),
			getSkills,
			getActiveSkills: () => [admittedSkill],
		};
		const { deps } = makeDeps(tempDir, resourceLoader, ["skill_audit", "skillify"]);
		const runtimeBuilder = new RuntimeBuilder(deps);
		runtimeBuilder.buildRuntime({ activeToolNames: ["skill_audit", "skillify"] });
		const signal = new AbortController().signal;

		const auditResult = await runtimeBuilder.getRegisteredTool("skill_audit")?.execute("audit", {}, signal);
		const skillifyResult = await runtimeBuilder.getRegisteredTool("skillify")?.execute(
			"skillify",
			{
				name: "runtime-builder-proposal",
				description: "A distinct runtime builder proposal",
				body: "# Runtime builder proposal",
			},
			signal,
		);

		expect(auditResult?.details).toMatchObject({
			skills: [{ name: admittedSkill.name, path: filePath, scope: "user" }],
		});
		expect(skillifyResult?.details).toMatchObject({
			audit: { skills: [{ name: admittedSkill.name, path: filePath, scope: "user" }] },
		});
		expect(getSkills).toHaveBeenCalledTimes(2);
	});

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
