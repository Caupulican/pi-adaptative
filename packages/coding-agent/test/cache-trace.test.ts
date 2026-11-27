import { fileURLToPath } from "node:url";
import type { Message, Model } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { markToolFreeCacheRequest, PromptPrefixMonitor } from "../src/core/cache-trace.ts";
import { immutableHistoryMessage } from "../src/kernel/message-revision.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://unused.invalid",
	id: "fixture",
	name: "Fixture",
	input: ["text"],
	reasoning: false,
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const request = { sessionId: "fixture", conversationId: undefined, lineage: undefined };
const block = (body: string) => ({ type: "text" as const, text: `<chat>\n${body}\n</chat>`, icmCache: {} });
const message = (content: ReturnType<typeof block>): Message => ({ role: "user", timestamp: 1, content: [content] });

afterEach(() => vi.unstubAllEnvs());

it("continues checking the request prefix when the trace destination is unusable", () => {
	vi.stubEnv("PI_CACHE_TRACE", fileURLToPath(new URL("./cache-trace.test.ts/trace.jsonl", import.meta.url)));
	const monitor = new PromptPrefixMonitor();
	expect(monitor.check(model, { systemPrompt: "before", messages: [] }, request)).toBeUndefined();
	expect(monitor.check(model, { systemPrompt: "after", messages: [] }, request)).toContain("system prompt changed");
});

it("continues detecting changed views and prompts after immutable view reuse", () => {
	vi.stubEnv("PI_CACHE_TRACE", undefined);
	const monitor = new PromptPrefixMonitor();
	const before = immutableHistoryMessage(message(block("previous context retained for the conversation"))) as Message;
	const after = immutableHistoryMessage(message(block("changed context retained for the conversation"))) as Message;
	const context = { systemPrompt: "rules", messages: [before] };
	expect(monitor.check(model, context, request)).toBeUndefined();
	expect(monitor.check(model, { ...context, messages: [before] }, request)).toBeUndefined();
	expect(monitor.check(model, { ...context, messages: [after] }, request)).toContain("chat view changed");
	expect(monitor.check(model, { systemPrompt: "edited rules", messages: [after] }, request)).toContain(
		"system prompt changed",
	);
});

it("rechecks a mutable view even if the message identity stays the same", () => {
	vi.stubEnv("PI_CACHE_TRACE", undefined);
	const monitor = new PromptPrefixMonitor();
	const text = block("previous context retained for the conversation");
	const context = { messages: [message(text)] };
	expect(monitor.check(model, context, request)).toBeUndefined();
	text.text = block("changed context retained for the conversation").text;
	expect(monitor.check(model, context, request)).toContain("chat view changed");
});

it("keeps the ordinary tool comparison across an authorized tool-free response", () => {
	const monitor = new PromptPrefixMonitor();
	const read = { name: "read", description: "Read a file", parameters: Type.Object({}) };
	const ordinary = { messages: [], tools: [read] };
	const report = { messages: [], tools: [] };
	markToolFreeCacheRequest(report);
	expect(monitor.check(model, ordinary, request)).toBeUndefined();
	expect(monitor.check(model, report, request)).toBeUndefined();
	expect(monitor.check(model, ordinary, request)).toBeUndefined();
	expect(monitor.check(model, report, request)).toBeUndefined();
	expect(monitor.check(model, { messages: [], tools: [{ ...read, name: "write" }] }, request)).toContain(
		"tool set changed (+write, -read)",
	);
	expect(monitor.check(model, { messages: [], tools: [] }, request)).toContain("tool set changed (-write)");
});
