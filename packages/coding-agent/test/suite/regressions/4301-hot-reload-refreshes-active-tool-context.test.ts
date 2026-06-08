import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createTestExtensionsResult } from "../../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

function makeExtension(version: "old" | "new", afterReload: () => void = () => {}) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "hot_reload",
			label: "Hot Reload",
			description: "Reload extension runtime during an active tool loop",
			parameters: Type.Object({}, { additionalProperties: false }),
			executionMode: "sequential",
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				await ctx.reload();
				afterReload();
				return { content: [{ type: "text" as const, text: `reloaded:${version}` }], details: { version } };
			},
		});

		pi.registerTool({
			name: "schema_tool",
			label: "Schema Tool",
			description: `Schema tool ${version}`,
			promptSnippet: `Run schema tool ${version}`,
			parameters: Type.Object({ mode: Type.Literal(version) }, { additionalProperties: false }),
			execute: async (_toolCallId, params: { mode: string }) => ({
				content: [{ type: "text" as const, text: `schema:${params.mode}` }],
				details: { mode: params.mode },
			}),
		});
	};
}

describe("hot reload active tool context", () => {
	const harnesses: Harness[] = [];
	const restoredProviders: FauxProviderRegistration[] = [];

	afterEach(() => {
		while (restoredProviders.length > 0) {
			restoredProviders.pop()?.unregister();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refreshes tool definitions before the next provider request in the same run", async () => {
		let restoreProviderAfterReset = () => {};
		let extensionsResult = await createTestExtensionsResult([
			makeExtension("old", () => restoreProviderAfterReset()),
		]);
		let reloadCount = 0;
		const resourceLoader: ResourceLoader = {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {
				reloadCount += 1;
				extensionsResult = await createTestExtensionsResult([makeExtension("new")]);
			},
		};

		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		restoreProviderAfterReset = () => {
			const model = harness.getModel();
			const restored = registerFauxProvider({
				api: harness.faux.api,
				provider: model.provider,
				models: [
					{
						id: model.id,
						name: model.name,
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					},
				],
			});
			restored.setResponses([
				() => fauxAssistantMessage(fauxToolCall("schema_tool", { mode: "new" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			restoredProviders.push(restored);
		};

		harness.setResponses([fauxAssistantMessage(fauxToolCall("hot_reload", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("reload then use new schema");

		const schemaResult = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "schema_tool");
		expect(reloadCount).toBe(1);
		expect(schemaResult?.isError).toBe(false);
		expect(schemaResult?.result.content[0]?.text).toBe("schema:new");
		expect(getAssistantTexts(harness)).toContain("done");
	});
});
