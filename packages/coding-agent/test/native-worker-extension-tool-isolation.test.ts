import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarness } from "./suite/harness.ts";

function registerSearchTool(pi: ExtensionAPI, name: string, calls: string[]): void {
	pi.registerTool({
		name,
		label: name,
		description: `Foreground-only ${name} test tool`,
		parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
		execute: async (_toolCallId, params: { query: string }) => {
			calls.push(`${name}:${params.query}`);
			return {
				content: [{ type: "text" as const, text: `${name} result` }],
				details: { name, query: params.query },
			};
		},
	});
}

describe("native worker extension tool isolation", () => {
	it("keeps live foreground web and MCP extension instances out of a native worker lane", async () => {
		const extensionCalls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerSearchTool(pi, "fetch", extensionCalls);
					registerSearchTool(pi, "web_search", extensionCalls);
					registerSearchTool(pi, "mcp_search", extensionCalls);
				},
			],
			initialActiveToolNames: ["read", "fetch", "web_search", "mcp_search", "delegate"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		let workerToolNames: string[] = [];
		try {
			expect(harness.session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["fetch", "web_search", "mcp_search"]),
			);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("web_search", { query: "foreground proof" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("foreground complete"),
				(context) => {
					workerToolNames = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage('{"summary":"isolated extension surface","status":"completed"}');
				},
			]);

			await harness.session.prompt("Use the foreground web search tool.");
			expect(extensionCalls).toEqual(["web_search:foreground proof"]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use only worker-safe inherited tools.",
			});

			expect(run.started).toBe(true);
			expect(workerToolNames).not.toContain("fetch");
			expect(workerToolNames).not.toContain("web_search");
			expect(workerToolNames).not.toContain("mcp_search");
			expect(extensionCalls).toEqual(["web_search:foreground proof"]);
		} finally {
			await harness.cleanup();
		}
	});

	it.each(["fetch", "web_search", "mcp_search"])(
		"rejects an explicit unsupported %s request before lane or provider creation",
		async (toolName) => {
			const extensionCalls: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						registerSearchTool(pi, "fetch", extensionCalls);
						registerSearchTool(pi, "web_search", extensionCalls);
						registerSearchTool(pi, "mcp_search", extensionCalls);
					},
				],
				initialActiveToolNames: ["read", "fetch", "web_search", "mcp_search", "delegate"],
				settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
			});
			try {
				const run = await harness.session.runWorkerDelegationOnce({
					instructions: `Do not silently substitute for ${toolName}.`,
					authority: { toolNames: [toolName] },
				});

				expect(run).toEqual({ started: false, skipReason: `orchestration_tool_unavailable:${toolName}` });
				expect(harness.session.getLaneRecords()).toEqual([]);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(extensionCalls).toEqual([]);
			} finally {
				await harness.cleanup();
			}
		},
	);
});
