import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { projectToolsForProvider } from "@caupulican/pi-agent-core/provider-tool-projection";
import { getModel } from "@caupulican/pi-ai";
import { xaiOAuthProvider } from "@caupulican/pi-ai/oauth";
import { streamOpenAIResponses } from "@caupulican/pi-ai/openai-responses";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";

describe.each(["grok-4.5", "grok-4.6"] as const)("xAI default tool schemas (%s)", (modelId) => {
	it("serializes every packaged tool with an object root for subscription requests", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-xai-schema-"));
		const model = xaiOAuthProvider.modifyModels?.([getModel("xai", modelId)], {
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 60_000,
		})?.[0];
		if (model?.api !== "openai-responses") throw new Error("Missing subscription model");
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model,
			authStorage: AuthStorage.inMemory(),
			sessionManager: SessionManager.inMemory(),
		});
		try {
			const tools = projectToolsForProvider(
				session.getActiveToolNames().map((name) => {
					const tool = session.getToolDefinition(name);
					if (!tool) throw new Error(`Missing tool: ${name}`);
					return tool;
				}),
			);
			expect(tools.some((tool) => tool.name === "memory")).toBe(true);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					tools: Array<{ name: string; parameters: { type?: string }; strict?: boolean }>;
				};
				expect(body.tools).toHaveLength(tools.length);
				expect(body.tools.filter((tool) => tool.parameters.type !== "object").map((tool) => tool.name)).toEqual([]);
				for (const tool of body.tools) {
					expect(tool.parameters.type, tool.name).toBe("object");
					expect(tool).not.toHaveProperty("strict");
				}
				return new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp_schema",
							status: "completed",
							output: [
								{
									type: "message",
									id: "msg_schema",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "hello", annotations: [] }],
								},
							],
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			});
			try {
				const result = await streamOpenAIResponses(
					{ ...model, api: "openai-responses" },
					{
						messages: [{ role: "user", content: "hi", timestamp: 1 }],
						tools,
					},
					{ apiKey: "test-access" },
				).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				fetchMock.mockRestore();
			}
		} finally {
			await session.disposeAndWait();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
