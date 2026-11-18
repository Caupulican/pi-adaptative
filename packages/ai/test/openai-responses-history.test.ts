import { expect, it } from "vitest";
import { observeHistoryWork, registerProviderMessagePrefix, responsesInputPrefix } from "../src/history-work.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { Message, Model } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://unused.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const providers = new Set(["openai"]);

function owned(messages: Message[], previous?: Message[], count = previous?.length ?? 0): Message[] {
	Object.freeze(messages);
	registerProviderMessagePrefix(messages, previous, count);
	return messages;
}

function render(messages: Message[], reuseAcceptedPrefix = true) {
	return convertResponsesMessages(model, { messages }, providers, { reuseAcceptedPrefix });
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const result = (text: string): Message => ({
	role: "toolResult",
	toolName: "lookup",
	toolCallId: "call_1",
	isError: false,
	content: [{ type: "text", text }],
	timestamp: 3,
});

it("retains a Responses predecessor through speculative conversion and a failed retry with provisional tool output", () => {
	let armed = false;
	const untouched = new Proxy(user("old"), {
		get(target, property, receiver) {
			if (armed) throw new Error("Read an already accepted row");
			return Reflect.get(target, property, receiver);
		},
	});
	const root = owned([
		untouched,
		{
			role: "assistant",
			provider: model.provider,
			model: model.id,
			api: model.api,
			stopReason: "toolUse",
			usage: createEmptyUsage(),
			timestamp: 2,
			content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
		},
	]);
	const first = render(root);
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first.at(-1))).toBe(true);
	expect(first.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
	const rejected = owned([...root, result("speculative")], root);
	const broken = owned(
		[
			...root,
			new Proxy(result("failed"), {
				get() {
					throw new Error("Tail conversion failed");
				},
			}),
		],
		root,
	);
	const retry = owned([...root, result("actual")], root);
	const work = observeHistoryWork(retry);
	armed = true;
	expect(render(rejected).at(-1)).toMatchObject({ output: "speculative" });
	expect(() => render(broken)).toThrow("Tail conversion failed");
	const final = render(retry);
	armed = false;

	expect(final[0]).toBe(first[0]);
	expect(final.at(-1)).toMatchObject({ output: "actual" });
	expect(responsesInputPrefix(final)).toMatchObject({ count: first.length - 1 });
	expect(responsesInputPrefix(final)?.previous).toBe(first);
	expect(work.wireRowsConverted).toBe(1);
	expect(work.oldRowsRead).toBe(0);
	expect(final).toEqual(render(retry, false));
	expect(Object.isFrozen(render(retry, false))).toBe(false);
});

it("clamps predecessor evidence when a speculative fork rewinds older rows", () => {
	const base = owned([user("prefix"), user("second")]);
	const original = render(base);
	render(owned([base[0]!, user("replacement")], base, 1));
	const requested = owned([...base, user("tail")], base);
	const work = observeHistoryWork(requested);
	const restored = render(requested);

	expect(responsesInputPrefix(restored)?.previous).toBe(original);
	expect(responsesInputPrefix(restored)?.count).toBe(1);
	expect(restored[0]).toBe(original[0]);
	expect(restored).toEqual(render(requested, false));
	expect(work.oldRowsRead).toBe(1);
});
