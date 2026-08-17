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
	it("budgets every field of the materialized context without constructing a JSON copy", () => {
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

		expect(measureJsonLength(payload)).toBe(JSON.stringify(payload).length);
		expect(estimateProviderRequestTokens(context)).toBe(Math.ceil(JSON.stringify(payload).length / 4));
		expect(estimateProviderRequestTokens({ ...context, messages: context.messages.slice(0, 1) })).toBeLessThan(
			estimateProviderRequestTokens(context),
		);
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
});
