import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider } from "../src/index.ts";
import { convertMessages } from "../src/providers/openai-completions.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	Tool,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: false,
};

// The stand-in for a real no-native-tools local model served behind an OpenAI-compatible
// endpoint (Ollama/llama.cpp) - the actual population this repro is about (curated Bonsai
// family). `convertMessages` is the exact choke point a real request through
// this provider would use to serialize the harness's universal Context onto the wire.
function buildPhoneModel(): Model<"openai-completions"> {
	return {
		id: "phone-model",
		name: "Phone Model",
		api: "openai-completions",
		provider: "local-phone",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function readTool(): Tool {
	return {
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		} as Tool["parameters"],
	};
}

describe("text tool-call protocol round-trip", () => {
	const registrations: Array<{ unregister(): void }> = [];

	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
	});

	it("renders a text-protocol model's own prior call and result as plain text on turn 2, not native tool_calls/tool-role", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const tools = [readTool()];
		const firstUser = { role: "user" as const, content: "read a.txt", timestamp: 1 };

		let turn2Request: Context | undefined;
		// A model configured to IGNORE native tools/tool_calls and only read text turns: it
		// never receives `context.tools` (stream.ts strips it for text-protocol) and its only
		// instructions come from the systemPrompt primer + message text - exactly the phone
		// model population this fix targets.
		registration.setResponses([
			() => fauxAssistantMessage('<pi:call name="read">{"path":"a.txt"}</pi:call>'),
			(context) => {
				turn2Request = context;
				return fauxAssistantMessage("done");
			},
		]);

		const turn1 = await complete(
			registration.getModel(),
			{ systemPrompt: "base", messages: [firstUser], tools },
			{ textToolCallProtocol: true },
		);
		expect(turn1.content).toMatchObject([
			{ type: "toolCall", name: "read", arguments: { path: "a.txt" }, source: "text-protocol" },
		]);
		const toolCallId = (turn1.content[0] as { id: string }).id;

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "hello from a.txt" }],
			isError: false,
			timestamp: 2,
		};

		await complete(
			registration.getModel(),
			{ systemPrompt: "base", messages: [firstUser, turn1, toolResult], tools },
			{ textToolCallProtocol: true },
		);

		// The harness-level Context handed to the provider layer still carries NATIVE ToolCall /
		// ToolResultMessage blocks - withTextToolProtocolContext (stream.ts) only strips `tools`,
		// it never rewrites `messages` (it only prepends one synthetic steer message, index 0,
		// ahead of the real history). This is the shape any provider.stream() implementation
		// (faux or real) receives; the break only becomes visible once a provider serializes it.
		expect(turn2Request?.messages[2]).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", name: "read", source: "text-protocol" }],
		});
		expect(turn2Request?.messages[3]).toMatchObject({ role: "toolResult", toolCallId, toolName: "read" });

		// The SAME single choke point a real openai-completions request would use to serialize
		// that Context onto the wire (buildParams -> convertMessages).
		const wireMessages = convertMessages(buildPhoneModel(), turn2Request!, compat);
		const assistantWireMessage = wireMessages.find((message) => message.role === "assistant") as
			| { role: "assistant"; content?: unknown; tool_calls?: unknown }
			| undefined;
		const toolWireMessage = wireMessages.find((message) => message.role === "tool");

		// ASSERT THE FIX: a text-protocol call+result never reaches the wire as native
		// tool_calls[]/role:"tool" - content the phone model was configured to ignore. Both
		// render as plain text matching the primer's envelope grammar instead.
		expect(toolWireMessage).toBeUndefined();
		expect(assistantWireMessage?.tool_calls).toBeUndefined();
		expect(assistantWireMessage?.content).toContain('<pi:call name="read">{"path":"a.txt"}</pi:call>');

		const trailingUserText = wireMessages
			.filter((message) => message.role === "user")
			.map((message) => (typeof message.content === "string" ? message.content : ""))
			.join("\n");
		expect(trailingUserText).toContain("Tool result (read):");
		expect(trailingUserText).toContain("hello from a.txt");
	});

	it("leaves native (non-text-protocol) serialization byte-unchanged (the cloud hot path must not move)", () => {
		const now = 1000;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-native",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: now + 1,
		};
		const context: Context = {
			messages: [{ role: "user", content: "read README.md", timestamp: now - 1 }, assistantMessage, toolResult],
			tools: [readTool()],
		};

		// No `options` (no textToolCallProtocol) and no `source: "text-protocol"` tag anywhere -
		// this must serialize exactly as it always has: native tool_calls[] + role:"tool".
		const messages = convertMessages(buildPhoneModel(), context, compat);

		expect(messages).toEqual([
			{ role: "user", content: "read README.md" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
				],
			},
			{ role: "tool", content: "file body", tool_call_id: "call_1" },
		]);
	});
});
