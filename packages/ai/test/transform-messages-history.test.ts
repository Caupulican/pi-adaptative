import { expect, it } from "vitest";
import { observeHistoryWork, registerProviderMessagePrefix } from "../src/history-work.ts";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"mistral-conversations"> = {
	api: "mistral-conversations",
	provider: "mistral",
	name: "Fixture",
	id: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const call = (id: string): AssistantMessage => ({
	role: "assistant",
	api: "openai-responses",
	provider: "openai",
	model: "source",
	stopReason: "toolUse",
	content: [{ type: "toolCall", id, name: "read", arguments: {} }],
	usage: createEmptyUsage(),
	timestamp: 1,
});
const result = (id: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	isError: false,
	timestamp: 2,
	content: [{ type: "text", text: id }],
});

it("reuses accepted normalization and its allocator across appends while repairing provisional output", () => {
	const normalizer = {
		create() {
			const names = new Map<string, string>();
			return (id: string) => {
				const existing = names.get(id);
				if (existing) return existing;
				const wire = `wire-${names.size + 1}`;
				names.set(id, wire);
				return wire;
			};
		},
	};
	const prior: Message[] = [call("first")];
	const next = [...prior, result("first"), call("second"), result("second")];
	Object.freeze(prior);
	Object.freeze(next);
	registerProviderMessagePrefix(prior, undefined, 0);
	registerProviderMessagePrefix(next, prior, prior.length);
	const before = transformMessages(prior, model, normalizer);
	const work = observeHistoryWork(next);
	const resumed = transformMessages(next, model, normalizer);

	expect(before[1]).toMatchObject({ toolCallId: "wire-1", isError: true });
	expect(resumed[0]).toBe(before[0]);
	expect(resumed[1]).toMatchObject({ toolCallId: "wire-1", isError: false });
	expect(resumed[3]).toMatchObject({ toolCallId: "wire-2", isError: false });
	expect(resumed).toEqual(transformMessages([...next], model, normalizer));
	expect(transformMessages(next, model, normalizer)).toEqual(resumed);
	expect(work.transformedRows).toBe(3);

	const edited = [call("edited"), result("edited")];
	registerProviderMessagePrefix(edited, next, 0);
	expect(transformMessages(edited, model, normalizer)).toEqual(transformMessages([...edited], model, normalizer));
});
