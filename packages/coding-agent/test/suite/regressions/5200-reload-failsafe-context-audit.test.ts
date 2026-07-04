import { existsSync, mkdirSync, rmSync } from "node:fs";
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
