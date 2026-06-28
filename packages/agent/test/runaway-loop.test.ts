import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * Runaway-loop backstop (cost guard, bug #23): a model wedged repeating the SAME tool call forever
 * makes no progress but keeps spending tokens. The loop must detect the repetition and stop gracefully,
 * while legitimate varied tool use must run to completion untouched.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel() {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses" as const,
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	} satisfies AssistantMessage;
}

const toolSchema = Type.Object({ value: Type.String() });
const echoTool: AgentTool<typeof toolSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo tool",
	parameters: toolSchema,
	async execute(_id, params) {
		return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
	},
};

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

async function drain(stream: ReturnType<typeof agentLoop>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("runaway-loop backstop", () => {
	it("stops a loop that repeats the identical tool call, firing onRunawayStop", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		let toolCalls = 0;
		const stalls: Array<{ signature: string; repeats: number }> = [];

		// Always returns the SAME tool call (same args) and never stops — without the backstop this is
		// an infinite token sink.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				toolCalls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${toolCalls}`, name: "echo", arguments: { value: "stuck" } }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		// Backstop tripped exactly at the limit and ended the run.
		expect(stalls).toHaveLength(1);
		expect(stalls[0].repeats).toBe(4);
		expect(toolCalls).toBe(4); // did not run beyond the limit
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("does not trip on legitimate varied tool use", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: unknown[] = [];
		let turn = 0;

		// Five DISTINCT tool calls, then a normal stop — varied work must complete untouched.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 5) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: `t${turn}`, name: "echo", arguments: { value: `v${turn}` } }],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "done" }], "stop"),
					});
				}
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(0); // varied args never trip the backstop
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("trips when only a volatile arg (timestamp) changes each call (bug #28)", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let n = 0;

		// Same logical call, but with a fresh epoch-ms timestamp baked into the args every turn — a naive
		// exact-match detector would never see a repeat. Normalization must collapse these to one signature.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				n++;
				const ts = 1_700_000_000_000 + n * 1234; // changing 13-digit epoch ms
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${n}`, name: "echo", arguments: { value: `fetch?at=${ts}` } }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(1);
		expect(stalls[0].repeats).toBe(4); // volatile timestamps masked → detected
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("trips on a period-3 oscillation A→B→C→A→… (bug #28)", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let n = 0;
		const cycle = ["A", "B", "C"];

		// A 3-state cycle never repeats back-to-back, so a small 2×L window can't see L repeats of any one
		// state. The L×4 window must still catch it.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const value = cycle[n % 3];
				n++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${n}`, name: "echo", arguments: { value } }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(1); // periodic oscillation is caught, not just back-to-back repeats
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});
});
