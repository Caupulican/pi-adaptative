import type { AssistantMessage, Message, Model, ToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../../ai/src/providers/google-shared.ts";
import { createToolFailureContextMemory, sanitizeToolFailureContext } from "../src/tool-failure-memory.ts";

const model: Model<"google-antigravity"> = {
	id: "gemini-3.1-pro-low",
	name: "Gemini Pro",
	api: "google-antigravity",
	provider: "google-antigravity",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
};
const signature = "c2lnbmVkLXBhc3M=";

function readBatch(signed: boolean, identicalArguments = false): Message[] {
	const calls: ToolCall[] = Array.from({ length: 6 }, (_, index) => ({
		type: "toolCall",
		id: `read-${index}`,
		name: "read",
		arguments: { path: "src/owner.ts", offset: identicalArguments ? 1 : index * 100 + 1 },
		...(signed && index === 0 ? { thoughtSignature: signature } : {}),
	}));
	const assistant: AssistantMessage = {
		role: "assistant",
		content: calls,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return [
		assistant,
		...calls.map((call) => ({
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text: "The same source text returned by each parallel read.\n".repeat(4) }],
			isError: false,
			timestamp: 2,
		})),
	];
}

describe("signature-bound tool batches", () => {
	it.each([false, true])("preserves signed parallel calls with identical %s arguments", (identicalArguments) => {
		const history = readBatch(true, identicalArguments);
		const sanitized = sanitizeToolFailureContext(history, "system");
		const replay = convertMessages(model, { messages: sanitized.messages as Message[] });
		const calls = replay.find((turn) => turn.role === "model")?.parts?.filter((part) => part.functionCall);

		expect(calls).toHaveLength(6);
		expect(calls?.[0].thoughtSignature).toBe(signature);
		expect(calls?.slice(1).every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(replay.at(-1)?.parts).toHaveLength(6);
		expect(sanitized.messages).toEqual(history);
	});

	it("keeps signatures through incremental folds and a later superseding success", () => {
		const history = readBatch(true);
		const memory = createToolFailureContextMemory();
		for (let length = 2; length <= history.length; length++) {
			const sanitized = sanitizeToolFailureContext(history.slice(0, length), "system", 0, memory);
			expect(sanitized.messages[0]).toBe(history[0]);
		}
		const next = readBatch(false);
		const assistant = next[0] as AssistantMessage;
		const lastCall = assistant.content.at(-1) as ToolCall;
		const later: Message[] = [
			history[0],
			...history.slice(1),
			{ ...assistant, content: [{ ...lastCall, id: "later" }] },
			{
				...next.at(-1)!,
				role: "toolResult",
				toolCallId: "later",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "Different result" }],
				timestamp: 3,
			},
		];
		expect(sanitizeToolFailureContext(later, "system", 0, memory).messages.slice(0, history.length)).toEqual(history);
	});

	it("continues deduplicating unsigned unsent successes", () => {
		const history = readBatch(false);
		const sanitized = sanitizeToolFailureContext(history, "system");
		const replay = convertMessages(model, { messages: sanitized.messages as Message[] });
		expect(replay.find((turn) => turn.role === "model")?.parts).toHaveLength(1);
		expect(replay.at(-1)?.parts).toHaveLength(1);
		expect(history[0]).toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ id: "read-0" })]),
		});
	});
});
