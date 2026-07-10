import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createTestExtensionsResult } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

function reloadableOldExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "hot_reload",
		label: "Hot Reload",
		description: "Trigger reload from a tool",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			await ctx.reload();
			return { content: [{ type: "text" as const, text: "reloaded" }], details: {} };
		},
	});
	pi.registerTool({
		name: "old_tool",
		label: "Old Tool",
		description: "Old valid tool that must survive failed reload",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => ({ content: [{ type: "text" as const, text: "old-ok" }], details: {} }),
	});
}

const previousMemoryProvider = {
	name: "previous-memory",
	isAvailable: () => true,
	getCapabilities: () => ({ surfaces: ["context" as const] }),
	initialize: async () => {},
	shutdown: async () => {},
	systemPromptBlock: () => "PREVIOUS-MEMORY-GENERATION",
};

function previousMemoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "stable_tool",
		label: "Stable Tool",
		description: "Tool used to distinguish profile-filter diagnostics across reload generations",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => ({ content: [{ type: "text" as const, text: "stable" }], details: {} }),
	});
	pi.on("session_start", () => {
		pi.registerMemoryProvider(previousMemoryProvider);
	});
}

function failingReloadExtension(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		throw new Error("new generation startup failed");
	});
}

describe("reload failsafe and context audit", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restores the previous in-memory extension/tool runtime when hot reload produces extension errors", async () => {
		let extensionsResult = await createTestExtensionsResult([reloadableOldExtension]);
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
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getLoadedExtension: () => undefined,
			removeLoadedExtension: () => undefined,
			loadSingleExtension: async () => ({ extension: null, error: "Not implemented" }),
			extendResources: () => {},
			reload: async () => {
				reloadCount += 1;
				extensionsResult = {
					extensions: [],
					errors: [{ path: "broken-extension.ts", error: "Failed to load extension: boom" }],
					runtime: createExtensionRuntime(),
				};
			},
			getDiscoverableExtensionPaths: async () => extensionsResult.extensions.map((e) => e.path),
			getAgentsDiagnostics: () => [],
			getDiscoverableSkillPaths: () => [],
			getDiscoverablePromptPaths: () => [],
			getDiscoverableAgentsFilePaths: () => [],
		};

		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		await expect(harness.session.reload()).rejects.toThrow(/Extension reload failed/i);

		expect(reloadCount).toBe(1);
		const toolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(toolNames).toContain("old_tool");
		expect(toolNames).toContain("hot_reload");
		expect(harness.session.getActiveToolNames()).toContain("old_tool");
	});

	it("restores pending memory providers when a later reload phase fails", async () => {
		const tempDir = join(tmpdir(), `pi-memory-reload-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const stableSkillDir = join(agentDir, "skills", "stable-skill");
		const promptDir = join(agentDir, "prompts");
		mkdirSync(stableSkillDir, { recursive: true });
		mkdirSync(promptDir, { recursive: true });
		writeFileSync(
			join(stableSkillDir, "SKILL.md"),
			"---\nname: stable-skill\ndescription: Stable reload fixture\n---\nStable skill.\n",
		);
		writeFileSync(join(promptDir, "stable.md"), "Stable prompt.\n");
		writeFileSync(join(tempDir, "AGENTS.md"), "Stable context.\n");
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				stable: {
					model: "anthropic/claude-sonnet-4-5",
					thinking: "low",
					resources: {
						extensions: { allow: ["<inline:1>"] },
						tools: { allow: ["missing-old"] },
						agents: { allow: ["*"] },
					},
				},
				broken: {
					model: "anthropic/claude-haiku-4-5",
					thinking: "high",
					resources: {
						extensions: { allow: ["*"] },
						tools: { allow: ["stable_tool"] },
						agents: { block: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["stable"],
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [previousMemoryExtension, failingReloadExtension],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: false,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({ onError: () => {} });
		const diagnosticSession = session as unknown as {
			_unboundToolGrantWarnings: string[];
			_profileFilter: {
				_inertExtensionWarnings: string[];
				_profileDeniedExtensionCount: number;
			};
		};
		const previousDiagnostics = {
			unbound: [...diagnosticSession._unboundToolGrantWarnings],
			inert: [...diagnosticSession._profileFilter._inertExtensionWarnings],
			denied: diagnosticSession._profileFilter._profileDeniedExtensionCount,
		};
		const previousResourceState = {
			discoverableSkills: resourceLoader.getDiscoverableSkillPaths(),
			discoverablePrompts: resourceLoader.getDiscoverablePromptPaths(),
			discoverableAgents: resourceLoader.getDiscoverableAgentsFilePaths(),
			agentsDiagnostics: resourceLoader.getAgentsDiagnostics(),
		};
		expect(session.systemPrompt).toContain("PREVIOUS-MEMORY-GENERATION");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.thinkingLevel).toBe("low");
		expect(previousDiagnostics.unbound.join("\n")).toContain("missing-old");
		expect(previousDiagnostics.inert).toHaveLength(1);
		expect(previousDiagnostics.denied).toBe(1);
		expect(previousResourceState.agentsDiagnostics).toEqual([]);

		const leakedSkillDir = join(agentDir, "skills", "failed-generation-skill");
		mkdirSync(leakedSkillDir, { recursive: true });
		writeFileSync(
			join(leakedSkillDir, "SKILL.md"),
			"---\nname: failed-generation-skill\ndescription: Failed reload fixture\n---\nFailed generation.\n",
		);
		writeFileSync(join(promptDir, "failed-generation.md"), "Failed generation prompt.\n");
		writeFileSync(join(tempDir, "CLAUDE.md"), "Failed generation context.\n");

		settingsManager.setRuntimeResourceProfiles(["broken"]);
		await expect(session.reload()).rejects.toThrow(/new generation startup failed/i);
		await (session as unknown as { _memory: { initialize(): Promise<void> } })._memory.initialize();

		expect(session.systemPrompt).toContain("PREVIOUS-MEMORY-GENERATION");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.thinkingLevel).toBe("low");
		expect(diagnosticSession._unboundToolGrantWarnings).toEqual(previousDiagnostics.unbound);
		expect(diagnosticSession._profileFilter._inertExtensionWarnings).toEqual(previousDiagnostics.inert);
		expect(diagnosticSession._profileFilter._profileDeniedExtensionCount).toBe(previousDiagnostics.denied);
		expect(resourceLoader.getDiscoverableSkillPaths()).toEqual(previousResourceState.discoverableSkills);
		expect(resourceLoader.getDiscoverablePromptPaths()).toEqual(previousResourceState.discoverablePrompts);
		expect(resourceLoader.getDiscoverableAgentsFilePaths()).toEqual(previousResourceState.discoverableAgents);
		expect(resourceLoader.getAgentsDiagnostics()).toEqual(previousResourceState.agentsDiagnostics);
		session.dispose();
	});

	it("registers the built-in context_audit extension tool by default", async () => {
		const tempDir = join(tmpdir(), `pi-context-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			await session.bindExtensions({});
			expect(session.getActiveToolNames()).toContain("context_audit");
			const definition = session.getToolDefinition("context_audit");
			expect(definition).toBeDefined();
			const result = await definition!.execute(
				"audit-call",
				{ maxItems: 5 },
				new AbortController().signal,
				() => {},
				session.extensionRunner.createContext(),
			);
			const auditText = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(auditText).toContain("Context audit");
			expect(auditText).toContain("active tool schema estimate");
		} finally {
			session.dispose();
		}
	});
});
