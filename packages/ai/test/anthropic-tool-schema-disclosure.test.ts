import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { TOOL_SCHEMA_SEARCH_DETAILS_KIND, TOOL_SCHEMA_SEARCH_NAME } from "../src/tool-schema-disclosure.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
	message: AssistantMessage;
}

const minimalSse = [
	{
		event: "message_start",
		data: {
			type: "message_start",
			message: { id: "msg_disclosure", usage: { input_tokens: 1, output_tokens: 0 } },
		},
	},
	{
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	},
	{ event: "message_stop", data: { type: "message_stop" } },
]
	.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	.join("");

function createModel(baseUrl: string, supportsToolSearch = true): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		compat: { supportsToolSearch },
	};
}

function tool(name: string): Tool {
	return {
		name,
		description: name === "memory" ? "query durable memories" : `${name} capability`,
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
	};
}

function tools(): Tool[] {
	return [
		tool(TOOL_SCHEMA_SEARCH_NAME),
		tool("read"),
		tool("bash"),
		tool("edit"),
		tool("write"),
		tool("delegate"),
		tool("memory"),
		tool("pipeline"),
		tool("image_generate"),
		tool("secret_store"),
		tool("task_steps"),
	];
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function capture(
	context: Context,
	supportsToolSearch = true,
	toolChoice?: { type: "tool"; name: string },
	apiKey = "test-key",
	injectClient = false,
): Promise<CapturedRequest> {
	let captured: Omit<CapturedRequest, "message"> | undefined;
	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		captured = { headers: request.headers, body: await readRequestBody(request) };
		response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
		response.end(minimalSse);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		const stream = streamAnthropic(createModel(baseUrl, supportsToolSearch), context, {
			apiKey,
			cacheRetention: "short",
			toolChoice,
			...(injectClient
				? { client: new Anthropic({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true }) }
				: {}),
		});
		const message = await stream.result();
		if (!captured) throw new Error("Anthropic request was not captured");
		return { ...captured, message };
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

function requestTools(body: Record<string, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(body.tools)) throw new Error("Expected tools in request body");
	return body.tools as Record<string, unknown>[];
}

describe("Anthropic deferred tool schema disclosure", () => {
	it("defers non-core schemas, keeps a legal cache marker, and sends the installed-client beta", async () => {
		const request = await capture({ messages: [{ role: "user", content: "work", timestamp: 0 }], tools: tools() });
		const byName = new Map(requestTools(request.body).map((entry) => [entry.name, entry]));

		expect(request.headers["anthropic-beta"]).toContain("tool-search-tool-2025-10-19");
		expect(byName.get(TOOL_SCHEMA_SEARCH_NAME)?.defer_loading).toBeUndefined();
		expect(byName.get("read")?.defer_loading).toBeUndefined();
		expect(byName.get("memory")?.defer_loading).toBe(true);
		expect(byName.get("memory")?.cache_control).toBeUndefined();
		expect([...byName.values()].filter((entry) => entry.cache_control !== undefined)).toHaveLength(1);
		expect(request.message.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "tool_schema_disclosure",
				details: expect.objectContaining({ totalToolCount: 11, eagerToolCount: 5, deferredToolCount: 6 }),
			}),
		);
	});

	it("fails open when the endpoint explicitly lacks tool search", async () => {
		const request = await capture(
			{ messages: [{ role: "user", content: "work", timestamp: 0 }], tools: tools() },
			false,
		);

		const sentTools = requestTools(request.body);
		expect(sentTools.every((entry) => entry.defer_loading === undefined)).toBe(true);
		expect(sentTools.map((entry) => entry.name)).not.toContain(TOOL_SCHEMA_SEARCH_NAME);
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("tool-search-tool-2025-10-19");
	});

	it("omits synthetic search when the real tool surface is below the disclosure threshold", async () => {
		const request = await capture({
			messages: [{ role: "user", content: "work", timestamp: 0 }],
			tools: tools().slice(0, 10),
		});
		const sentTools = requestTools(request.body);

		expect(sentTools).toHaveLength(9);
		expect(sentTools.every((entry) => entry.defer_loading === undefined)).toBe(true);
		expect(sentTools.map((entry) => entry.name)).not.toContain(TOOL_SCHEMA_SEARCH_NAME);
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("tool-search-tool-2025-10-19");
	});

	it("keeps schemas eager when a caller-owned SDK client owns the beta-header lifecycle", async () => {
		const request = await capture(
			{ messages: [{ role: "user", content: "work", timestamp: 0 }], tools: tools() },
			true,
			undefined,
			"test-key",
			true,
		);

		const sentTools = requestTools(request.body);
		expect(sentTools.every((entry) => entry.defer_loading === undefined)).toBe(true);
		expect(sentTools.map((entry) => entry.name)).not.toContain(TOOL_SCHEMA_SEARCH_NAME);
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("tool-search-tool-2025-10-19");
	});

	it("rejects a forced synthetic search when disclosure is unavailable", async () => {
		const message = await streamAnthropic(
			createModel("https://unsupported.example.test", false),
			{ messages: [{ role: "user", content: "work", timestamp: 0 }], tools: tools() },
			{
				apiKey: "test-key",
				toolChoice: { type: "tool", name: TOOL_SCHEMA_SEARCH_NAME },
			},
		).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("tool_search cannot be forced");
	});

	it("uses the installed Claude subscription name and beta contract for OAuth requests", async () => {
		const request = await capture(
			{ messages: [{ role: "user", content: "work", timestamp: 0 }], tools: tools() },
			true,
			undefined,
			"sk-ant-oat01-test",
		);
		const byName = new Map(requestTools(request.body).map((entry) => [entry.name, entry]));

		expect(request.headers["anthropic-beta"]).toContain("claude-code-20250219");
		expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(request.headers["anthropic-beta"]).toContain("tool-search-tool-2025-10-19");
		expect(byName.get("ToolSearch")?.defer_loading).toBeUndefined();
		expect(byName.get("memory")?.defer_loading).toBe(true);
	});

	it("materializes current-surface tool references from a client search result", async () => {
		const request = await capture({
			messages: [
				{ role: "user", content: "find a memory tool", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "search-1", name: TOOL_SCHEMA_SEARCH_NAME, arguments: { query: "memory" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-4-8",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "search-1",
					toolName: TOOL_SCHEMA_SEARCH_NAME,
					content: [{ type: "text", text: "search accepted" }],
					details: { kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND, query: "memory", maxResults: 5 },
					isError: false,
					timestamp: 0,
				},
			],
			tools: tools(),
		});
		const messages = request.body.messages as Array<{ role: string; content: unknown }>;
		const user = messages.at(-1) as { content: Array<{ type: string; content: unknown }> };
		const result = user.content[0] as { content: Array<Record<string, unknown>> };

		expect(result.content).toEqual([{ type: "tool_reference", tool_name: "memory" }]);
	});

	it("makes a forced deferred tool eager without attaching a cache marker to another deferred schema", async () => {
		const request = await capture(
			{ messages: [{ role: "user", content: "use memory", timestamp: 0 }], tools: tools() },
			true,
			{ type: "tool", name: "memory" },
		);
		const byName = new Map(requestTools(request.body).map((entry) => [entry.name, entry]));

		expect(byName.get("memory")?.defer_loading).toBeUndefined();
		expect(byName.get("memory")?.cache_control).toBeDefined();
		expect([...byName.values()].filter((entry) => entry.cache_control !== undefined)).toHaveLength(1);
	});

	it("never replays a reference to a tool removed from the current request surface", async () => {
		const currentTools = tools().map((entry) => (entry.name === "memory" ? tool("queue") : entry));
		const request = await capture({
			messages: [
				{ role: "user", content: "find a memory tool", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "search-stale",
							name: TOOL_SCHEMA_SEARCH_NAME,
							arguments: { query: "memory" },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-4-8",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "search-stale",
					toolName: TOOL_SCHEMA_SEARCH_NAME,
					content: [{ type: "text", text: "old result" }],
					details: { kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND, query: "memory", maxResults: 5 },
					isError: false,
					timestamp: 0,
				},
			],
			tools: currentTools,
		});
		const messages = request.body.messages as Array<{ role: string; content: unknown }>;
		const user = messages.at(-1) as { content: Array<{ type: string; content: unknown }> };
		const result = user.content[0] as { content: unknown };

		expect(result.content).toBe("No matching deferred tools found.");
	});
});
