import type { Context } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { estimateProviderRequestTokens, measureJsonLength } from "../src/provider-request-estimator.ts";

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
});
