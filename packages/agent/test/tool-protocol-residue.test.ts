import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage & { stopReason: "length" | "stop" | "toolUse" }) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => this.push({ type: "done", reason: message.stopReason, message }));
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

function response(text: string): AssistantMessage & { stopReason: "stop" } {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const shellTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({ cmd: Type.String() }),
	execute: async () => {
		throw new Error("Rendered tool residue must never execute");
	},
};

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((message) =>
		Boolean(message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
	) as Message[];

async function run(text: string): Promise<AgentEvent[]> {
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [shellTool] };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		[{ role: "user", content: "go", timestamp: 1 }],
		context,
		config,
		undefined,
		() => new MockAssistantStream(response(text)),
	)) {
		events.push(event);
	}
	return events;
}

describe("native tool protocol residue", () => {
	it("turns escaped provider tool markup into an error without executing it", async () => {
		const events = await run('Implementing now.\nto=functions.bash code\n{"cmd":"touch must-not-exist"}');
		const final = events.findLast(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		)?.message;

		expect(final).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "native_tool_protocol_residue: functions.bash was rendered as text",
		});
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
	});

	it.each([
		"The phrase to=functions.bash code is documentation, not a call.",
		'Example:\n```text\nto=functions.bash code\n{"cmd":"pwd"}\n```',
		'to=functions.unknown code\n{"cmd":"pwd"}',
		// Quoting the marker syntax while explaining it (very reachable in this repo, whose own
		// docs/tests discuss this exact syntax) must not be mistaken for an escaped tool call: the
		// message keeps talking after the payload instead of stopping there.
		'The residue detector\'s fixture looks like this:\n\nto=functions.bash code\n{"cmd":"pwd"}\n\nThat input must produce a native_tool_protocol_residue error without executing the tool.',
		// A brace-prefixed line that is not actually parseable JSON must not be treated as a payload.
		'Working.\nto=functions.bash code\n{cmd: "pwd", trailing garbage}',
	])("leaves prose, fenced examples, unknown tool markers, and non-JSON payloads untouched", async (text) => {
		const events = await run(text);
		const final = events.findLast(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		)?.message;
		expect(final).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("still catches genuine residue after malformed, never-closed fencing", async () => {
		const events = await run('```\nan unterminated snippet\nto=functions.bash code\n{"cmd":"pwd"}');
		const final = events.findLast(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		)?.message;

		expect(final).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "native_tool_protocol_residue: functions.bash was rendered as text",
		});
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
	});
});
