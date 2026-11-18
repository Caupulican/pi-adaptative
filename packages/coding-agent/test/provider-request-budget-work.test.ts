import type { Api, Context, ImageContent, Model, ToolResultMessage, UserMessage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { advanceMessageContentRevision } from "../src/kernel/message-revision.ts";
import { estimateProviderRequestTokens } from "../src/kernel/provider-request-estimator.ts";
import {
	applyProviderRequestImageBudget,
	TOOL_IMAGE_BUDGET_NOTE,
	USER_IMAGE_BUDGET_PLACEHOLDER,
} from "../src/kernel/provider-request-image-budget.ts";

const visionModel: Model<Api> = {
	id: "vision",
	name: "Vision fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it("recomputes admission for an in-place edit even when the wire array and message retain their identity", () => {
	const message: UserMessage = { role: "user", content: "short", timestamp: 0 };
	const context = { messages: [message] };
	const before = estimateProviderRequestTokens(context);
	message.content = "longer".repeat(200);
	advanceMessageContentRevision(message);
	const after = estimateProviderRequestTokens(context);
	expect(after).toBeGreaterThan(before);
	expect(after).toBe(estimateProviderRequestTokens({ messages: [{ ...message }] }));
});

it.each([true, false])("evicts in block order with an existing tool note = %s", (existingNote) => {
	const image: ImageContent = { type: "image", data: "A".repeat(2048), mimeType: "image/png" };
	const text = { type: "text" as const, text: "unchanged" };
	const note = { type: "text" as const, text: TOOL_IMAGE_BUDGET_NOTE };
	const user: UserMessage = { role: "user", content: [image, text], timestamp: 1 };
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		timestamp: 2,
		isError: false,
		content: [image, ...(existingNote ? [note] : []), text, image, image],
	};
	const untouched: UserMessage = { role: "user", content: [text, image], timestamp: 3 };
	const context: Context = { messages: [user, tool, untouched] };
	const expected = {
		messages: [
			{ ...user, content: [{ type: "text", text: USER_IMAGE_BUDGET_PLACEHOLDER }, text] },
			{ ...tool, content: existingNote ? [note, text, image] : [text, image, note] },
			untouched,
		],
	};
	const bytes = Buffer.byteLength(JSON.stringify(context));
	const target = Buffer.byteLength(JSON.stringify(expected));
	const result = applyProviderRequestImageBudget(context, visionModel, {
		triggerBytes: bytes,
		hardLimitBytes: bytes + 1,
		reclaimTargetBytes: target,
	});
	expect(result.context).toEqual(expected);
	expect(result.context.messages[2]).toBe(untouched);
	expect(result.outcome).toMatchObject({ evicted: 3, inlineImages: 5, bodyBytes: bytes, bodyBytesAfter: target });
	expect(tool.content.filter((block) => block.type === "image")).toHaveLength(3);
});
