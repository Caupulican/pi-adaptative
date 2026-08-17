import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "../src/types.ts";
import { xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

// Regression coverage for the xAI subscription polish layer: the built-in catalog is grok-4.5
// and grok-4.6 on the Responses API. Both must echo reasoning.encrypted_content once reasoning
// is active, even when the caller requested no explicit reasoning effort (WP-7).

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function completedResponsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_xai_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				output: [
					{
						id: "msg_xai_test",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "hello from xai", annotations: [] }],
					},
				],
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** Drive a real Responses-lane request through a stubbed global fetch and capture the raw HTTP call. */
async function captureResponsesRequest(
	modelId: "grok-4.5" | "grok-4.6",
	options: Parameters<typeof streamOpenAIResponses>[2],
	requestContext: Context = context,
	modelOverride?: Model<"openai-responses">,
): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
	let capturedUrl: string | undefined;
	let capturedInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		capturedUrl = String(input);
		capturedInit = init;
		return completedResponsesSse();
	}) as typeof fetch;

	try {
		const model = modelOverride ?? getModel("xai", modelId);
		await streamOpenAIResponses(model, requestContext, options).result();
	} finally {
		globalThis.fetch = originalFetch;
	}

	if (!capturedUrl || !capturedInit) throw new Error("Request was not captured");
	return {
		url: capturedUrl,
		headers: new Headers(capturedInit.headers),
		body: JSON.parse(String(capturedInit.body)) as Record<string, unknown>,
	};
}

describe.each(["grok-4.5", "grok-4.6"] as const)("xAI Responses lane (%s)", (modelId) => {
	it("materializes assistant text from a completed-only Responses body", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => completedResponsesSse()) as typeof fetch;
		try {
			const result = await streamOpenAIResponses(getModel("xai", modelId), context, {
				apiKey: "test-key-123",
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "hello from xai" })]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("authenticates with a Bearer token derived from the API key", async () => {
		const { url, headers } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(url).toBe("https://api.x.ai/v1/responses");
		expect(headers.get("authorization")).toBe("Bearer test-key-123");
	});

	it("does not send Grok CLI proxy headers to the public API", async () => {
		const { headers } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(headers.get("x-xai-token-auth")).toBeNull();
		expect(headers.get("x-grok-client-version")).toBeNull();
		expect(headers.get("x-grok-client-identifier")).toBeNull();
		expect(headers.get("x-grok-client-mode")).toBeNull();
		expect(headers.get("x-grok-model-override")).toBeNull();
	});

	it("sends store:false and omits prompt_cache_retention/prompt_cache_key by default", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(body.store).toBe(false);
		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("sets reasoning.effort when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.reasoning).toMatchObject({ effort: "high" });
	});

	// WP-7 regression: thinkingLevelMap.off is null, so the "no explicit effort" branch that
	// would otherwise set params.reasoning is skipped entirely for xAI. Before the fix, that
	// also meant include:["reasoning.encrypted_content"] was never sent, silently dropping
	// encrypted reasoning across turns. It must be present regardless of the reasoning field.
	it("sets include:[reasoning.encrypted_content] even with no explicit reasoning effort", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(body.reasoning).toBeUndefined();
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});

	it("still sets include:[reasoning.encrypted_content] when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});
});

