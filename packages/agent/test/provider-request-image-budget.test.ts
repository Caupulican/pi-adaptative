import type { Api, Context, ImageContent, Model } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { measureJsonUtf8Bytes } from "../src/provider-request-estimator.ts";
import {
	applyProviderRequestImageBudget,
	BEDROCK_PROVIDER_REQUEST_IMAGE_BUDGET,
	GENERIC_PROVIDER_REQUEST_IMAGE_BUDGET,
	resolveProviderRequestImageBudget,
	TOOL_IMAGE_BUDGET_NOTE,
	USER_IMAGE_BUDGET_PLACEHOLDER,
	XAI_PROVIDER_REQUEST_IMAGE_BUDGET,
} from "../src/provider-request-image-budget.ts";

function model(
	provider: string,
	api: "openai-responses" | "bedrock-converse-stream" = "openai-responses",
	input: ("text" | "image")[] = ["text", "image"],
): Model<Api> {
	return {
		id: `${provider}-budget-test`,
		name: `${provider}-budget-test`,
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4_096,
	};
}

function image(marker: string): ImageContent {
	return { type: "image", mimeType: "image/png", data: marker.repeat(1_200) };
}

describe("provider request image budget", () => {
	it("selects xAI, Bedrock, and provider-neutral body ceilings independently", () => {
		expect(resolveProviderRequestImageBudget(model("xai"))).toEqual(XAI_PROVIDER_REQUEST_IMAGE_BUDGET);
		expect(resolveProviderRequestImageBudget(model("amazon-bedrock", "bedrock-converse-stream"))).toEqual(
			BEDROCK_PROVIDER_REQUEST_IMAGE_BUDGET,
		);
		expect(resolveProviderRequestImageBudget(model("custom"))).toEqual(GENERIC_PROVIDER_REQUEST_IMAGE_BUDGET);
		expect(XAI_PROVIDER_REQUEST_IMAGE_BUDGET).toMatchObject({
			hardLimitBytes: 50 * 1024 * 1024,
			triggerBytes: 47 * 1024 * 1024,
			reclaimTargetBytes: 25 * 1024 * 1024,
		});
		expect(BEDROCK_PROVIDER_REQUEST_IMAGE_BUDGET).toMatchObject({
			hardLimitBytes: 25_000_000,
			triggerBytes: 22_000_000,
			reclaimTargetBytes: 12_500_000,
		});
	});

	it("evicts oldest user and tool images to a low-water mark without mutating durable context", () => {
		const source: Context = {
			systemPrompt: "system",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "old user" }, image("A")],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "metadata" }, image("B")],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [image("C")], timestamp: 3 },
			],
		};
		const expected: Context = {
			systemPrompt: "system",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "old user" },
						{ type: "text", text: USER_IMAGE_BUDGET_PLACEHOLDER },
					],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{ type: "text", text: "metadata" },
						{ type: "text", text: TOOL_IMAGE_BUDGET_NOTE },
					],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [image("C")], timestamp: 3 },
			],
		};
		const reclaimTargetBytes = measureJsonUtf8Bytes(expected)!;
		const budgeted = applyProviderRequestImageBudget(source, model("xai"), {
			hardLimitBytes: 100_000,
			triggerBytes: reclaimTargetBytes + 1,
			reclaimTargetBytes,
		});

		expect(budgeted.outcome).toEqual({
			bodyBytes: expect.any(Number),
			bodyBytesAfter: reclaimTargetBytes,
			inlineImages: 3,
			needsImageCompaction: true,
			evicted: 2,
			hardLimitBytes: 100_000,
			triggerBytes: reclaimTargetBytes + 1,
			reclaimTargetBytes,
		});
		expect(budgeted.context).toEqual(expected);
		expect(budgeted.outcome?.bodyBytes).toBeGreaterThan(reclaimTargetBytes);
		expect((source.messages[0]!.content as ImageContent[])[1]!.data).toContain("A");
		expect((source.messages[1]!.content as ImageContent[])[1]!.data).toContain("B");
		expect((source.messages[2]!.content as ImageContent[])[0]!.data).toContain("C");
	});

	it("preserves the request identity below the trigger and does not read unsupported image payloads", () => {
		const supported: Context = { messages: [{ role: "user", content: [image("A")], timestamp: 1 }] };
		const first = applyProviderRequestImageBudget(supported, model("xai"), {
			hardLimitBytes: 100_000,
			triggerBytes: 99_999,
			reclaimTargetBytes: 50_000,
		});
		expect(first.context).toBe(supported);
		expect(first.outcome).toMatchObject({ needsImageCompaction: false, evicted: 0 });

		let dataReads = 0;
		const lazy = { type: "image", mimeType: "image/png" } as ImageContent;
		Object.defineProperty(lazy, "data", {
			enumerable: true,
			get: () => {
				dataReads++;
				throw new Error("unsupported image data must stay lazy");
			},
		});
		const unsupported: Context = {
			messages: [{ role: "user", content: [lazy], timestamp: 1 }],
		};
		const projected = applyProviderRequestImageBudget(unsupported, model("xai", "openai-responses", ["text"]));
		expect(dataReads).toBe(0);
		expect(projected.outcome).toBeUndefined();
		expect(JSON.stringify(projected.context)).toContain("model does not support images");
	});
});
