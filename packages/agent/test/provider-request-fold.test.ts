import type { Context, Message } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { estimateProviderRequestTokens } from "../src/provider-request-estimator.ts";
import { hasInlineImages } from "../src/provider-request-image-budget.ts";

function text(role: "user" | "assistant", body: string): Message {
	return role === "user"
		? ({ role, content: body, timestamp: 1 } as Message)
		: ({
				role,
				content: [{ type: "text", text: body }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			} as Message);
}

const image: Message = {
	role: "user",
	content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
	timestamp: 2,
} as Message;

describe("prefix-folded request scans", () => {
	it("sums appended messages onto the remembered prefix and matches a fresh measurement", () => {
		const messages: Message[] = [text("user", "one"), text("assistant", "two")];
		const context: Context = { systemPrompt: "sys", messages, tools: [] };
		const first = estimateProviderRequestTokens(context);
		messages.push(text("user", "three"), text("assistant", "four"));
		const resumed = estimateProviderRequestTokens(context);
		// The same bytes measured from scratch: distinct objects start a distinct lineage.
		const fresh = estimateProviderRequestTokens({ ...context, messages: structuredClone(messages) });
		expect(resumed).toBe(fresh);
		expect(resumed).toBeGreaterThan(first);
	});

	it("answers the inline-image scan from the prefix and flips when an image is appended", () => {
		const messages: Message[] = [text("user", "one")];
		expect(hasInlineImages(messages)).toBe(false);
		messages.push(text("assistant", "two"));
		expect(hasInlineImages(messages)).toBe(false);
		messages.push(image);
		expect(hasInlineImages(messages)).toBe(true);
		expect(hasInlineImages(messages.slice(0, 2))).toBe(false);
	});
});