describe("xAI Responses lane (grok-4.6 xhigh)", () => {
	it("sends reasoning.effort xhigh", async () => {
		const { body } = await captureResponsesRequest("grok-4.6", { apiKey: "test-key-123", reasoningEffort: "xhigh" });
		expect(body.reasoning).toMatchObject({ effort: "xhigh" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});
});

describe("xAI Grok CLI subscription schema", () => {
	it("routes OAuth subscription models through the Grok CLI proxy without changing API-key models", () => {
		const apiModel = getModel("xai", "grok-4.6");
		const modified = xaiOAuthProvider.modifyModels?.([apiModel], {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
		});

		expect(apiModel.baseUrl).toBe("https://api.x.ai/v1");
		expect(modified).toHaveLength(1);
		expect(modified?.[0]).toMatchObject({
			provider: "xai",
			baseUrl: "https://cli-chat-proxy.grok.com/v1",
			headers: {
				"X-XAI-Token-Auth": "xai-grok-cli",
				"x-grok-client-version": "1.0.3",
				"x-grok-client-identifier": "grok-shell",
				"x-grok-client-mode": "headless",
				"x-grok-model-override": "grok-4.6",
			},
			compat: { requestFormat: "xai-cli", supportsLongCacheRetention: false },
		});
	});

	it("matches the installed Grok CLI request and replay schema", async () => {
		const reasoningItem = {
			type: "reasoning" as const,
			id: "rs_capture",
			status: "completed" as const,
			summary: [{ type: "summary_text" as const, text: "Run one harmless command." }],
			encrypted_content: "encrypted-capture",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Run one harmless command.",
					thinkingSignature: JSON.stringify(reasoningItem),
				},
				{
					type: "text",
					text: "I will check.",
					textSignature: JSON.stringify({ v: 1, id: "msg_capture_tool" }),
				},
				{
					type: "toolCall",
					id: "call_capture|fc_capture",
					name: "run_terminal_command",
					arguments: { command: "pwd", description: "Confirm the workspace path." },
				},
			],
			api: "openai-responses",
			provider: "xai",
			model: "grok-4.6",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_capture|fc_capture",
			toolName: "run_terminal_command",
			content: [{ type: "text", text: "exit: 0\n/workspace\n" }],
			isError: false,
			timestamp: 3,
		};
		const requestContext: Context = {
			systemPrompt: "Follow the system instructions.",
			messages: [{ role: "user", content: "Run it.", timestamp: 1 }, assistant, toolResult],
			tools: [
				{
					name: "run_terminal_command",
					description: "Run a command.",
					parameters: Type.Object({
						command: Type.String(),
						description: Type.String(),
					}),
				},
			],
		};
		const subscriptionModel = xaiOAuthProvider.modifyModels?.([getModel("xai", "grok-4.6")], {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
		})?.[0] as Model<"openai-responses"> | undefined;
		if (!subscriptionModel) throw new Error("xAI OAuth model was not projected");

		const { url, headers, body } = await captureResponsesRequest(
			"grok-4.6",
			{ apiKey: "oauth-access", reasoningEffort: "high", sessionId: "session-capture" },
			requestContext,
			subscriptionModel,
		);

		expect(url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
		expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers.get("x-grok-client-version")).toBe("1.0.3");
		expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
		expect(headers.get("x-grok-client-mode")).toBe("headless");
		expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
		expect(body).toMatchObject({
			model: "grok-4.6",
			prompt_cache_key: "session-capture",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "high", summary: "concise" },
		});
		expect(body.instructions).toBeUndefined();
		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.input).toEqual([
			{ type: "message", role: "system", content: "Follow the system instructions." },
			{ type: "message", role: "user", content: "Run it." },
			{
				type: "reasoning",
				id: "rs_capture",
				summary: [{ type: "summary_text", text: "Run one harmless command." }],
				encrypted_content: "encrypted-capture",
			},
			{ type: "message", role: "assistant", content: "I will check." },
			{
				type: "function_call",
				call_id: "call_capture",
				name: "run_terminal_command",
				arguments: JSON.stringify({ command: "pwd", description: "Confirm the workspace path." }),
			},
			{ type: "function_call_output", call_id: "call_capture", output: "exit: 0\n/workspace\n" },
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "run_terminal_command",
				description: "Run a command.",
				parameters: {
					type: "object",
					properties: { command: { type: "string" }, description: { type: "string" } },
					required: ["command", "description"],
				},
			},
		]);
		expect((body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("strict");
	});
});

describe("xAI built-in catalog", () => {
	it("keeps only grok-4.5 and grok-4.6", () => {
		expect(
			getModels("xai")
				.map((model) => model.id)
				.sort(),
		).toEqual(["grok-4.5", "grok-4.6"]);
	});

	it("excludes retired and redundant models", () => {
		const ids = getModels("xai").map((model) => model.id);
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-code-fast-1",
			"grok-4.3",
			"grok-build-0.1",
		]) {
			expect(ids).not.toContain(modelId);
		}
	});
});
