import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createTestExtensionsResult } from "../../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

function makeExtension(version: "old" | "new") {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "hot_reload",
			label: "Hot Reload",
			description: "Reload extension runtime during an active tool loop",
			parameters: Type.Object({}, { additionalProperties: false }),
			executionMode: "sequential",
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				await ctx.reload();
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

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refuses active-tool reload before the tool context can be replaced", async () => {
		let extensionsResult = await createTestExtensionsResult([makeExtension("old")]);
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
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hot_reload", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("reload then use new schema");

		const hotReloadResult = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "hot_reload");
		const schemaResult = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "schema_tool");
		expect(reloadCount).toBe(0);
		expect(hotReloadResult?.isError).toBe(true);
		expect(schemaResult).toBeUndefined();
		expect(getAssistantTexts(harness)).toContain("done");
	});
});
