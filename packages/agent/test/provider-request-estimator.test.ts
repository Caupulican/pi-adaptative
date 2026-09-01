import type { Context, ImageContent, Model } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/compaction/compaction.ts";
import {
	ESTIMATED_IMAGE_TOKENS,
	estimateProviderRequestTokens,
	measureJsonLength,
	measureJsonStringUtf8Bytes,
	measureJsonUtf8Bytes,
} from "../src/provider-request-estimator.ts";

function model(input: ("text" | "image")[]): Model<"openai-responses"> {
	return {
		id: "estimator-test",
		name: "estimator-test",
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4_096,
	};
}

describe("provider request estimator", () => {
	it("budgets every provider-visible field without constructing a JSON copy", () => {
		const context: Context = {
			systemPrompt: "system contract",
			messages: [
				{ role: "user", content: [{ type: "text", text: "durable history" }], timestamp: 1 },
				{ role: "user", content: [{ type: "text", text: "ACTIVE SKILL\nmandatory body" }], timestamp: 2 },
			],
			tools: [
				{
					name: "read",
					description: "Read a file.",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		};
		const payload = {
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
		};
		const providerVisiblePayload = {
			systemPrompt: context.systemPrompt,
			messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
			tools: context.tools,
		};

		expect(measureJsonLength(payload)).toBe(JSON.stringify(payload).length);
		expect(estimateProviderRequestTokens(context)).toBe(Math.ceil(JSON.stringify(providerVisiblePayload).length / 4));
		expect(estimateProviderRequestTokens({ ...context, messages: context.messages.slice(0, 1) })).toBeLessThan(
			estimateProviderRequestTokens(context),
		);
	});

	it("assembles the memoized per-message estimate byte-identically to measuring the whole payload", () => {
		// The estimator remembers each message's measurement by identity and assembles the request length
		// from those parts. The assembly must equal measuring the assembled object in every field
		// combination, including the ones where a field is omitted from the JSON entirely.
		const messages: Context["messages"] = [
			{ role: "user", content: "plain string content", timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "array content" }], timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "openai-responses",
				provider: "xai",
				model: "estimator-test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 4,
			},
		];
		const providerVisible = messages.map((message) => {
			switch (message.role) {
				case "user":
					return { role: message.role, content: message.content };
				case "assistant":
					return {
						role: message.role,
						content: message.content,
						api: message.api,
						provider: message.provider,
						model: message.model,
					};
				case "toolResult":
					return {
						role: message.role,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: message.content,
						isError: message.isError,
					};
				default:
					throw new Error(`unexpected role ${(message as { role: string }).role}`);
			}
		});
		const tools: Context["tools"] = [
			{
				name: "read",
				description: "Read a file.",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const cases: Array<Pick<Context, "systemPrompt" | "tools">> = [
			{ systemPrompt: "system contract", tools },
			{ systemPrompt: undefined, tools },
			{ systemPrompt: "system contract", tools: undefined },
			{ systemPrompt: undefined, tools: undefined },
		];
		for (const fields of cases) {
			for (const slice of [messages, messages.slice(0, 1), []]) {
				const context: Context = { ...fields, messages: slice };
				const expected = Math.ceil(
					JSON.stringify({
						systemPrompt: fields.systemPrompt,
						messages: providerVisible.slice(0, slice.length),
						tools: fields.tools,
					}).length / 4,
				);
				// Twice: the second call is served entirely from the memo and must not drift.
				expect(estimateProviderRequestTokens(context)).toBe(expected);
				expect(estimateProviderRequestTokens(context)).toBe(expected);
			}
		}
	});

	it("measures JSON UTF-8 bytes exactly without allocating the serialized payload", () => {
		const payload = {
			asciiEscapes: 'quote " slash \\ newline\n',
			unicode: "café 🚀",
			loneSurrogate: "\ud800",
		};

		expect(measureJsonUtf8Bytes(payload)).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
		expect(measureJsonStringUtf8Bytes(payload.unicode)).toBe(
			Buffer.byteLength(JSON.stringify(payload.unicode), "utf8"),
		);
		expect(measureJsonStringUtf8Bytes("A".repeat(1_000), 32)).toBe(33);
	});

	it("charges production-sized image payloads semantically without materializing lazy base64", () => {
		let dataReads = 0;
		const image = { type: "image", mimeType: "image/png" } as ImageContent;
		Object.defineProperty(image, "data", {
			configurable: true,
			enumerable: true,
			get: () => {
				dataReads++;
				return "A".repeat(3_000_000);
			},
		});
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 1 }],
		};
		const textContext: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "A".repeat(3_000_000) }],
					timestamp: 1,
				},
			],
		};

		expect(estimateProviderRequestTokens(imageContext, model(["text", "image"]))).toBeLessThan(1_300);
		expect(dataReads).toBe(0);
		expect(estimateTokens(imageContext.messages[0]!)).toBe(ESTIMATED_IMAGE_TOKENS + 2);
		expect(estimateProviderRequestTokens(textContext, model(["text", "image"]))).toBeGreaterThan(700_000);
		expect(estimateProviderRequestTokens(imageContext, model(["text"]))).toBeLessThan(100);
		expect(dataReads).toBe(0);
	});

	it("excludes persisted harness bookkeeping that providers never receive", () => {
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
					api: "openai-responses",
					provider: "xai",
					model: "grok-4.6",
					diagnostics: [
						{
							type: "transport-retry",
							timestamp: 2,
							details: { trace: "not-provider-input".repeat(20_000) },
						},
					],
					usage,
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "visible result" }],
					details: { audit: "not-provider-input".repeat(20_000) },
					usage,
					isError: false,
					timestamp: 3,
				},
			],
		};

		expect(estimateProviderRequestTokens(context)).toBeLessThan(500);
		expect(
			estimateProviderRequestTokens({
				messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 1 }],
			}),
		).toBeGreaterThan(20_000);
	});
});
