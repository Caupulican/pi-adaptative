import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import {
	type StreamIdleOptions,
	StreamStallError,
	withStreamIdleWatchdog,
} from "../src/kernel/reliability/watchdogs.ts";

const model: Model<"openai-responses"> = {
	id: "watchdog-fixture",
	name: "Watchdog fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

async function watchedProvider(options: Partial<StreamIdleOptions> = {}) {
	vi.useFakeTimers();
	const provider = createAssistantMessageEventStream();
	const onStall = vi.fn();
	const onAbort = vi.fn();
	const watched = withStreamIdleWatchdog(
		(_model, _context, request) => {
			const signal = request?.signal;
			signal?.addEventListener(
				"abort",
				() => {
					onAbort(signal.reason);
					provider.end();
				},
				{ once: true },
			);
			return provider;
		},
		{ connectMs: 1000, firstProgressMs: 1000, activeIdleMs: 100, quietIdleMs: 200, onStall, ...options },
	);
	const stream = await watched(model, { messages: [] });
	return { provider, stream, onStall, onAbort };
}

afterEach(() => vi.useRealTimers());

it.each([
	{ type: "text_delta", phase: "active", elapsedMs: 100, block: { type: "text", text: "Draft" } },
	{ type: "thinking_delta", phase: "quiet", elapsedMs: 200, block: { type: "thinking", thinking: "Draft" } },
] as const)(
	"keeps the $phase deadline while structural and empty events arrive",
	async ({ type, phase, elapsedMs, block }) => {
		const { provider, stream, onStall } = await watchedProvider();
		const partial = message([block]);
		provider.push({ type, contentIndex: 0, delta: "Draft", partial });
		await vi.advanceTimersByTimeAsync(elapsedMs - 20);
		const structural = message([block, { type: "thinking", thinking: "" }]);
		provider.push({ type: "thinking_start", contentIndex: 1, partial: structural });
		provider.push({ type: "thinking_delta", contentIndex: 1, delta: "", partial: structural });
		await vi.advanceTimersByTimeAsync(19);
		expect(onStall).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onStall).toHaveBeenCalledExactlyOnceWith({ phase, elapsedMs });
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining(phase),
		});
	},
);

it("extends the active deadline when another non-empty delta arrives", async () => {
	const { provider, stream, onStall } = await watchedProvider();
	provider.push({
		type: "text_delta",
		contentIndex: 0,
		delta: "Draft",
		partial: message([{ type: "text", text: "Draft" }]),
	});
	await vi.advanceTimersByTimeAsync(90);
	const final = message([{ type: "text", text: "Draft ready" }]);
	provider.push({ type: "text_delta", contentIndex: 0, delta: " ready", partial: final });
	await vi.advanceTimersByTimeAsync(20);
	expect(onStall).not.toHaveBeenCalled();
	provider.push({ type: "done", reason: "stop", message: final });
	expect(await stream.result()).toBe(final);
	await vi.advanceTimersByTimeAsync(1000);
	expect(onStall).not.toHaveBeenCalled();
});

it("counts completion-only tool output once", async () => {
	const { provider, stream, onStall } = await watchedProvider();
	const toolCall = { type: "toolCall" as const, id: "call_1", name: "read_status", arguments: {} };
	const event = { type: "toolcall_end" as const, contentIndex: 0, toolCall, partial: message([toolCall]) };
	provider.push(event);
	await vi.advanceTimersByTimeAsync(90);
	provider.push(event);
	await vi.advanceTimersByTimeAsync(10);
	expect(onStall).toHaveBeenCalledExactlyOnceWith({ phase: "active", elapsedMs: 100 });
	expect(await stream.result()).toMatchObject({ stopReason: "error" });
});

it("settles and aborts the request even if its stall observer throws", async () => {
	const onStall = vi.fn(() => {
		throw new Error("stall observer failed");
	});
	const { stream, onAbort } = await watchedProvider({ onStall });
	await vi.advanceTimersByTimeAsync(1000);
	expect(onStall).toHaveBeenCalledExactlyOnceWith({ phase: "connect", elapsedMs: 1000 });
	expect(onAbort).toHaveBeenCalledExactlyOnceWith(expect.any(StreamStallError));
	expect(await stream.result()).toMatchObject({
		stopReason: "error",
		errorMessage: "stream stalled: no events for 1000ms (connect phase)",
	});
});

it.each(["done", "error"] as const)("forwards the provider's %s event with a repeated final snapshot", async (type) => {
	const { provider, stream, onStall } = await watchedProvider({
		outputRepetitionRepeats: 3,
		outputRepetitionWindowChars: 4,
	});
	const repeated = message([{ type: "text", text: "abcdabcdabcd" }]);
	const final: AssistantMessage =
		type === "done" ? repeated : { ...repeated, stopReason: "error", errorMessage: "provider failure" };
	const terminal: AssistantMessageEvent =
		type === "done" ? { type, reason: "stop", message: final } : { type, reason: "error", error: final };
	provider.push(terminal);
	expect(await stream.result()).toBe(final);
	expect(await stream[Symbol.asyncIterator]().next()).toEqual({ done: false, value: terminal });
	await vi.advanceTimersByTimeAsync(1000);
	expect(onStall).not.toHaveBeenCalled();
});
